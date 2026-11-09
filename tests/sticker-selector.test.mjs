/**
 * host/stickers/selector.js 测试：临时目录隔离、不联网。
 * 覆盖标签目录文本、显式标签挑选（含放宽重试）、概率表情挑选与空库/禁用边界。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTempPaths, makeConfigStore, makeLogger } from './helpers.mjs'
import { createStickerStore } from '../host/stickers/store.js'
import { createStickerSelector } from '../host/stickers/selector.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03])

function png(seed) {
  return Buffer.concat([PNG, Buffer.from(`seed-${seed}`)])
}

async function withSelector(fn, configOverrides = {}) {
  const temp = await makeTempPaths()
  try {
    const configStore = makeConfigStore(configOverrides)
    const logger = makeLogger()
    const store = createStickerStore({ paths: temp.paths, configStore, logger })
    await store.init()
    const selector = createStickerSelector({ stickerStore: store, configStore, logger })
    await fn({ ...temp, configStore, logger, store, selector })
  } finally {
    await temp.cleanup()
  }
}

async function addLibrary(store, seed, tags) {
  const { item } = await store.addItem({ buffer: png(seed), ext: 'png', tags, layer: 'library' })
  return item
}

test('catalogText 只统计 library 标签并按次数格式化为「标签(次数)」', async () => {
  await withSelector(async ({ store, selector }) => {
    await addLibrary(store, 'a', ['无语', '敷衍'])
    await addLibrary(store, 'b', ['无语', '可爱'])
    await store.addItem({ buffer: png('cand'), ext: 'png', tags: ['待审'], layer: 'candidate' })

    const text = await selector.catalogText()
    assert.equal(text, '无语(2)、敷衍(1)、可爱(1)')
    assert.ok(!text.includes('待审'))
  })
})

test('catalogText 空库返回空字符串；maxCatalogTags 截断；禁用时返回空', async () => {
  await withSelector(async ({ selector }) => {
    assert.equal(await selector.catalogText(), '')
  })

  await withSelector(
    async ({ store, selector }) => {
      for (const tag of ['t1', 't2', 't3', 't4', 't5']) {
        await addLibrary(store, tag, [tag])
      }
      const text = await selector.catalogText()
      assert.equal(text.split('、').length, 4)
      assert.ok(text.startsWith('t1(1)'))
    },
    { stickers: { maxCatalogTags: 4 } }
  )

  await withSelector(
    async ({ store, selector }) => {
      await addLibrary(store, 'x', ['无语'])
      assert.equal(await selector.catalogText(), '')
      assert.equal(await selector.pickForReply(['无语']), null)
      assert.equal(await selector.maybeStickerFromText('无语', () => 0), null)
    },
    { stickers: { enabled: false } }
  )
})

test('pickForReply 解析标签、放宽为单标签重试、空标签随机挑选', async () => {
  await withSelector(async ({ store, selector }) => {
    const wuyu = await addLibrary(store, 'wuyu', ['无语'])
    const cute = await addLibrary(store, 'cute', ['可爱'])

    const strict = await selector.pickForReply(['无语'])
    assert.equal(strict.id, wuyu.id)

    const multi = await selector.pickForReply(['无语', '根本没有的标签'])
    assert.equal(multi.id, wuyu.id)

    const cuteHit = await selector.pickForReply('可爱')
    assert.equal(cuteHit.id, cute.id)

    assert.equal(await selector.pickForReply(['完全没有']), null)

    const randomPick = await selector.pickForReply([])
    assert.ok([wuyu.id, cute.id].includes(randomPick.id))
    assert.equal(randomPick.layer, 'library')
  })
})

test('maybeStickerFromText 概率命中且回复文本包含 library 标签时返回表情', async () => {
  await withSelector(async ({ store, selector }) => {
    const wuyu = await addLibrary(store, 'wuyu', ['无语'])
    await store.addItem({ buffer: png('pending'), ext: 'png', tags: ['待审'], layer: 'candidate' })

    const hit = await selector.maybeStickerFromText('今天真的无语了', () => 0)
    assert.equal(hit.id, wuyu.id)

    assert.equal(await selector.maybeStickerFromText('今天真的无语了', () => 0.99), null)
    assert.equal(await selector.maybeStickerFromText('今天天气不错', () => 0), null)
    // candidate 图层的标签不参与
    assert.equal(await selector.maybeStickerFromText('待审', () => 0), null)
    assert.equal(await selector.maybeStickerFromText('', () => 0), null)
    assert.equal(await selector.maybeStickerFromText('   ', () => 0), null)
  })
})

test('maybeStickerFromText 概率为 0 时不发；空库返回 null', async () => {
  await withSelector(
    async ({ store, selector }) => {
      await addLibrary(store, 'wuyu', ['无语'])
      assert.equal(await selector.maybeStickerFromText('无语', () => 0), null)
    },
    { persona: { stickerChance: 0 } }
  )

  await withSelector(
    async ({ selector }) => {
      assert.equal(await selector.maybeStickerFromText('无语', () => 0), null)
      assert.equal(await selector.pickForReply(['无语']), null)
      assert.equal(await selector.catalogText(), '')
    },
    { persona: { stickerChance: 1 } }
  )
})
