/**
 * Outbound message sender: turns plain text / images / stickers into QQ API
 * calls, with Markdown cleanup, chunking and passive-reply window handling.
 *
 * QQ passive replies must reuse the inbound `msg_id` and increment `msg_seq`
 * for each reply; there is a per-window limit (group: 5 min / 5 replies,
 * c2c: 60 min / 4 replies). Once either limit is hit we switch to an active
 * message (no `msg_id`), which is not counted against the passive budget.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { chunkText, stripMarkdown } from '../util/text.js'
import { sha256Buffer } from '../util/fsx.js'

const DEFAULT_TEXT_CHUNK_SIZE = 800
const MAX_PASSIVE_TRACK = 1000
const MAX_FILE_INFO_CACHE = 100
const FILE_INFO_MIN_CACHE_MS = 60000

function deriveKind(chatId) {
  const value = String(chatId ?? '')
  if (value.startsWith('group_')) return 'group'
  if (value.startsWith('c2c_')) return 'c2c'
  return undefined
}

/**
 * Normalize a ChatRef into the `{ kind, targetId }` pair the QQ API needs.
 * Throws a Chinese error for invalid input instead of sending to a wrong path.
 */
export function chatTarget(chat) {
  if (chat === null || typeof chat !== 'object') throw new Error('无效的会话对象')
  const kind = chat.kind === 'group' ? 'group' : chat.kind === 'c2c' ? 'c2c' : deriveKind(chat.chatId)
  if (kind === undefined) throw new Error('无效的会话类型：需要 c2c 或 group')
  const targetId = typeof chat.targetId === 'string' ? chat.targetId.trim() : ''
  if (targetId === '') throw new Error('缺少发送目标 targetId')
  return { kind, targetId }
}

function extractId(response) {
  if (response === null || typeof response !== 'object') return undefined
  const candidate = response.id ?? response.message_id ?? response.msg_id ?? response.message?.id
  return candidate === undefined || candidate === null ? undefined : String(candidate)
}

