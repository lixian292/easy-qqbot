/** Tests for host/output/reference-store.js — local character reference images. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createReferenceStore } from '../host/output/reference-store.js'
import { makeConfigStore, makeLogger, makeTempPaths } from './helpers.mjs'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')

async function setup(config = {}) {
  const { paths, cleanup } = await makeTempPaths()
  const store = createReferenceStore({ paths, configStore: makeConfigStore(config), logger: makeLogger() })
  await store.init()
  return { store, paths, cleanup }
}

test('adds, lists, reads and removes reference images', async () => {
  const { store, paths, cleanup } = await setup()
  try {
    const item = await store.add({ buffer: PNG, mime: 'image/png', originalName: 'blue-whale-girl.png' })
    assert.match(item.id, /^[a-f0-9]{16}$/)
    assert.equal(item.mime, 'image/png')
    assert.equal(item.ext, 'png')
    assert.ok(item.filePath.endsWith(`${item.id}.png`))
    assert.deepEqual(await fs.readFile(item.filePath), PNG)

    const listed = await store.list()
    assert.equal(listed.items.length, 1)
    assert.equal(listed.items[0].originalName, 'blue-whale-girl.png')
    assert.equal((await store.get(item.id)).size, PNG.length)
    assert.equal(await store.get('missing'), undefined)
    assert.equal(store.filePath(item).startsWith(paths.references), true)

    await store.remove(item.id)
    assert.equal((await store.list()).items.length, 0)
    await assert.rejects(() => fs.stat(item.filePath), /ENOENT/)
  } finally {
    await cleanup()
  }
})

test('rejects non-image and oversized buffers', async () => {
  const { store, cleanup } = await setup({ output: { image: { reference: { maxBytes: 65536 } } } })
  try {
    await assert.rejects(() => store.add({ buffer: Buffer.from('not-an-image'), originalName: 'a.txt' }), /图片格式/)
    await assert.rejects(
      () => store.add({ buffer: Buffer.alloc(70000, 1), mime: 'image/png', originalName: 'big.png' }),
      /过大/
    )
  } finally {
    await cleanup()
  }
})

test('respects maxItems by deleting the oldest reference', async () => {
  const { store, cleanup } = await setup({ output: { image: { reference: { maxItems: 2 } } } })
  try {
    const first = await store.add({ buffer: PNG, mime: 'image/png', originalName: 'first.png' })
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = await store.add({ buffer: PNG, mime: 'image/png', originalName: 'second.png' })
    await new Promise((resolve) => setTimeout(resolve, 2))
    await store.add({ buffer: PNG, mime: 'image/png', originalName: 'third.png' })
    const listed = await store.list()
    assert.equal(listed.items.length, 2)
    assert.equal(listed.items.some((item) => item.id === first.id), false)
    assert.equal(listed.items.some((item) => item.id === second.id), true)
    await assert.rejects(() => fs.stat(store.filePath(first)), /ENOENT/)
  } finally {
    await cleanup()
  }
})

test('corrupt index is backed up and rebuilt empty', async () => {
  const { paths, cleanup } = await makeTempPaths()
  try {
    await fs.writeFile(paths.referenceIndex, '{broken')
    const store = createReferenceStore({ paths, configStore: makeConfigStore(), logger: makeLogger() })
    await store.init()
    assert.equal((await store.list()).items.length, 0)
    const files = await fs.readdir(paths.references)
    assert.ok(files.some((name) => name.includes('.corrupt-')))
  } finally {
    await cleanup()
  }
})
