/**
 * Download one inbound QQ image attachment for vision description.
 * QQ image URLs are short-lived signed links, so failures are expected and are
 * surfaced as typed errors for the caller to log/skip.
 */
import { sniffImageMimeType } from './client.js'

const DEFAULT_TIMEOUT_MS = 20000

export class ImageDownloadError extends Error {
  constructor(message, { code = 'IMAGE_DOWNLOAD_ERROR', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ImageDownloadError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

function normalizeMimeType(contentType) {
  const value = String(contentType ?? '').trim().toLowerCase()
  if (value === 'image/jpg') return 'image/jpeg'
  if (/^image\/(?:jpeg|png|gif|webp|bmp)$/.test(value)) return value
  return ''
}

/**
 * @param {{ url: string, contentType?: string, maxBytes?: number, fetchImpl?: typeof fetch, timeoutMs?: number, signal?: AbortSignal }} input
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
export async function downloadImageBuffer({ url, contentType, maxBytes = 8388608, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  let target
  try {
    target = new URL(String(url ?? ''))
  } catch {
    throw new ImageDownloadError('图片 URL 无效', { code: 'INVALID_URL' })
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new ImageDownloadError('图片 URL 协议不支持（仅 http/https）', { code: 'INVALID_URL' })
  }
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof fetchFn !== 'function') throw new ImageDownloadError('当前环境没有可用的 fetch', { code: 'NO_FETCH' })

  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 8388608
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = () => controller.abort()
  if (signal !== undefined && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })

  try {
    let response
    try {
      response = await fetchFn(target.href, { signal: controller.signal })
    } catch (error) {
      if (timedOut) throw new ImageDownloadError(`图片下载超时（${timeoutMs}ms）`, { code: 'TIMEOUT', cause: error })
      throw new ImageDownloadError(`图片下载失败：${error?.message ?? String(error)}`, { code: 'NETWORK', cause: error })
    }
    if (response.ok !== true) {
      throw new ImageDownloadError(`图片下载 HTTP ${response.status}`, { code: `HTTP_${response.status}` })
    }
    const declared = Number(response.headers?.get?.('content-length'))
    if (Number.isFinite(declared) && declared > limit) {
      throw new ImageDownloadError(`图片过大（${declared} > ${limit} 字节）`, { code: 'IMAGE_TOO_LARGE' })
    }
    let buffer
    try {
      buffer = Buffer.from(await response.arrayBuffer())
    } catch (error) {
      throw new ImageDownloadError(`读取图片数据失败：${error?.message ?? String(error)}`, { code: 'READ_ERROR', cause: error })
    }
    if (buffer.length === 0) throw new ImageDownloadError('图片内容为空', { code: 'EMPTY_IMAGE' })
    if (buffer.length > limit) throw new ImageDownloadError(`图片过大（${buffer.length} > ${limit} 字节）`, { code: 'IMAGE_TOO_LARGE' })

    const headerType = normalizeMimeType(response.headers?.get?.('content-type'))
    const attachmentType = normalizeMimeType(contentType)
    const sniffed = sniffImageMimeType(buffer)
    const mime = sniffed || headerType || attachmentType
    if (mime === '') throw new ImageDownloadError('下载内容不是支持的图片格式（jpg/png/gif/webp/bmp）', { code: 'UNSUPPORTED_IMAGE' })
    return { buffer, contentType: mime }
  } finally {
    clearTimeout(timer)
    if (signal !== undefined && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
  }
}
