/**
 * Shared media attachment helpers used by the chat pipeline and the admin UI
 * markers. Kept dependency-free so both host modules and tools can import it.
 */
import { clampText, describeImageMarker } from './text.js'

const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|bmp)(?:[?#].*)?$/i
const AUDIO_EXT = /\.(?:wav|mp3|ogg|oga|silk|amr|m4a|aac|flac)(?:[?#].*)?$/i
const VIDEO_EXT = /\.(?:mp4|m4v|mov|webm|mkv)(?:[?#].*)?$/i

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function lower(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * Classify one inbound QQ attachment.
 * @returns {'image'|'audio'|'video'|'file'|'other'}
 */
export function classifyAttachment(attachment) {
  if (!isPlainObject(attachment)) return 'other'
  const type = lower(attachment.contentType)
  const name = `${String(attachment.filename ?? '')} ${String(attachment.url ?? '')}`.trim()
  if (type.startsWith('image/') || type === 'sticker' || IMAGE_EXT.test(name)) return 'image'
  if (type === 'voice' || type.startsWith('audio/') || typeof attachment.voiceWavUrl === 'string' && attachment.voiceWavUrl !== '' || AUDIO_EXT.test(name)) {
    return 'audio'
  }
  if (type.startsWith('video/') || VIDEO_EXT.test(name)) return 'video'
  if (type === 'file') return 'file'
  return 'other'
}

/** Preferred download URL for media attachments (QQ voices expose a WAV URL). */
export function mediaDownloadUrl(attachment) {
  if (!isPlainObject(attachment)) return ''
  if (classifyAttachment(attachment) === 'audio' && typeof attachment.voiceWavUrl === 'string' && attachment.voiceWavUrl !== '') {
    return attachment.voiceWavUrl
  }
  return typeof attachment.url === 'string' ? attachment.url : ''
}

/** QQ supplies an ASR hint for some voice messages. */
export function attachmentAsrText(attachment) {
  if (!isPlainObject(attachment)) return ''
  return typeof attachment.asrReferText === 'string' ? attachment.asrReferText.trim() : ''
}

/** Short, model-readable marker for one attachment (no recognition content). */
export function describeMediaMarker(attachment) {
  const kind = classifyAttachment(attachment)
  if (kind === 'image') return describeImageMarker(attachment)
  if (kind === 'audio') return '[语音]'
  if (kind === 'video') {
    const type = lower(attachment?.contentType)
    return type.startsWith('video/') ? `[视频 ${type}]` : '[视频]'
  }
  if (kind === 'file') return '[文件]'
  return '[附件]'
}

const CONTENT_LABELS = {
  image: '图片内容',
  audio: '语音内容',
  video: '视频内容'
}

/**
 * Marker plus the recognizer's text, e.g.
 * `[图片 800×600 image/jpeg]（图片内容：一只橘猫）`.
 */
export function describeMediaWithText(attachment, text) {
  const marker = describeMediaMarker(attachment)
  const kind = classifyAttachment(attachment)
  const label = CONTENT_LABELS[kind]
  const content = clampText(String(text ?? '').trim(), 240)
  if (content === '' || label === undefined) return marker
  return `${marker}（${label}：${content}）`
}
