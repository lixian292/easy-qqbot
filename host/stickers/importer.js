/**
 * Sticker importer.
 *
 * Batch-imports images from `import/` (or an explicit directory / buffer list)
 * into the sticker store, and captures inbound chat images into the
 * `candidate` layer.
 *
 * Image formats are detected from magic bytes, never from the file name:
 *   jpg  FF D8 FF
 *   png  89 50 4E 47 0D 0A 1A 0A
 *   gif  47 49 46 38 ("GIF8")
 *   webp 52 49 46 46 ("RIFF") ... 57 45 42 50 ("WEBP")
 *   bmp  42 4D ("BM")
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { extOf, listFilesRecursive, pathExists } from '../util/fsx.js'

/** Image extensions accepted by the importer (`.jpeg` is stored as `.jpg`). */
export const SUPPORTED_IMAGE_EXTS = Object.freeze(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'])

const KNOWN_EXTS = new Set(SUPPORTED_IMAGE_EXTS)
const CONTENT_TYPE_EXT = new Map([
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/pjpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/x-png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/bmp', 'bmp'],
  ['image/x-bmp', 'bmp'],
  ['image/x-ms-bmp', 'bmp']
])

const MAX_SOURCE_VALUE = 1024
const SOURCE_KEYS = ['chatId', 'userId', 'userName', 'msgId', 'path', 'url']

function byteAt(buffer, index) {
  return typeof buffer[index] === 'number' ? buffer[index] : -1
}

/**
 * Detect the image format from the first bytes of a buffer.
 * @returns {'jpg'|'png'|'gif'|'webp'|'bmp'|undefined} undefined when unsupported
 */
export function detectImageExt(buffer) {
  if (buffer === null || buffer === undefined) return undefined
  if (typeof buffer.length !== 'number' || buffer.length < 2) return undefined
  if (buffer.length >= 3 && byteAt(buffer, 0) === 0xff && byteAt(buffer, 1) === 0xd8 && byteAt(buffer, 2) === 0xff) {
    return 'jpg'
  }
  if (
    buffer.length >= 8 &&
    byteAt(buffer, 0) === 0x89 &&
    byteAt(buffer, 1) === 0x50 &&
    byteAt(buffer, 2) === 0x4e &&
    byteAt(buffer, 3) === 0x47 &&
    byteAt(buffer, 4) === 0x0d &&
    byteAt(buffer, 5) === 0x0a &&
    byteAt(buffer, 6) === 0x1a &&
    byteAt(buffer, 7) === 0x0a
  ) {
    return 'png'
  }
  if (buffer.length >= 4 && byteAt(buffer, 0) === 0x47 && byteAt(buffer, 1) === 0x49 && byteAt(buffer, 2) === 0x46 && byteAt(buffer, 3) === 0x38) {
    return 'gif'
  }
  if (
    buffer.length >= 12 &&
    byteAt(buffer, 0) === 0x52 &&
    byteAt(buffer, 1) === 0x49 &&
    byteAt(buffer, 2) === 0x46 &&
    byteAt(buffer, 3) === 0x46 &&
    byteAt(buffer, 8) === 0x57 &&
    byteAt(buffer, 9) === 0x45 &&
    byteAt(buffer, 10) === 0x42 &&
    byteAt(buffer, 11) === 0x50
  ) {
    return 'webp'
  }
  if (buffer.length >= 2 && byteAt(buffer, 0) === 0x42 && byteAt(buffer, 1) === 0x4d) return 'bmp'
  return undefined
}

/**
 * Magic-byte check for a supported image. `ext` is accepted for API
 * compatibility only: the bytes always decide, so a `.png` file containing
 * arbitrary text is rejected.
 */
export function isSupportedImageBuffer(buffer, ext) {
  if (buffer === null || buffer === undefined || typeof buffer.length !== 'number') return false
  return detectImageExt(buffer) !== undefined
}

/** Map a Content-Type header to a sticker extension; `''` when unrelated. */
export function extFromContentType(contentType) {
  const value = String(contentType ?? '')
    .toLowerCase()
    .split(';')[0]
    .trim()
  if (value === '') return ''
  return CONTENT_TYPE_EXT.get(value) ?? ''
}

function normalizeSource(source) {
  if (source === null || source === undefined || typeof source !== 'object') return {}
  const out = {}
  for (const key of SOURCE_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim().slice(0, MAX_SOURCE_VALUE)
  }
  return out
}

async function readHeader(file, byteCount) {
  let handle
  try {
    handle = await fs.open(file, 'r')
    const buffer = Buffer.alloc(byteCount)
    const { bytesRead } = await handle.read(buffer, 0, byteCount, 0)
    return buffer.subarray(0, bytesRead)
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * @param {{ paths: object, configStore: { get(): object }, stickerStore: object, logger?: object, fetchImpl?: Function }} deps
 */
export function createStickerImporter({ paths, configStore, stickerStore, logger, fetchImpl } = {}) {
  if (!paths || typeof paths.importDir !== 'string') throw new Error('createStickerImporter 需要 host/paths.js 的 paths 对象')
  if (!stickerStore || typeof stickerStore.addItem !== 'function') throw new Error('createStickerImporter 需要 stickerStore')

  function resolveDir(dir) {
    if (dir === undefined || dir === null || dir === '') return paths.importDir
    return path.resolve(String(dir))
  }

  async function readImageBuffer(file) {
    const buffer = await fs.readFile(file)
    const detected = detectImageExt(buffer)
    if (detected === undefined) {
      return { buffer, ext: undefined }
    }
    return { buffer, ext: detected }
  }

  async function addBuffer({ buffer, ext, tags, desc, layer, source }) {
    return stickerStore.addItem({ buffer, ext, tags, desc, layer, source })
  }

  async function scanImportDir(dir) {
    const target = resolveDir(dir)
    const files = await listFilesRecursive(target)
    const out = []
    for (const file of files) {
      let stat
      try {
        stat = await fs.stat(file)
      } catch (error) {
        logger?.debug?.('扫描导入文件失败，已忽略', { file, error: error?.message })
        continue
      }
      if (!stat.isFile()) continue
      const ext = extOf(file)
      const name = path.basename(file)
      if (KNOWN_EXTS.has(ext)) {
        out.push({ path: file, name, size: stat.size, ext: ext === 'jpeg' ? 'jpg' : ext })
        continue
      }
      // Unknown extension: sniff the header so a valid image named e.g. `foo`
      // or `foo.dat` is still imported.
      const header = await readHeader(file, 16)
      const detected = detectImageExt(header)
      if (detected === undefined) continue
      out.push({ path: file, name, size: stat.size, ext: detected })
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return out
  }

  function emptyResult() {
    return { scanned: 0, added: [], duplicates: [], skipped: [], errors: [] }
  }

  async function importDirectory({ dir, tags = [], desc = '', layer = 'candidate' } = {}) {
    const target = resolveDir(dir)
    if (!(await pathExists(target))) throw new Error(`导入目录不存在：${target}`)
    const files = await scanImportDir(target)
    const result = emptyResult()
    result.scanned = files.length
    for (const file of files) {
      try {
        const { buffer, ext } = await readImageBuffer(file.path)
        if (ext === undefined) {
          result.skipped.push({ path: file.path, name: file.name, reason: '不是支持的图片格式（jpg/png/gif/webp/bmp）' })
          continue
        }
        const { item, duplicate } = await addBuffer({
          buffer,
          ext,
          tags,
          desc,
          layer,
          source: { path: file.path }
        })
        if (duplicate) result.duplicates.push(item)
        else result.added.push(item)
      } catch (error) {
        result.errors.push({ path: file.path, name: file.name, error: error?.message ?? String(error) })
      }
    }
    return result
  }

  async function importBuffers(files, { tags = [], desc = '', layer = 'candidate', source } = {}) {
    const list = Array.isArray(files) ? files : []
    const baseSource = normalizeSource(source)
    const result = emptyResult()
    result.scanned = list.length
    for (const entry of list) {
      const name = typeof entry?.name === 'string' ? entry.name : ''
      const raw = entry?.buffer
      try {
        const buffer = Buffer.isBuffer(raw) ? raw : raw instanceof Uint8Array ? Buffer.from(raw) : undefined
        if (buffer === undefined || buffer.length === 0) {
          result.skipped.push({ path: name, name, reason: '文件内容为空或不是 Buffer' })
          continue
        }
        const ext = detectImageExt(buffer)
        if (ext === undefined) {
          result.skipped.push({ path: name, name, reason: '不是支持的图片格式（jpg/png/gif/webp/bmp）' })
          continue
        }
        const itemSource = name === '' ? { ...baseSource } : { ...baseSource, path: name }
        const { item, duplicate } = await addBuffer({ buffer, ext, tags, desc, layer, source: itemSource })
        if (duplicate) result.duplicates.push(item)
        else result.added.push(item)
      } catch (error) {
        result.errors.push({ path: name, name, error: error?.message ?? String(error) })
      }
    }
    return result
  }

  async function captureFromUrl({ url, contentType, source } = {}) {
    const target = String(url ?? '').trim()
    if (target === '') throw new Error('图片 URL 不能为空')
    const config = configStore?.get?.() ?? {}
    const configuredMax = Number(config?.stickers?.maxImageBytes)
    const maxBytes = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 5 * 1024 * 1024
    const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
    if (typeof fetchFn !== 'function') throw new Error('当前环境不支持 fetch，无法下载图片')

    const response = await fetchFn(target, { method: 'GET', redirect: 'follow' })
    if (response === null || response === undefined || typeof response !== 'object') {
      throw new Error('下载图片失败：响应无效')
    }
    const ok = response.ok !== undefined ? Boolean(response.ok) : typeof response.status === 'number' ? response.status >= 200 && response.status < 300 : true
    if (!ok) throw new Error(`下载图片失败：HTTP ${response.status ?? 'unknown'}`)

    const headers = response.headers
    const headerContentType = typeof headers?.get === 'function' ? headers.get('content-type') : undefined
    const effectiveContentType = contentType ?? headerContentType
    const declaredLengthRaw = typeof headers?.get === 'function' ? headers.get('content-length') : undefined
    const declaredLength = Number(declaredLengthRaw)
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      logger?.debug?.('入站图片超过大小限制，已跳过', { url: target, size: declaredLength, maxBytes })
      return { item: undefined, skipped: `图片过大（${declaredLength} > ${maxBytes} 字节）` }
    }

    let buffer
    if (typeof response.arrayBuffer === 'function') {
      const arrayBuffer = await response.arrayBuffer()
      buffer = Buffer.isBuffer(arrayBuffer) ? arrayBuffer : Buffer.from(arrayBuffer)
    } else if (typeof response.buffer === 'function') {
      buffer = Buffer.from(await response.buffer())
    } else {
      throw new Error('下载图片失败：响应不支持读取内容')
    }
    if (buffer.length === 0) return { item: undefined, skipped: '图片内容为空' }
    if (buffer.length > maxBytes) {
      logger?.debug?.('入站图片超过大小限制，已跳过', { url: target, size: buffer.length, maxBytes })
      return { item: undefined, skipped: `图片过大（${buffer.length} > ${maxBytes} 字节）` }
    }

    const ext = detectImageExt(buffer)
    if (ext === undefined) {
      const hinted = extFromContentType(effectiveContentType)
      logger?.debug?.('入站图片格式不支持，已跳过', { url: target, contentType: effectiveContentType, hinted })
      return { item: undefined, skipped: '不是支持的图片格式（jpg/png/gif/webp/bmp）' }
    }

    const itemSource = { ...normalizeSource(source), url: target }
    const { item, duplicate } = await addBuffer({ buffer, ext, tags: [], desc: '', layer: 'candidate', source: itemSource })
    if (duplicate) return { item, duplicate: true }
    return { item }
  }

  return {
    scanImportDir,
    importDirectory,
    importBuffers,
    captureFromUrl,
    // Convenience re-exports for callers that only hold the importer instance.
    isSupportedImageBuffer,
    extFromContentType,
    detectImageExt
  }
}
