/**
 * host/stickers/store.js 测试：临时目录隔离、不联网。
 * 覆盖正常路径（增删改查/挑选/统计）与错误边界（重复内容、损坏索引、非法输入）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { makeTempPaths, makeConfigStore, makeLogger } from './helpers.mjs'
import { sleep } from '../host/util/fsx.js'
import { createStickerStore } from '../host/stickers/store.js'

// Minimal buffers whose first bytes carry real image magic values.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03])

function png(seed) {
  return Buffer.concat([PNG, Buffer.from(`seed-${seed}`)])
}

async function withStore(fn, configOverrides = {}) {
  const temp = await makeTempPaths()
  try {
    const configStore = makeConfigStore(configOverrides)
    const logger = makeLogger()
    const store = createStickerStore({ paths: temp.paths, configStore, logger })
    await store.init()
    await fn({ ...temp, configStore, logger, store })
  } finally {
    await temp.cleanup()
  }
}

async function exists(file) {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

test('init 创建空索引和四个图层目录', async () => {
  await withStore(async ({ paths }) => {
    const raw = JSON.parse(await fs.readFile(paths.stickerIndex, 'utf8'))
    assert.deepEqual(raw, { version: 1, items: [] })
    for (const dir of [paths.stickerLibrary, paths.stickerCandidate, paths.stickerNegative, paths.stickerTrash]) {
      assert.ok((await fs.stat(dir)).isDirectory())
    }
  })
})

test('addItem 写入文件与索引；重复内容合并标签和描述', async () => {
  await withStore(async ({ paths, store }) => {
    const first = await store.addItem({
      buffer: PNG,
      ext: 'png',
      tags: ['无语', '敷衍'],
      desc: '测试表情',
      source: { userId: 'u1', url: 'https://example.com/a.png' }
    })
    assert.equal(first.duplicate, false)
    assert.equal(first.item.layer, 'candidate')
    assert.equal(first.item.size, PNG.length)
    assert.equal(first.item.ext, 'png')
    assert.equal(first.item.hash.length, 64)
    assert.equal(first.item.id, first.item.hash.slice(0, 12))
    assert.deepEqual(first.item.tags, ['无语', '敷衍'])
    assert.deepEqual(first.item.source, { userId: 'u1', url: 'https://example.com/a.png' })
    assert.equal(await store.get(first.item.id).then((item) => item.id), first.item.id)

    const file = store.filePath(first.item)
    assert.equal(path.resolve(file), path.resolve(paths.stickerCandidate, `${first.item.id}.png`))
    assert.equal((await fs.stat(file)).size, PNG.length)

    const again = await store.addItem({ buffer: PNG, ext: 'png', tags: ['接梗'], desc: '新描述' })
    assert.equal(again.duplicate, true)
    assert.equal(again.item.id, first.item.id)
    assert.deepEqual(again.item.tags, ['无语', '敷衍', '接梗'])
    assert.equal(again.item.desc, '新描述')

    const index = JSON.parse(await fs.readFile(paths.stickerIndex, 'utf8'))
    assert.equal(index.items.length, 1)
    assert.deepEqual(index.items[0].tags, ['无语', '敷衍', '接梗'])
  })
})

test('list 支持图层/标签/关键词过滤、排序与分页', async () => {
  await withStore(async ({ store }) => {
    const a = await store.addItem({ buffer: png('a'), ext: 'png', tags: ['无语'], desc: '第一张' })
    await sleep(5)
    const b = await store.addItem({ buffer: png('b'), ext: 'png', tags: ['无语', '敷衍'], desc: '第二张' })
    await sleep(5)
    const c = await store.addItem({ buffer: png('c'), ext: 'png', tags: ['可爱'], desc: '第三张' })
    await store.update(c.item.id, { layer: 'library' })

    const all = await store.list({})
    assert.equal(all.total, 3)
    assert.deepEqual(
      all.items.map((item) => item.id),
      [c.item.id, b.item.id, a.item.id]
    )

    const andTags = await store.list({ tags: ['无语', '敷衍'] })
    assert.equal(andTags.total, 1)
    assert.equal(andTags.items[0].id, b.item.id)

    const byLayer = await store.list({ layer: 'library' })
    assert.equal(byLayer.total, 1)
    assert.equal(byLayer.items[0].id, c.item.id)

    const byQuery = await store.list({ query: '第二' })
    assert.equal(byQuery.total, 1)
    assert.equal(byQuery.items[0].id, b.item.id)

    const byIdQuery = await store.list({ query: a.item.id.slice(0, 8) })
    assert.equal(byIdQuery.total, 1)
    assert.equal(byIdQuery.items[0].id, a.item.id)

    const page = await store.list({ limit: 1, offset: 1 })
    assert.equal(page.total, 3)
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0].id, b.item.id)

    const unlimited = await store.list({ limit: 0 })
    assert.equal(unlimited.items.length, 3)
  })
})

test('update 修改标签/描述；换图层时移动文件；不存在的 id 抛错', async () => {
  await withStore(async ({ paths, store }) => {
    const { item } = await store.addItem({ buffer: PNG, ext: 'png', tags: ['a'], desc: 'old' })
    const candidateFile = store.filePath(item)
    assert.ok(await exists(candidateFile))

    const updated = await store.update(item.id, { tags: ['b', 'c'], desc: 'new', layer: 'library' })
    assert.deepEqual(updated.tags, ['b', 'c'])
    assert.equal(updated.desc, 'new')
    assert.equal(updated.layer, 'library')
    assert.equal(updated.useCount, 0)
    assert.equal(await exists(candidateFile), false)
    const libraryFile = path.join(paths.stickerLibrary, `${item.id}.png`)
    assert.ok(await exists(libraryFile))

    await assert.rejects(() => store.update('missing-id', { tags: [] }), /sticker not found/)
    await assert.rejects(() => store.update(item.id, { layer: 'not-a-layer' }), /invalid sticker layer/)
    // 描述可以清空
    const cleared = await store.update(item.id, { desc: '' })
    assert.equal(cleared.desc, '')
  })
})

test('recordUse 累加使用次数并记录最近使用时间', async () => {
  await withStore(async ({ store }) => {
    const { item } = await store.addItem({ buffer: PNG, ext: 'png' })
    assert.equal(item.useCount, 0)
    const first = await store.recordUse(item.id)
    assert.equal(first.useCount, 1)
    assert.ok(Number.isFinite(first.lastUsedAt))
    const second = await store.recordUse(item.id)
    assert.equal(second.useCount, 2)
    await assert.rejects(() => store.recordUse('missing-id'), /sticker not found/)
  })
})

test('pick 完全命中优先、遵守 libraryOnly、无匹配返回 null', async () => {
  await withStore(async ({ store, configStore }) => {
    const full = await store.addItem({ buffer: png('full'), ext: 'png', tags: ['无语', '敷衍'], layer: 'library' })
    const partial = await store.addItem({ buffer: png('partial'), ext: 'png', tags: ['无语'], layer: 'library' })
    const candidate = await store.addItem({ buffer: png('cand'), ext: 'png', tags: ['可爱'] })

    const exact = await store.pick({ tags: ['无语', '敷衍'], rng: () => 0 })
    assert.equal(exact.id, full.item.id)

    const countFallback = await store.pick({ tags: ['无语'], rng: () => 0 })
    assert.ok([full.item.id, partial.item.id].includes(countFallback.id))
    assert.ok(countFallback.tags.includes('无语'))

    assert.equal(await store.pick({ tags: ['可爱'] }), null)
    assert.equal(await store.pick({ tags: ['完全不存在的标签'] }), null)
    assert.equal(await store.pick({ tags: [] }).then((item) => item.layer), 'library')

    configStore.setConfig({ stickers: { libraryOnly: false } })
    const fromCandidate = await store.pick({ tags: ['可爱'] })
    assert.equal(fromCandidate.id, candidate.item.id)
    const anyPool = await store.pick({ tags: [], rng: () => 0 })
    assert.ok(['library', 'candidate'].includes(anyPool.layer))
  })
})

test('catalog 与 stats 统计标签和图层', async () => {
  await withStore(async ({ store }) => {
    await store.addItem({ buffer: png('a'), ext: 'png', tags: ['无语', '敷衍'], layer: 'library' })
    await store.addItem({ buffer: png('b'), ext: 'png', tags: ['无语'], layer: 'library' })
    await store.addItem({ buffer: png('c'), ext: 'png', tags: ['待审'], layer: 'candidate' })

    const catalog = await store.catalog({})
    assert.equal(catalog.total, 3)
    assert.equal(catalog.tagTotal, 3)
    assert.deepEqual(catalog.byLayer, { library: 2, candidate: 1, negative: 0, trash: 0 })
    assert.equal(catalog.tags[0].tag, '无语')
    assert.equal(catalog.tags[0].count, 2)

    const libraryOnly = await store.catalog({ layer: 'library' })
    assert.equal(libraryOnly.total, 2)
    assert.deepEqual(libraryOnly.tags.map((entry) => entry.tag), ['无语', '敷衍'])

    const stats = await store.stats()
    assert.equal(stats.total, 3)
    assert.equal(stats.tags, 3)
    assert.deepEqual(stats.byLayer, { library: 2, candidate: 1, negative: 0, trash: 0 })
  })
})

test('remove/restore/purge 管理回收站', async () => {
  await withStore(async ({ paths, store }) => {
    const { item } = await store.addItem({ buffer: PNG, ext: 'png', tags: ['a'] })
    const candidateFile = path.join(paths.stickerCandidate, `${item.id}.png`)
    assert.ok(await exists(candidateFile))

    const removed = await store.remove(item.id)
    assert.equal(removed.layer, 'trash')
    assert.equal(await exists(candidateFile), false)
    assert.ok(await exists(path.join(paths.stickerTrash, `${item.id}.png`)))

    const restored = await store.restore(item.id)
    assert.equal(restored.layer, 'candidate')
    assert.ok(await exists(candidateFile))

    const purged = await store.purge(item.id)
    assert.deepEqual(purged, { id: item.id, removed: true })
    assert.equal(await store.get(item.id), undefined)
    assert.equal(await exists(candidateFile), false)
    assert.equal(await store.list({}).then((result) => result.total), 0)

    await assert.rejects(() => store.remove('missing-id'), /sticker not found/)
    await assert.rejects(() => store.restore('missing-id'), /sticker not found/)
    assert.deepEqual(await store.purge('missing-id'), { id: 'missing-id', removed: false })
  })
})

test('索引 JSON 损坏时备份为 .corrupt-* 并重建空索引', async () => {
  const temp = await makeTempPaths()
  try {
    await fs.writeFile(temp.paths.stickerIndex, '{ this is definitely not json', 'utf8')
    const logger = makeLogger()
    const store = createStickerStore({ paths: temp.paths, configStore: makeConfigStore(), logger })
    await store.init()

    assert.equal((await store.list({})).total, 0)
    const raw = JSON.parse(await fs.readFile(temp.paths.stickerIndex, 'utf8'))
    assert.deepEqual(raw, { version: 1, items: [] })
    const names = await fs.readdir(temp.paths.stickers)
    assert.ok(names.some((name) => name.startsWith('index.json.corrupt-')))
    assert.ok(logger.entries.some((entry) => entry.level === 'warn'))
  } finally {
    await temp.cleanup()
  }
})

test('非法输入抛出明确错误（空 buffer / 非法图层 / 非法扩展名）', async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(() => store.addItem({ buffer: 'not a buffer', ext: 'png' }), /non-empty Buffer/)
    await assert.rejects(() => store.addItem({ buffer: Buffer.alloc(0), ext: 'png' }), /non-empty Buffer/)
    await assert.rejects(() => store.addItem({ buffer: PNG, ext: 'png', layer: 'nope' }), /invalid sticker layer/)
    await assert.rejects(() => store.addItem({ buffer: PNG, ext: '' }), /unsupported sticker format/)
    await assert.rejects(() => store.addItem({ buffer: PNG, ext: 'svg' }), /unsupported sticker format/)
  })
})

test('并发 addItem 串行化：索引完整、文件齐全', async () => {
  await withStore(async ({ paths, store }) => {
    const buffers = Array.from({ length: 8 }, (_entry, index) => png(`batch-${index}`))
    const results = await Promise.all(
      buffers.map((buffer) => store.addItem({ buffer, ext: 'png', tags: ['批量'] }))
    )
    assert.equal(new Set(results.map((result) => result.item.id)).size, 8)
    assert.equal((await store.list({ layer: 'candidate' })).total, 8)
    const index = JSON.parse(await fs.readFile(paths.stickerIndex, 'utf8'))
    assert.equal(index.items.length, 8)
    for (const result of results) {
      assert.ok(await exists(store.filePath(result.item)))
    }
    await store.flush()
  })
})