export function createSender({ api, configStore, logger } = {}) {
  if (api === null || typeof api !== 'object' || typeof api.sendText !== 'function') {
    throw new Error('createSender 需要 QQ API 客户端')
  }
  const log = logger ?? { debug() {}, info() {}, warn() {}, error() {} }

  /** @type {Map<string, {count: number, expiresAt: number}>} */
  const passiveTracker = new Map()
  /** @type {Map<string, {fileInfo: string, expiresAt: number}>} */
  const fileInfoCache = new Map()
  const counters = { text: 0, image: 0, media: 0, sticker: 0, typing: 0, passive: 0, active: 0, failed: 0, uploaded: 0 }

  function config() {
    try {
      return configStore?.get?.() ?? {}
    } catch {
      return {}
    }
  }

  function replyLimits(kind) {
    const reply = config()?.qq?.reply ?? {}
    if (kind === 'group') {
      return {
        windowMs: Number(reply.groupWindowMs) > 0 ? Number(reply.groupWindowMs) : 300000,
        maxReplies: Math.max(1, Math.floor(Number(reply.groupMaxReplies)) || 5)
      }
    }
    return {
      windowMs: Number(reply.c2cWindowMs) > 0 ? Number(reply.c2cWindowMs) : 3600000,
      maxReplies: Math.max(1, Math.floor(Number(reply.c2cMaxReplies)) || 4)
    }
  }

  function prunePassive(now) {
    for (const [key, entry] of passiveTracker) {
      if (entry.expiresAt <= now) passiveTracker.delete(key)
    }
    while (passiveTracker.size > MAX_PASSIVE_TRACK) {
      passiveTracker.delete(passiveTracker.keys().next().value)
    }
  }

  /** Decide whether this particular reply may stay passive. */
  function replyState(target, replyTo, now) {
    if (replyTo === null || typeof replyTo !== 'object') return { allowed: false }
    const msgId = typeof replyTo.msgId === 'string' ? replyTo.msgId.trim() : ''
    if (msgId === '') return { allowed: false }
    const { windowMs, maxReplies } = replyLimits(target.kind)
    const receivedAtValue = Number(replyTo.receivedAt)
    const receivedAt = Number.isFinite(receivedAtValue) && receivedAtValue > 0 ? receivedAtValue : now
    if (now - receivedAt > windowMs) return { allowed: false, reason: 'window' }
    const key = `${target.kind}:${target.targetId}:${msgId}`
    const used = passiveTracker.get(key)?.count ?? 0
    if (used >= maxReplies) return { allowed: false, reason: 'limit' }
    return {
      allowed: true,
      key,
      msgId,
      msgSeq: used + 1,
      expiresAt: receivedAt + windowMs,
      maxReplies,
      used
    }
  }

  function markPassive(state) {
    const existing = passiveTracker.get(state.key)
    if (existing !== undefined) existing.count += 1
    else passiveTracker.set(state.key, { count: 1, expiresAt: state.expiresAt })
    counters.passive += 1
    prunePassive(Date.now())
  }

  /** Remember that a passive attempt failed so later chunks go active directly. */
  function burnPassive(state) {
    if (state?.key === undefined) return
    passiveTracker.set(state.key, { count: state.maxReplies, expiresAt: state.expiresAt })
    prunePassive(Date.now())
  }

  /** Send a text reply; returns `{ ids, passive }`. */
  async function sendText(chat, text, options = {}) {
    const target = chatTarget(chat)
    const replyTo = options?.replyTo
    const cleaned = stripMarkdown(text)
    if (cleaned === '') {
      log.debug?.('文本内容为空，跳过发送')
      return { ids: [], passive: false }
    }
    const chunkSize = Number(config()?.qq?.textChunkSize) > 0 ? Number(config().qq.textChunkSize) : DEFAULT_TEXT_CHUNK_SIZE
    const chunks = chunkText(cleaned, chunkSize)
    if (chunks.length === 0) return { ids: [], passive: false }

    const ids = []
    let usedPassive = false
    let lastError = null

    for (const chunk of chunks) {
      const now = Date.now()
      prunePassive(now)
      const state = replyState(target, replyTo, now)
      let response = null

      if (state.allowed) {
        try {
          response = await api.sendText({
            kind: target.kind,
            targetId: target.targetId,
            content: chunk,
            msgId: state.msgId,
            msgSeq: state.msgSeq,
            ...(typeof replyTo?.eventId === 'string' && replyTo.eventId !== '' ? { eventId: replyTo.eventId } : {})
          })
          markPassive(state)
          usedPassive = true
        } catch (error) {
          log.warn?.('被动回复失败，改为主动消息', { error: error?.message ?? String(error), code: error?.code })
          burnPassive(state)
          lastError = error
          response = null
        }
      }

      if (response === null) {
        try {
          response = await api.sendText({ kind: target.kind, targetId: target.targetId, content: chunk })
          counters.active += 1
        } catch (error) {
          counters.failed += 1
          lastError = error
          log.error?.('发送 QQ 文本消息失败', { error: error?.message ?? String(error), code: error?.code })
          continue
        }
      }

      counters.text += 1
      const id = extractId(response)
      if (id !== undefined) ids.push(id)
    }

    if (ids.length === 0 && lastError !== null) throw lastError
    return { ids, passive: usedPassive }
  }

  const FILE_TYPE_LABELS = Object.freeze({ 1: '图片', 2: '视频', 3: '语音', 4: '文件' })
  const FILE_TYPE_DEFAULTS = Object.freeze({
    1: { ext: 'jpg', prefix: 'image' },
    2: { ext: 'mp4', prefix: 'video' },
    3: { ext: 'mp3', prefix: 'voice' },
    4: { ext: 'bin', prefix: 'file' }
  })

  function normalizeFileType(value) {
    const number = Number(value)
    return [1, 2, 3, 4].includes(number) ? number : 1
  }

  function inferFileType(media, fallback = 1) {
    const kind = String(media?.kind ?? '').trim().toLowerCase()
    if (kind === 'image') return 1
    if (kind === 'video') return 2
    if (kind === 'audio') return 3
    const mime = String(media?.mime ?? '').toLowerCase()
    if (mime.startsWith('image/')) return 1
    if (mime.startsWith('video/')) return 2
    if (mime.startsWith('audio/')) return 3
    return normalizeFileType(fallback)
  }

  async function loadMedia(media, fileType) {
    const label = FILE_TYPE_LABELS[normalizeFileType(fileType)] ?? '媒体'
    if (media === null || typeof media !== 'object') throw new Error(`缺少${label}内容`)
    let buffer = null
    let sourceName = ''
    if (Buffer.isBuffer(media.buffer)) buffer = media.buffer
    else if (media.buffer instanceof Uint8Array) buffer = Buffer.from(media.buffer)
    if (buffer === null && typeof media.filePath === 'string' && media.filePath !== '') {
      try {
        buffer = await fsp.readFile(media.filePath)
      } catch (error) {
        throw new Error(`读取${label}失败：${error?.message ?? String(error)}`, { cause: error })
      }
      sourceName = path.basename(media.filePath)
    }
    if (buffer === null || buffer.length === 0) throw new Error(`${label}内容为空`)
    const explicitName = typeof media.fileName === 'string' && media.fileName !== '' ? media.fileName : ''
    const defaults = FILE_TYPE_DEFAULTS[normalizeFileType(fileType)] ?? FILE_TYPE_DEFAULTS[1]
    const fileName = explicitName !== '' ? explicitName : sourceName !== '' ? sourceName : `${defaults.prefix}-${Date.now()}.${defaults.ext}`
    return { buffer, fileName }
  }

  async function resolveFileInfo(target, { buffer, fileName }, fileType) {
    const fingerprint = sha256Buffer(buffer)
    const type = normalizeFileType(fileType)
    const cacheKey = `${target.kind}:${target.targetId}:${type}:${fingerprint}:${fileName}`
    const now = Date.now()
    const cached = fileInfoCache.get(cacheKey)
    if (cached !== undefined && cached.expiresAt > now) return cached.fileInfo
    const uploaded = await api.uploadMedia({ kind: target.kind, targetId: target.targetId, buffer, fileName, fileType: type })
    const fileInfo = typeof uploaded?.fileInfo === 'string' ? uploaded.fileInfo : ''
    if (fileInfo === '') throw new Error(`上传${FILE_TYPE_LABELS[type] ?? '媒体'}失败：QQ 接口未返回 file_info`)
    const ttl = Number(uploaded?.ttl) > 0 ? Number(uploaded.ttl) : 0
    const expiresAt = ttl > 60 ? now + ttl * 1000 - 60000 : now + FILE_INFO_MIN_CACHE_MS
    fileInfoCache.set(cacheKey, { fileInfo, expiresAt })
    counters.uploaded += 1
    while (fileInfoCache.size > MAX_FILE_INFO_CACHE) fileInfoCache.delete(fileInfoCache.keys().next().value)
    return fileInfo
  }

  async function sendMediaInternal(chat, media, options = {}) {
    const target = chatTarget(chat)
    const replyTo = options?.replyTo
    const fileType = normalizeFileType(options?.fileType ?? inferFileType(media))
    const label = FILE_TYPE_LABELS[fileType] ?? '媒体'
    const loaded = await loadMedia(media, fileType)
    const fileInfo = await resolveFileInfo(target, loaded, fileType)
    const now = Date.now()
    prunePassive(now)
    const state = replyState(target, replyTo, now)
    const sendFn = typeof api.sendMedia === 'function' ? api.sendMedia : api.sendImage
    const send = (passive) =>
      sendFn({
        kind: target.kind,
        targetId: target.targetId,
        fileInfo,
        ...(passive ? { msgId: state.msgId, msgSeq: state.msgSeq } : {}),
        ...(passive && typeof replyTo?.eventId === 'string' && replyTo.eventId !== '' ? { eventId: replyTo.eventId } : {})
      })

    let response = null
    if (state.allowed) {
      try {
        response = await send(true)
        markPassive(state)
      } catch (error) {
        log.warn?.(`被动回复${label}失败，改为主动消息`, { error: error?.message ?? String(error), code: error?.code })
        burnPassive(state)
        response = null
      }
    }
    if (response === null) {
      try {
        response = await send(false)
        counters.active += 1
      } catch (error) {
        counters.failed += 1
        log.error?.(`发送 QQ ${label}失败`, { error: error?.message ?? String(error), code: error?.code })
        throw error
      }
    }
    return { id: extractId(response) ?? null }
  }

  async function sendImage(chat, media, options = {}) {
    const result = await sendMediaInternal(chat, media, { ...options, fileType: 1 })
    counters.image += 1
    return result
  }

  /** Send an image / video / voice file (QQ rich media, msg_type 7). */
  async function sendMedia(chat, media, options = {}) {
    const result = await sendMediaInternal(chat, media, options)
    counters.media += 1
    return result
  }

  async function sendSticker(chat, sticker, options = {}) {
    if (sticker === null || typeof sticker !== 'object') throw new Error('缺少表情包信息')
    const filePath = typeof sticker.filePath === 'string' ? sticker.filePath : typeof sticker.path === 'string' ? sticker.path : ''
    if (filePath === '') throw new Error('缺少表情包文件路径')
    const ext = path.extname(filePath)
    const idPart = typeof sticker.id === 'string' && sticker.id !== '' ? sticker.id : path.basename(filePath, ext)
    const result = await sendMediaInternal(chat, { filePath, fileName: `sticker-${idPart}${ext !== '' ? ext : '.png'}` }, { ...options, fileType: 1 })
    counters.sticker += 1
    return result
  }

  async function sendTyping(chat) {
    try {
      const target = chatTarget(chat)
      if (target.kind !== 'c2c') return { ok: false, skipped: true }
      const response = await api.request({
        method: 'POST',
        path: `/v2/users/${encodeURIComponent(target.targetId)}/messages`,
        body: { msg_type: 6, content: '' }
      })
      counters.typing += 1
      return { ok: true, id: extractId(response) ?? null }
    } catch (error) {
      log.debug?.('发送输入状态失败（忽略）', { error: error?.message ?? String(error) })
      return { ok: false, error: error?.message ?? String(error) }
    }
  }

  function clearCache() {
    passiveTracker.clear()
    fileInfoCache.clear()
  }

  function stats() {
    return { ...counters }
  }

  return { sendText, sendImage, sendMedia, sendSticker, sendTyping, clearCache, stats }
}
