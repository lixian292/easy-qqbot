/**
 * host/stickers/importer.js 测试：临时目录隔离、不联网（captureFromUrl 注入 fetchImpl）。
 * 覆盖魔数识别、目录扫描/导入、Buffer 导入，以及下载大小限制/网络失败等边界。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { makeTempPaths, makeConfigStore, makeLogger } from './helpers.mjs'
import { createStickerStore } from '../host/stickers/store.js'
import {
  createStickerImporter,
  detectImageExt,
  extFromContentType,
  isSupportedImageBuffer
} from '../host/stickers/importer.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 ')])
const BMP = Buffer.from([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00])

async function withImporter(fn, { config = {}, fetchImpl } = {}) {
  const temp = await makeTempPaths()
  try {
    const configStore = makeConfigStore(config)
    const logger = makeLogger()
    const store = createStickerStore({ paths: temp.paths, configStore, logger })
    await store.init()
    const importer = createStickerImporter({
      paths: temp.paths,
      configStore,
      stickerStore: store,
      logger,
      fetchImpl
    })
    await fn({ ...temp, configStore, logger, store, importer })
  } finally {
    await temp.cleanup()
  }
}

async function writeFileIn(dir, name, buffer) {
  const file = path.join(dir, name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, buffer)
  return file
}

/** Fake fetch: returns a Response-like object carrying an image body. */
function makeFetch({ status = 200, contentType = 'image/png', buffer = PNG, contentLength, error } = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (error !== undefined) throw error
    const headers = new Map()
    if (contentType !== null) headers.set('content-type', contentType)
    if (contentLength !== undefined) headers.set('content-length', String(contentLength))
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
      async arrayBuffer() {
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      }
    }
  }
  return { fetchImpl, calls }
}

test('isSupportedImageBuffer 按魔数识别五种格式并拒绝非图片', () => {
  assert.equal(isSupportedImageBuffer(PNG), true)
  assert.equal(isSupportedImageBuffer(PNG, 'png'), true)
  // 扩展名只是辅助：内容为 PNG 时传别的扩展名也认
  assert.equal(isSupportedImageBuffer(PNG, 'gif'), true)
  assert.equal(isSupportedImageBuffer(JPG), true)
  assert.equal(isSupportedImageBuffer(GIF), true)
  assert.equal(isSupportedImageBuffer(WEBP), true)
  assert.equal(isSupportedImageBuffer(BMP), true)
  assert.equal(isSupportedImageBuffer(Buffer.from('hello world')), false)
  assert.equal(isSupportedImageBuffer(Buffer.from([0xff, 0xd8])), false)
  assert.equal(isSupportedImageBuffer(Buffer.alloc(0)), false)
  assert.equal(isSupportedImageBuffer(null), false)
  assert.equal(detectImageExt(WEBP), 'webp')
  assert.equal(detectImageExt(PNG), 'png')
  assert.equal(detectImageExt(Buffer.from('nope')), undefined)
})

test('extFromContentType 映射常见图片 Content-Type', () => {
  assert.equal(extFromContentType('image/jpeg'), 'jpg')
  assert.equal(extFromContentType('IMAGE/PNG'), 'png')
  assert.equal(extFromContentType('image/png; charset=binary'), 'png')
  assert.equal(extFromContentType('image/gif'), 'gif')
  assert.equal(extFromContentType('image/webp'), 'webp')
  assert.equal(extFromContentType('image/bmp'), 'bmp')
  assert.equal(extFromContentType('text/plain'), '')
  assert.equal(extFromContentType('image/avif'), '')
  assert.equal(extFromContentType(undefined), '')
  assert.equal(extFromContentType(''), '')
})

test('scanImportDir 递归扫描图片，忽略普通文本文件', async () => {
  await withImporter(async ({ paths, importer }) => {
    await writeFileIn(paths.importDir, 'a.png', PNG)
    await writeFileIn(paths.importDir, 'b.jpg', JPG)
    await writeFileIn(paths.importDir, 'nested/deep/c.gif', GIF)
    await writeFileIn(paths.importDir, 'note.txt', Buffer.from('hello'))
    // 无扩展名但内容是图片：靠魔数补充识别
    await writeFileIn(paths.importDir, 'headerless', WEBP)

    const scanned = await importer.scanImportDir()
    const names = scanned.map((entry) => entry.name).sort()
    assert.deepEqual(names, ['a.png', 'b.jpg', 'c.gif', 'headerless'])

    const pngEntry = scanned.find((entry) => entry.name === 'a.png')
    assert.equal(pngEntry.size, PNG.length)
    assert.ok(path.isAbsolute(pngEntry.path))

    // 扩展名像图片但内容不是：扫描阶段保留，导入阶段再按魔数跳过
    await writeFileIn(paths.importDir, 'fake.jpeg', Buffer.from('definitely not an image'))
    const rescanned = await importer.scanImportDir()
    assert.ok(rescanned.some((entry) => entry.name === 'fake.jpeg'))

    // 不存在的目录返回空数组
    assert.deepEqual(await importer.scanImportDir(path.join(paths.data, 'does-not-exist')), [])
  })
})

