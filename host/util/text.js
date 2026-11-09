/** Text helpers shared by prompt assembly, reply rendering and command parsing. */

export function clampText(text, maxChars) {
  const value = String(text ?? '')
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`
}

/**
 * Cheap token estimate used for budget/compression decisions. It does not need
 * to be exact: Chinese characters cost about one token, Latin text about a
 * quarter token per character. We mix both with a conservative factor.
 */
export function estimateTokens(text) {
  const value = String(text ?? '')
  if (value === '') return 0
  let cjk = 0
  let other = 0
  for (const char of value) {
    const code = char.codePointAt(0)
    if (code >= 0x2e80) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk * 1.0 + other * 0.3)
}

export function estimateMessagesTokens(messages) {
  let total = 0
  for (const message of Array.isArray(messages) ? messages : []) {
    if (typeof message?.content === 'string') total += estimateTokens(message.content)
    else if (Array.isArray(message?.content)) {
      for (const block of message.content) {
        if (block?.type === 'text') total += estimateTokens(block.text)
      }
    }
  }
  return total
}

/** Split a long reply into QQ-sized chunks, preferring paragraph/punctuation boundaries. */
export function chunkText(text, maxChars = 800) {
  const value = String(text ?? '').trim()
  if (value === '') return []
  const limit = Math.max(50, Math.floor(maxChars))
  const chunks = []
  let rest = value
  while (rest.length > 0) {
    if (rest.length <= limit) {
      chunks.push(rest)
      break
    }
    let cut = -1
    const window = rest.slice(0, limit)
    for (const mark of ['\n\n', '\n', '。', '！', '？', '. ', '! ', '? ', '；', ';', '，', ', ', ' ']) {
      const index = window.lastIndexOf(mark)
      if (index > limit * 0.4) {
        cut = index + mark.length
        break
      }
    }
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  return chunks.filter((chunk) => chunk !== '')
}

/** Strip Markdown that does not render in plain QQ text messages. */
export function stripMarkdown(text) {
  let value = String(text ?? '')
  value = value.replace(/```[a-zA-Z0-9_-]*\n?/g, '')
  value = value.replace(/^#{1,6}\s+/gm, '')
  value = value.replace(/^\s*>\s?/gm, '')
  value = value.replace(/\*\*([^*]+)\*\*/g, '$1')
  value = value.replace(/\*([^*]+)\*/g, '$1')
  value = value.replace(/__([^_]+)__/g, '$1')
  value = value.replace(/`([^`]+)`/g, '$1')
  value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
  value = value.replace(/\n{3,}/g, '\n\n')
  return value.trim()
}

const STICKER_DIRECTIVE = /\[\[\s*(?:sticker|表情|贴纸|sticker:)\s*[:：]?\s*([^\]\n]{1,160})\]\]/gi

/**
 * Extract sticker directives from model output.
 * Supported forms: [[sticker: 无语, 敷衍]] / [[表情：疑惑]] / [[sticker:无语|敷衍]]
 * @returns {{ text: string, requests: string[][] }}
 */
export function parseStickerDirectives(text) {
  const source = String(text ?? '')
  const requests = []
  const cleaned = source.replace(STICKER_DIRECTIVE, (_match, body) => {
    const tags = normalizeTags(body)
    if (tags.length > 0) requests.push(tags)
    return ''
  })
  return { text: cleaned.trim(), requests }
}

/** Normalize a tag input (array or delimited string) into a clean unique list. */
export function normalizeTags(input, { maxTags = 20, maxTagLength = 24 } = {}) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,，、;；|/]+|\s{2,}|[\n\r]+/)
  const out = []
  const seen = new Set()
  for (const candidate of raw) {
    const tag = String(candidate ?? '').trim().replace(/^#+/, '').slice(0, maxTagLength)
    if (tag === '') continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= maxTags) break
  }
  return out
}

export function mergeTags(...lists) {
  return normalizeTags(lists.flat())
}

/** Detect a bot command such as `#表情 无语`, `/帮助`, `／预算`. */
export function parseCommand(text, { prefixes = ['#', '/', '／'] } = {}) {
  const value = String(text ?? '').trim()
  if (value === '') return undefined
  for (const prefix of prefixes) {
    if (!value.startsWith(prefix)) continue
    const body = value.slice(prefix.length).trim()
    if (body === '') continue
    const match = body.match(/^(\S+)\s*([\s\S]*)$/)
    if (match === null) continue
    return { name: match[1].toLowerCase(), args: match[2].trim(), raw: value }
  }
  return undefined
}

