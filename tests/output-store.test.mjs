/** Tests for host/output/store.js — generated asset library, no network. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createOutputStore } from '../host/output/store.js'
import { makeConfigStore, makeLogger, makeTempPaths } from './helpers.mjs'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

async function setup(overrides = {}) {
  const { paths, cleanup } = await makeTempPaths()
  const configStore = makeConfigStore(overrides.config ?? {})
  const logger = overrides.logger ?? makeLogger()
  const store = createOutputStore({ paths, configStore, logger })
  await store.init()
  return { store, paths, configStore, logger, cleanup }
}

test('add / list / get / stats / filePath write files and index', async () => {
  const { store, paths, cleanup } = await setup()
  try {
    const image = await store.add({
      kind: 'image',
      buffer: PNG,
      mime: 'image/png',
      prompt: '一只猫',
      provider: 'api.example.com',
      model: 'img-1',
      source: { kind: 'admin' }
    })
    assert.match(image.id, /^[a-f0-9]{16}$/)
    assert.equal(image.ext, 'png')
    assert.equal(image.size, PNG.length)
    assert.ok(image.filePath.endsWith(`${image.id}.png`))
    assert.deepEqual(await fs.readFile(image.filePath), PNG)

    const audio = await store.add({ kind: 'audio', buffer: Buffer.from('mp3-bytes'), mime: 'audio/mpeg', prompt: '你好' })
    const listed = await store.list({})
    assert.equal(listed.total, 2)
    assert.equal(listed.items[0].id, audio.id, 'newest first')

    const images = await store.list({ kind: 'image' })
    assert.equal(images.total, 1)
    assert.equal(images.items[0].id, image.id)

    const fetched = await store.get(image.id)
    assert.equal(fetched.prompt, '一只猫')
    assert.equal(await store.get('missing'), undefined)

    const stats = store.stats()
    assert.deepEqual(stats.byKind, { image: 1, audio: 1, video: 0 })
    assert.equal(stats.total, 2)
    assert.equal(store.filePath(image).endsWith(`${image.id}.png`), true)

    const index = JSON.parse(await fs.readFile(paths.outputIndex, 'utf8'))
    assert.equal(index.items.length, 2)
  } finally {
    await cleanup()
  }
})

test('list paginates and filters invalid kinds as "all"', async () => {
  const { store, cleanup } = await setup()
  try {
    for (let i = 0; i < 5; i += 1) {
      await store.add({ kind: 'image', buffer: Buffer.from(`png-${i}`), mime: 'image/png', prompt: `p${i}` })
    }
    const page = await store.list({ limit: 2, offset: 1 })
    assert.equal(page.total, 5)
    assert.equal(page.items.length, 2)
    const all = await store.list({ kind: 'not-a-kind' })
    assert.equal(all.total, 5)
  } finally {
    await cleanup()
  }
})

test('add prunes by maxItems and retentionDays', async () => {
  const { store, paths, cleanup } = await setup({ config: { output: { maxItems: 2, retentionDays: 1 } } })
  try {
    const old = await store.add({
      kind: 'image',
      buffer: Buffer.from('old'),
      mime: 'image/png',
      createdAt: Date.now() - 3 * 86400000
    })
    const fresh1 = await store.add({ kind: 'image', buffer: Buffer.from('1'), mime: 'image/png' })
    await store.add({ kind: 'image', buffer: Buffer.from('2'), mime: 'image/png' })
    const listed = await store.list({})
    assert.equal(listed.total, 2)
    assert.equal(listed.items.some((item) => item.id === old.id), false, 'expired record removed')
    assert.equal(listed.items.some((item) => item.id === fresh1.id), true)
    const files = await fs.readdir(paths.outputs)
    assert.equal(files.filter((name) => name.endsWith('.png')).length, 2, 'expired file deleted')
  } finally {
    await cleanup()
  }
})

test('remove and clear delete files and index entries', async () => {
  const { store, cleanup } = await setup()
  try {
    const a = await store.add({ kind: 'image', buffer: Buffer.from('a'), mime: 'image/png' })
    const b = await store.add({ kind: 'audio', buffer: Buffer.from('b'), mime: 'audio/mpeg' })
    const removed = await store.remove(a.id)
    assert.equal(removed.id, a.id)
    await assert.rejects(() => store.remove(a.id), /找不到/)
    assert.equal((await store.list({})).total, 1)

    const cleared = await store.clear()
    assert.equal(cleared.removed, 1)
    assert.equal((await store.list({})).total, 0)
    assert.equal(store.stats().total, 0)
    await assert.rejects(() => fs.stat(b.filePath), /ENOENT/)
  } finally {
    await cleanup()
  }
})

test('clear can target one kind', async () => {
  const { store, cleanup } = await setup()
  try {
    await store.add({ kind: 'image', buffer: Buffer.from('a'), mime: 'image/png' })
    await store.add({ kind: 'video', buffer: Buffer.from('v'), mime: 'video/mp4' })
    const result = await store.clear({ kind: 'video' })
    assert.equal(result.removed, 1)
    const listed = await store.list({})
    assert.equal(listed.total, 1)
    assert.equal(listed.items[0].kind, 'image')
  } finally {
    await cleanup()
  }
})

test('corrupt index is backed up and rebuilt empty', async () => {
  const { paths, cleanup } = await makeTempPaths()
  try {
    await fs.writeFile(paths.outputIndex, '{broken json')
    const logger = makeLogger()
    const store = createOutputStore({ paths, configStore: makeConfigStore(), logger })
    await store.init()
    assert.equal(store.stats().total, 0)
    assert.equal(logger.entries.some((entry) => entry.level === 'warn' && entry.msg.includes('索引损坏')), true)
    const files = await fs.readdir(paths.outputs)
    assert.ok(files.some((name) => name.includes('.corrupt-')), 'corrupt index kept as backup')
  } finally {
    await cleanup()
  }
})

test('invalid input is rejected with clear errors', async () => {
  const { store, cleanup } = await setup()
  try {
    await assert.rejects(() => store.add({ kind: 'nope', buffer: PNG, mime: 'image/png' }), /不支持的输出类型/)
    await assert.rejects(() => store.add({ kind: 'image', buffer: Buffer.alloc(0), mime: 'image/png' }), /生成内容为空/)
    assert.equal((await store.list({})).total, 0)
  } finally {
    await cleanup()
  }
})