test('importDirectory 统计新增/重复/跳过，并写入指定图层', async () => {
  await withImporter(async ({ paths, importer, store }) => {
    await writeFileIn(paths.importDir, 'a.png', PNG)
    await writeFileIn(paths.importDir, 'b.png', PNG) // 与 a.png 内容相同 → 重复
    await writeFileIn(paths.importDir, 'fake.jpg', Buffer.from('not an image'))
    await writeFileIn(paths.importDir, 'note.txt', Buffer.from('hello'))

    const result = await importer.importDirectory({ tags: ['无语', '敷衍'], layer: 'library' })
    assert.equal(result.scanned, 3)
    assert.equal(result.added.length, 1)
    assert.equal(result.duplicates.length, 1)
    assert.equal(result.skipped.length, 1)
    assert.equal(result.errors.length, 0)
    assert.match(result.skipped[0].reason, /不是支持的图片格式/)
    assert.equal(result.added[0].layer, 'library')
    assert.deepEqual(result.added[0].tags, ['无语', '敷衍'])
    assert.equal(result.added[0].id, result.duplicates[0].id)

    const list = await store.list({ layer: 'library' })
    assert.equal(list.total, 1)
    assert.equal(list.items[0].tags.length, 2)
  })
})

test('importDirectory 对不存在的目录抛错', async () => {
  await withImporter(async ({ paths, importer }) => {
    await assert.rejects(
      () => importer.importDirectory({ dir: path.join(paths.data, 'missing-dir') }),
      /导入目录不存在/
    )
  })
})

test('importBuffers 导入 Buffer 列表，重复与非法内容分别统计', async () => {
  await withImporter(async ({ importer }) => {
    const result = await importer.importBuffers(
      [
        { name: 'one.png', buffer: PNG },
        { name: 'two.png', buffer: PNG },
        { name: 'bad.png', buffer: Buffer.from('oops') },
        { name: 'empty.png', buffer: Buffer.alloc(0) }
      ],
      { tags: ['批量'], source: { userId: 'u9' } }
    )
    assert.equal(result.scanned, 4)
    assert.equal(result.added.length, 1)
    assert.equal(result.duplicates.length, 1)
    assert.equal(result.skipped.length, 2)
    assert.equal(result.errors.length, 0)
    assert.equal(result.skipped[0].path, 'bad.png')
    assert.equal(result.skipped[1].path, 'empty.png')
    assert.deepEqual(result.added[0].source, { userId: 'u9', path: 'one.png' })
  })
})

test('captureFromUrl 下载入站图片到 candidate（注入 fetch，不联网）', async () => {
  const { fetchImpl, calls } = makeFetch({ buffer: PNG, contentType: 'image/png' })
  await withImporter(
    async ({ store, importer }) => {
      const result = await importer.captureFromUrl({
        url: 'https://example.com/download?fileid=abc',
        contentType: 'image/png',
        source: { chatId: 'c2c_u1', userId: 'u1' }
      })
      assert.ok(result.item)
      assert.equal(result.item.layer, 'candidate')
      assert.equal(result.item.ext, 'png')
      assert.deepEqual(result.item.tags, [])
      assert.equal(result.item.desc, '')
      assert.equal(result.item.source.url, 'https://example.com/download?fileid=abc')
      assert.equal(result.item.source.chatId, 'c2c_u1')
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'https://example.com/download?fileid=abc')

      // 同一张图再次捕获 → 去重
      const duplicate = await importer.captureFromUrl({ url: 'https://example.com/download?fileid=abc' })
      assert.equal(duplicate.duplicate, true)
      assert.equal(duplicate.item.id, result.item.id)
      assert.equal((await store.list({ layer: 'candidate' })).total, 1)
    },
    { fetchImpl }
  )
})

test('captureFromUrl 超过 maxImageBytes 时跳过（Content-Length 与实体长度两条路径）', async () => {
  const limitedConfig = { stickers: { maxImageBytes: 65536 } }
  const big = makeFetch({ contentLength: 999999 })
  await withImporter(
    async ({ importer }) => {
      const headerSkip = await importer.captureFromUrl({ url: 'https://example.com/big.png' })
      assert.equal(headerSkip.item, undefined)
      assert.match(headerSkip.skipped, /图片过大/)
    },
    { config: limitedConfig, fetchImpl: big.fetchImpl }
  )

  const oversized = Buffer.concat([PNG, Buffer.alloc(70000)])
  const bigBuffer = makeFetch({ buffer: oversized })
  await withImporter(
    async ({ importer }) => {
      const bodySkip = await importer.captureFromUrl({ url: 'https://example.com/big2.png' })
      assert.equal(bodySkip.item, undefined)
      assert.match(bodySkip.skipped, /图片过大/)
    },
    { config: limitedConfig, fetchImpl: bigBuffer.fetchImpl }
  )
})

test('captureFromUrl 对非图片内容跳过、对网络错误/HTTP 错误抛错', async () => {
  const text = makeFetch({ buffer: Buffer.from('plain text'), contentType: 'text/plain' })
  await withImporter(
    async ({ importer }) => {
      const skipped = await importer.captureFromUrl({ url: 'https://example.com/not-image' })
      assert.equal(skipped.item, undefined)
      assert.match(skipped.skipped, /不是支持的图片格式/)
    },
    { fetchImpl: text.fetchImpl }
  )

  const failing = makeFetch({ error: new Error('network down') })
  await withImporter(
    async ({ importer }) => {
      await assert.rejects(() => importer.captureFromUrl({ url: 'https://example.com/x.png' }), /network down/)
      await assert.rejects(() => importer.captureFromUrl({ url: '' }), /URL 不能为空/)
    },
    { fetchImpl: failing.fetchImpl }
  )

  const notFound = makeFetch({ status: 404 })
  await withImporter(
    async ({ importer }) => {
      await assert.rejects(() => importer.captureFromUrl({ url: 'https://example.com/404.png' }), /HTTP 404/)
    },
    { fetchImpl: notFound.fetchImpl }
  )
})