export function escapeRegExp(text) {
  return String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function formatDateTime(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatDate(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function formatMonth(value = Date.now()) {
  return formatDate(value).slice(0, 7)
}

/** Hide most of a secret for API responses/logs. */
export function maskSecret(secret) {
  const value = String(secret ?? '')
  if (value === '') return ''
  if (value.length <= 8) return '*'.repeat(value.length)
  return `${value.slice(0, 4)}${'*'.repeat(Math.min(16, value.length - 8))}${value.slice(-4)}`
}

/** Extract the first N characters of a title-ish text without breaking surrogate pairs. */
export function shortTitle(text, maxChars = 24) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value.length <= maxChars) return value
  return `${Array.from(value).slice(0, maxChars).join('')}…`
}

export function isLikelyImageContentType(contentType) {
  const value = String(contentType ?? '').toLowerCase()
  return value.startsWith('image/') || value === 'sticker'
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

function decodeHtmlEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Decode the base64 JSON payload QQ attaches to a market-face element. */
function decodeFaceExt(ext) {
  if (typeof ext !== 'string' || ext.trim() === '') return ''
  try {
    const parsed = JSON.parse(Buffer.from(ext.trim(), 'base64').toString('utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.text === 'string' && parsed.text.trim() !== '') {
      return parsed.text.trim().slice(0, 40)
    }
  } catch {
    // A malformed face payload is not worth failing the message over.
  }
  return ''
}

/**
 * Turn QQ's protocol-ish message text into clean, model-readable text.
 *
 * QQ may inline elements such as `<faceType=6,faceId="0",ext="...">` for
 * stickers/faces, plus HTML entities and other angle-bracket tags. A text-only
 * model cannot interpret those, so they become short `[QQ表情]` markers and the
 * remaining tags are stripped. URL query strings are unaffected.
 */
export function cleanQqText(text) {
  let value = typeof text === 'string' ? text : String(text ?? '')
  value = value.replace(
    /<faceType\s*=\s*"?([^",>]*)"?(?:\s*,\s*faceId\s*=\s*"?([^",>]*)"?)?(?:\s*,\s*ext\s*=\s*"([^"]*)")?\s*\/?>/gi,
    (_match, faceType, faceId, ext) => {
      const decoded = decodeFaceExt(ext)
      if (decoded !== '') return `[QQ表情: ${decoded}]`
      const id = String(faceId ?? faceType ?? '').trim()
      return id !== '' ? `[QQ表情 ${id}]` : '[QQ表情]'
    }
  )
  value = value.replace(/<(?:mface|bface|sface|face|rps|dice)\b[^>]*>/gi, '[QQ表情]')
  value = value.replace(/<[^>]+>/g, '')
  value = decodeHtmlEntities(value)
  value = value.replace(/[ \t\u00a0]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return value
}

/**
 * Human/LLM-readable marker for one inbound image attachment. The plugin does
 * not perform vision inference, so size + media type are the only facts the
 * text-only model can be given.
 */
export function describeImageMarker(attachment) {
  const width = Number(attachment?.width)
  const height = Number(attachment?.height)
  const size = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? `${Math.round(width)}×${Math.round(height)}` : ''
  let kind = typeof attachment?.contentType === 'string' ? attachment.contentType.trim() : ''
  if (kind === '') {
    const match = String(attachment?.filename ?? '').match(/\.([a-z0-9]{2,5})$/i)
    if (match !== null) kind = match[1].toLowerCase()
  }
  const parts = []
  if (size !== '') parts.push(size)
  if (kind !== '') parts.push(kind)
  return parts.length > 0 ? `[图片 ${parts.join(' ')}]` : '[图片]'
}

