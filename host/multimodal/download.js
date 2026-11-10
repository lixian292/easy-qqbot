/**
 * Download one inbound QQ media attachment (image / voice / video) and detect
 * its real container format from magic bytes.
 *
 * QQ media URLs are short-lived signed links, so every failure is a typed
 * `MediaDownloadError` that the caller can log and skip. No network access
 * happens here beyond the injected `fetchImpl` / global `fetch`.
 */
import { MultimodalError, shortMessage } from './errors.js'

const DEFAULT_TIMEOUT_MS = 20000
const DEFAULT_MAX_BYTES = 16777216

/** MIME types this module is able to recognise and hand to the recognizer. */
export const SUPPORTED_MEDIA_MIMES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'audio/wav',
  'audio/mpeg',
  'audio/ogg',
  'video/mp4'
])

const SUPPORTED_MEDIA_MIME_SET = new Set(SUPPORTED_MEDIA_MIMES)

export class MediaDownloadError extends MultimodalError {
  constructor(message, { code = 'MEDIA_DOWNLOAD_ERROR', cause } = {}) {
    super(message, { code, cause })
    this.name = 'MediaDownloadError'
  }
}

/** Normalize a Content-Type header / attachment content type to a supported MIME. */
export function normalizeMediaContentType(contentType) {
  const raw = String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (raw === '') return ''
  if (raw === 'image/jpg' || raw === 'image/pjpeg') return 'image/jpeg'
  if (raw === 'image/x-png' || raw === 'image/apng') return 'image/png'
  if (raw === 'image/x-ms-bmp') return 'image/bmp'
  if (raw === 'audio/x-wav' || raw === 'audio/wave' || raw === 'audio/vnd.wave') return 'audio/wav'
  if (raw === 'audio/mp3' || raw === 'audio/x-mpeg' || raw === 'audio/x-mp3') return 'audio/mpeg'
  if (raw === 'audio/x-ogg' || raw === 'application/ogg') return 'audio/ogg'
  if (raw === 'video/mp4v-es') return 'video/mp4'
  return SUPPORTED_MEDIA_MIME_SET.has(raw) ? raw : ''
}

/**
 * Detect the media MIME type from magic bytes; falls back to the supplied hint
 * (a Content-Type header or attachment `contentType`).
 *
 * @param {Buffer} buffer
 * @param {string} [hintContentType]
 * @returns {string} one of SUPPORTED_MEDIA_MIMES or '' when unknown
 */
export function sniffMediaMimeType(buffer, hintContentType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return ''
  const hint = normalizeMediaContentType(hintContentType)

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF') {
    const form = buffer.toString('ascii', 8, 12)
    if (form === 'WEBP') return 'image/webp'
    if (form === 'WAVE') return 'audio/wav'
  }
  // ID3v2 tagged MP3, then a raw MPEG audio frame sync (e.g. FF FB / FF F3).
  if (buffer.length >= 3 && buffer.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg'
  if (
    buffer.length >= 2 &&
    buffer[0] === 0xff &&
    (buffer[1] & 0xe0) === 0xe0 &&
    (buffer[1] & 0x18) !== 0x08 && // reserved MPEG version
    (buffer[1] & 0x06) !== 0x00 // reserved layer
  ) {
    return 'audio/mpeg'
  }
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg'
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4'

  return hint
}

function positiveNumber(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function contentLength(response) {
  const declared = Number(response?.headers?.get?.('content-length'))
  return Number.isFinite(declared) && declared > 0 ? declared : undefined
}

/**
 * Download a remote image/audio/video buffer.
 *
 * @param {{
 *   url: string,
 *   contentType?: string,
 *   maxBytes?: number,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   signal?: AbortSignal
 * }} input
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
export async function downloadMediaBuffer({
  url,
  contentType,
  maxBytes = DEFAULT_MAX_BYTES,
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal
} = {}) {
  let target
  try {
    target = new URL(String(url ?? '').trim())
  } catch {
    throw new MediaDownloadError('媒体 URL 无效', { code: 'INVALID_URL' })
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new MediaDownloadError('媒体 URL 协议不支持（仅 http/https）', { code: 'INVALID_URL' })
  }

  const limit = positiveNumber(maxBytes, DEFAULT_MAX_BYTES)
  const totalTimeoutMs = positiveNumber(timeoutMs, DEFAULT_TIMEOUT_MS)
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof fetchFn !== 'function') throw new MediaDownloadError('当前环境没有可用的 fetch', { code: 'NO_FETCH' })

  if (signal !== undefined && signal !== null && signal.aborted === true) {
    throw new MediaDownloadError('媒体下载已取消', { code: 'ABORTED' })
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, totalTimeoutMs)
  const onAbort = () => controller.abort()
  const externalSignal = signal !== undefined && signal !== null && typeof signal.addEventListener === 'function'
  if (externalSignal) signal.addEventListener('abort', onAbort, { once: true })

  try {
    let response
    try {
      response = await fetchFn(target.href, { signal: controller.signal })
    } catch (error) {
      if (timedOut) {
        throw new MediaDownloadError(`媒体下载超时（${totalTimeoutMs}ms）`, { code: 'TIMEOUT', cause: error })
      }
      if (signal?.aborted === true) {
        throw new MediaDownloadError('媒体下载已取消', { code: 'ABORTED', cause: error })
      }
      throw new MediaDownloadError(`媒体下载失败：${shortMessage(error?.message ?? String(error), 200)}`, {
        code: 'NETWORK',
        cause: error
      })
    }

    if (response === null || typeof response !== 'object' || response.ok !== true) {
      const status = Number(response?.status)
      throw new MediaDownloadError(`媒体下载 HTTP ${Number.isFinite(status) ? status : '未知'}`, {
        code: `HTTP_${Number.isFinite(status) ? status : 'UNKNOWN'}`
      })
    }

    const declared = contentLength(response)
    if (declared !== undefined && declared > limit) {
      throw new MediaDownloadError(`媒体文件过大（${declared} > ${limit} 字节）`, { code: 'MEDIA_TOO_LARGE' })
    }

    let buffer
    try {
      buffer = Buffer.from(await response.arrayBuffer())
    } catch (error) {
      if (timedOut) {
        throw new MediaDownloadError(`媒体下载超时（${totalTimeoutMs}ms）`, { code: 'TIMEOUT', cause: error })
      }
      throw new MediaDownloadError(`读取媒体数据失败：${shortMessage(error?.message ?? String(error), 200)}`, {
        code: 'READ_ERROR',
        cause: error
      })
    }
    if (timedOut) throw new MediaDownloadError(`媒体下载超时（${totalTimeoutMs}ms）`, { code: 'TIMEOUT' })
    if (signal?.aborted === true) throw new MediaDownloadError('媒体下载已取消', { code: 'ABORTED' })
    if (buffer.length === 0) throw new MediaDownloadError('媒体内容为空', { code: 'EMPTY_MEDIA' })
    if (buffer.length > limit) {
      throw new MediaDownloadError(`媒体文件过大（${buffer.length} > ${limit} 字节）`, { code: 'MEDIA_TOO_LARGE' })
    }

    const headerType = response.headers?.get?.('content-type')
    const mime = sniffMediaMimeType(buffer, headerType ?? contentType)
    if (mime === '') {
      throw new MediaDownloadError('下载内容不是支持的媒体格式（图片/音频/视频）', { code: 'UNSUPPORTED_MEDIA' })
    }
    return { buffer, contentType: mime }
  } finally {
    clearTimeout(timer)
    if (externalSignal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
  }
}
