/**
 * Media helpers for generated assets: container sniffing, file extensions and
 * the QQ rich-media file_type mapping.
 *
 * Generation providers are inconsistent: some answer with an OpenAI-style
 * `b64_json`, some with a temporary URL, some with `audio/mpeg` bytes and some
 * with an unhelpful `application/octet-stream`. We therefore sniff magic bytes
 * first and only fall back to the response Content-Type / requested format.
 */
import { sniffMediaMimeType } from '../multimodal/download.js'

const KIND_PREFIX = Object.freeze({ image: 'image/', audio: 'audio/', video: 'video/' })

const EXT_BY_MIME = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov'
})

const FORMAT_MIME = Object.freeze({
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  webp: 'image/webp'
})

/** Extensions QQ accepts for each rich-media kind (used for friendlier errors). */
const QQ_MIME_ALLOW = Object.freeze({
  image: new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']),
  audio: new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg']),
  video: new Set(['video/mp4'])
})

const QQ_FILE_TYPE = Object.freeze({ image: 1, video: 2, audio: 3 })

function headerHint(hint) {
  return String(hint ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
}

function extraSniff(buffer, kind) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return ''
  const brand = buffer.length >= 12 ? buffer.toString('ascii', 8, 12) : ''
  if (buffer.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac'
  // ADTS AAC: 12-bit sync 0xFFF with layer bits 00 (MP3 detection excludes it).
  if (buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0) return 'audio/aac'
  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    if (kind === 'audio' && (brand === 'M4A ' || brand === 'M4B ' || brand === 'mp42')) return 'audio/mp4'
    if (brand === 'qt  ') return 'video/quicktime'
    if (kind === 'video') return 'video/mp4'
  }
  // WebM / Matroska share the EBML header; WebM is the only sendable variant.
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return kind === 'video' ? 'video/webm' : ''
  }
  return ''
}

/**
 * Detect the MIME of a generated asset.
 *
 * @param {Buffer} buffer
 * @param {'image'|'audio'|'video'} kind
 * @param {string} [hint] response content-type or requested format
 * @returns {string} MIME or '' when unknown
 */
export function sniffGeneratedMime(buffer, kind, hint = '') {
  const headerType = headerHint(hint)
  const sniffed = sniffMediaMimeType(buffer, headerType)
  // `sniffMediaMimeType` reports every ISO-BMFF file as video/mp4; for audio
  // results an explicit audio Content-Type is more trustworthy.
  if (kind === 'audio' && sniffed === 'video/mp4' && headerType.startsWith('audio/')) return headerType
  if (sniffed !== '') return sniffed
  const extra = extraSniff(buffer, kind)
  if (extra !== '') return extra
  const formatMime = FORMAT_MIME[headerType]
  if (formatMime !== undefined) return formatMime
  if (headerType.startsWith(KIND_PREFIX[kind])) return headerType
  return ''
}

export function extensionForMime(mime, fallback = 'bin') {
  return EXT_BY_MIME[String(mime ?? '').toLowerCase()] ?? fallback
}

export function mimeForFormat(format) {
  return FORMAT_MIME[String(format ?? '').toLowerCase()] ?? ''
}

export function kindOfMime(mime) {
  const value = String(mime ?? '').toLowerCase()
  if (value.startsWith('image/')) return 'image'
  if (value.startsWith('audio/')) return 'audio'
  if (value.startsWith('video/')) return 'video'
  return ''
}

/** QQ upload `file_type`: 1 image, 2 video, 3 voice. */
export function qqFileType(kind) {
  return QQ_FILE_TYPE[kind] ?? 0
}

/**
 * Whether the generated container can be handed to QQ rich media as-is.
 * There is no transcoder in this plugin, so unsupported containers fall back
 * to a text notice instead of uploading bytes QQ will reject.
 */
export function canSendToQQ(kind, mime) {
  const allowed = QQ_MIME_ALLOW[kind]
  if (allowed === undefined) return false
  return allowed.has(String(mime ?? '').toLowerCase())
}

/** Normalize a `data:*;base64,` prefix or bare base64 payload. */
export function decodeBase64Payload(value) {
  const text = String(value ?? '').trim()
  if (text === '') return Buffer.alloc(0)
  const comma = text.indexOf(',')
  const payload = text.startsWith('data:') && comma >= 0 ? text.slice(comma + 1) : text
  const compact = payload.replace(/\s+/g, '')
  if (compact === '' || !/^[A-Za-z0-9+/=_-]+$/.test(compact)) return Buffer.alloc(0)
  try {
    return Buffer.from(compact, 'base64')
  } catch {
    return Buffer.alloc(0)
  }
}
