/**
 * Normalize QQ gateway dispatch payloads into qqbot's internal event shapes.
 *
 * The gateway hands us `{ t, d, s, id }` for every op 0 dispatch. Message
 * events become `InboundMessage`, known system events become `SystemEvent`
 * and everything else (READY/RESUMED/unknown) becomes `null`.
 */
import { cleanQqText } from '../util/text.js'

const MESSAGE_TYPES = Object.freeze({
  C2C_MESSAGE_CREATE: 'c2c',
  GROUP_AT_MESSAGE_CREATE: 'group'
})

const SYSTEM_EVENT_TYPES = new Set([
  'FRIEND_ADD',
  'FRIEND_DEL',
  'C2C_MSG_REJECT',
  'C2C_MSG_RECEIVE',
  'GROUP_ADD_ROBOT',
  'GROUP_DEL_ROBOT',
  'GROUP_MSG_REJECT',
  'GROUP_MSG_RECEIVE'
])

const SYSTEM_EVENT_PREFIXES = ['FRIEND_', 'C2C_MSG_', 'GROUP_MSG_']

const VALID_MEMBER_ROLES = new Set(['member', 'admin', 'owner'])

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

function normalizeText(value) {
  return typeof value === 'string' ? cleanQqText(value) : ''
}

function normalizeTimestamp(value, fallback = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? Math.round(numeric) : Math.round(numeric * 1000)
  }
  return fallback
}

function normalizeRole(value) {
  if (typeof value !== 'string') return undefined
  const role = value.trim().toLowerCase()
  if (role === '') return undefined
  if (VALID_MEMBER_ROLES.has(role)) return role
  if (role === 'administrator') return 'admin'
  if (role === 'group_owner') return 'owner'
  return undefined
}

function normalizeAttachments(list) {
  if (!Array.isArray(list)) return []
  const attachments = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const url = firstString(item.url)
    // QQ voice messages expose the playable WAV through `voice_wav_url`; keep
    // the attachment when either the raw url or the WAV url is present.
    const voiceWavUrl = firstString(item.voice_wav_url, item.voiceWavUrl)
    if (url === '' && voiceWavUrl === '') continue
    const attachment = { url }
    const contentType = firstString(item.content_type, item.contentType)
    if (contentType !== '') attachment.contentType = contentType
    const filename = firstString(item.filename, item.file_name)
    if (filename !== '') attachment.filename = filename
    const width = Number(item.width)
    if (Number.isFinite(width) && width > 0) attachment.width = width
    const height = Number(item.height)
    if (Number.isFinite(height) && height > 0) attachment.height = height
    const size = Number(item.size)
    if (Number.isFinite(size) && size > 0) attachment.size = size
    if (voiceWavUrl !== '') attachment.voiceWavUrl = voiceWavUrl
    const asrReferText = firstString(item.asr_refer_text, item.asrReferText)
    if (asrReferText !== '') attachment.asrReferText = asrReferText
    attachments.push(attachment)
  }
  return attachments
}

function userNameOf(author) {
  return firstString(author.username, author.nick, author.name, author.nickname)
}

function normalizeC2C(data, author, eventId) {
  const userId = firstString(author.user_openid, author.id, data.user_openid)
  if (userId === '') return null
  const timestamp = normalizeTimestamp(data.timestamp, Date.now())
  const msgId = firstString(data.id, eventId, `c2c-${timestamp}-${userId}`)
  const message = {
    kind: 'c2c',
    chatId: `c2c_${userId}`,
    targetId: userId,
    userId,
    text: normalizeText(data.content),
    msgId,
    timestamp,
    attachments: normalizeAttachments(data.attachments),
    rawType: 'C2C_MESSAGE_CREATE'
  }
  const userName = userNameOf(author)
  if (userName !== '') message.userName = userName
  if (eventId !== '') message.eventId = eventId
  return message
}

function normalizeGroup(data, author, eventId) {
  const groupId = firstString(data.group_openid, data.group_id)
  const userId = firstString(author.member_openid, author.id, author.user_openid)
  if (groupId === '' || userId === '') return null
  const timestamp = normalizeTimestamp(data.timestamp, Date.now())
  const msgId = firstString(data.id, eventId, `group-${timestamp}-${userId}`)
  const message = {
    kind: 'group',
    chatId: `group_${groupId}`,
    targetId: groupId,
    userId,
    text: normalizeText(data.content),
    msgId,
    timestamp,
    attachments: normalizeAttachments(data.attachments),
    rawType: 'GROUP_AT_MESSAGE_CREATE'
  }
  const userName = userNameOf(author)
  if (userName !== '') message.userName = userName
  if (eventId !== '') message.eventId = eventId
  const memberRole = normalizeRole(author.member_role)
  if (memberRole !== undefined) message.memberRole = memberRole
  return message
}

function isSystemEvent(type) {
  if (SYSTEM_EVENT_TYPES.has(type)) return true
  for (const prefix of SYSTEM_EVENT_PREFIXES) {
    if (type.startsWith(prefix)) return true
  }
  return false
}

/**
 * @param {string} t dispatch event type (`payload.t`)
 * @param {object|null} d dispatch data (`payload.d`)
 * @param {{ id?: string, s?: number }} [meta] outer dispatch info (optional)
 * @returns {object | null} InboundMessage | SystemEvent | null
 */
export function normalizeDispatch(t, d, meta = {}) {
  const type = typeof t === 'string' ? t : ''
  if (type === '') return null
  const data = d !== null && typeof d === 'object' ? d : null
  const eventId = firstString(meta?.id)

  if (MESSAGE_TYPES[type] !== undefined) {
    if (data === null) return null
    const author = data.author !== null && typeof data.author === 'object' ? data.author : {}
    return type === 'C2C_MESSAGE_CREATE' ? normalizeC2C(data, author, eventId) : normalizeGroup(data, author, eventId)
  }

  if (isSystemEvent(type)) {
    return {
      kind: 'system',
      type,
      timestamp: normalizeTimestamp(data?.timestamp, Date.now()),
      data
    }
  }

  return null
}

/**
 * Bounded LRU-ish seen-set for dispatch ids. `seen(key)` returns false the
 * first time a key is observed and true for every repeat.
 */
export function createEventDedupe({ maxSize = 500 } = {}) {
  const limit = Math.max(1, Math.floor(Number(maxSize) || 500))
  const seenKeys = new Map()

  function remember(key) {
    seenKeys.set(key, true)
    while (seenKeys.size > limit) {
      const oldest = seenKeys.keys().next().value
      seenKeys.delete(oldest)
    }
  }

  function seen(key) {
    if (typeof key !== 'string' || key === '') return false
    if (seenKeys.has(key)) {
      // Refresh LRU position.
      seenKeys.delete(key)
      seenKeys.set(key, true)
      return true
    }
    remember(key)
    return false
  }

  return { seen }
}
