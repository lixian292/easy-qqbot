/**
 * Chat engine: the main per-message pipeline.
 *
 *   handleInbound(inbound)
 *     1. local commands
 *     2. inbound images -> sticker candidate capture
 *     3. budget check
 *     4. append the user message to memory
 *     5. optional context compression
 *     6. prompt assembly
 *     7. LLM call (+ budget record / fallback message)
 *     8. sticker directive parsing + markdown cleanup + truncation
 *     9. send text then sticker
 *    10. append the assistant message
 *    11. async long-term memory extraction
 *
 * Messages of the same chat are serialized through one promise chain and
 * `handleInbound` never rejects: every failure is logged and (when possible)
 * answered with a short Chinese fallback.
 */
import { buildMessages, buildSystemPrompt } from './prompt.js'
import { clampText, describeImageMarker, isLikelyImageContentType, parseStickerDirectives, stripMarkdown } from '../util/text.js'

const ERROR_FALLBACK = '我这边刚刚走神了，再说一次？'
const EMPTY_REPLY_FALLBACK = '嗯嗯～'
const DEFAULT_BLOCK_MESSAGE = '今天的聊天额度已经用完啦，明天再来找我吧～'
const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp|bmp)(?:[?#].*)?$/i

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function isImageAttachment(attachment) {
  if (!isPlainObject(attachment)) return false
  if (isLikelyImageContentType(attachment.contentType)) return true
  if (typeof attachment.contentType === 'string' && attachment.contentType !== '') return false
  return IMAGE_EXT_RE.test(String(attachment.filename ?? attachment.url ?? ''))
}

/**
 * @param {{
 *   configStore: { get(): object },
 *   personaStore?: object,
 *   memoryStore?: object,
 *   budgetStore?: object,
 *   llmClient?: object,
 *   compressor?: object,
 *   extractor?: object,
 *   stickerStore?: object,
 *   stickerSelector?: object,
 *   commandHandler?: object,
 *   qqClient?: object,
 *   logger?: object,
 *   captureIncomingImage?: (attachment: object, inbound: object) => Promise<unknown>,
 *   describeIncomingImage?: (attachment: object, inbound: object) => Promise<string|undefined>
 * }} deps
 */
export function createChatEngine({
  configStore,
  personaStore,
  memoryStore,
  budgetStore,
  llmClient,
  compressor,
  extractor,
  stickerStore,
  stickerSelector,
  commandHandler,
  qqClient,
  logger,
  captureIncomingImage,
  describeIncomingImage
} = {}) {
  const queues = new Map()
  const blockNoticedAt = new Map()

  function readConfig() {
    try {
      const config = configStore?.get?.() ?? {}
      return isPlainObject(config) ? config : {}
    } catch (error) {
      logger?.warn?.('读取聊天配置失败，使用默认值', { error: error?.message })
      return {}
    }
  }

  function resolveChatId(inbound) {
    if (typeof inbound?.chatId === 'string' && inbound.chatId !== '') return inbound.chatId
    const kind = inbound?.kind
    const target = typeof inbound?.targetId === 'string' ? inbound.targetId : typeof inbound?.userId === 'string' ? inbound.userId : ''
    if (target === '') return ''
    return `${kind === 'group' ? 'group' : 'c2c'}_${target}`
  }

  function enqueue(chatId, task) {
    const previous = queues.get(chatId) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(() => undefined, () => undefined)
    queues.set(chatId, tail)
    tail.then(() => {
      if (queues.get(chatId) === tail) queues.delete(chatId)
    })
    return run
  }

  function chatRef(inbound) {
    return { kind: inbound.kind, targetId: inbound.targetId, chatId: inbound.chatId }
  }

  function replyRef(inbound) {
    return {
      msgId: inbound?.msgId,
      receivedAt: inbound?.timestamp,
      kind: inbound?.kind
    }
  }

  async function sendText(inbound, text) {
    if (typeof text !== 'string' || text.trim() === '') return false
    if (typeof qqClient?.sendText !== 'function') {
      logger?.warn?.('QQ 客户端不可用，跳过发送文本', { chatId: inbound?.chatId })
      return false
    }
    try {
      await qqClient.sendText(chatRef(inbound), text, { replyTo: replyRef(inbound) })
      return true
    } catch (error) {
      logger?.warn?.('发送文本失败', { chatId: inbound?.chatId, error: error?.message })
      return false
    }
  }

  async function sendSticker(inbound, sticker) {
    if (!sticker) return false
    if (typeof qqClient?.sendSticker !== 'function') {
      logger?.warn?.('QQ 客户端不支持发送表情包', { chatId: inbound?.chatId })
      return false
    }
    // The sender layer has no sticker store: resolve the on-disk path here and
    // pass the `{ filePath, id }` media shape required by INTERFACES §15.
    let filePath = ''
    try {
      if (typeof stickerStore?.filePath === 'function') filePath = String(stickerStore.filePath(sticker) ?? '')
    } catch (error) {
      logger?.warn?.('解析表情包文件路径失败', { chatId: inbound?.chatId, stickerId: sticker?.id, error: error?.message })
    }
    if (filePath === '' && typeof sticker?.filePath === 'string') filePath = sticker.filePath
    const media = { filePath, id: sticker?.id }
    try {
      await qqClient.sendSticker(chatRef(inbound), media, { replyTo: replyRef(inbound) })
      try {
        const used = stickerStore?.recordUse?.(sticker.id)
        if (used && typeof used.catch === 'function') used.catch(() => {})
      } catch {
        // usage statistics are best effort only
      }
      return true
    } catch (error) {
      logger?.warn?.('发送表情包失败，已降级为纯文字', { chatId: inbound?.chatId, stickerId: sticker?.id, error: error?.message })
      return false
    }
  }

  async function appendMessageSafe(chatId, message) {
    if (typeof memoryStore?.appendMessage !== 'function') return
    try {
      await memoryStore.appendMessage(chatId, message)
    } catch (error) {
      logger?.warn?.('写入会话消息失败', { chatId, error: error?.message })
    }
  }

  async function resolvePersona(inbound, chatId, config) {
    if (typeof personaStore?.resolve === 'function') {
      try {
        return await personaStore.resolve({ chatId, userId: inbound.userId, kind: inbound.kind })
      } catch (error) {
        logger?.warn?.('解析人设失败，使用全局默认', { chatId, error: error?.message })
      }
    }
    const base = isPlainObject(config.persona) ? config.persona : {}
    return {
      name: base.name ?? '小Q',
      systemPrompt: base.systemPrompt ?? '',
      style: base.style ?? '',
      replyMaxChars: Number(base.replyMaxChars) || 800,
      stickerChance: Number(base.stickerChance) || 0,
      memoryEnabled: base.memoryEnabled !== false,
      compressEnabled: base.compressEnabled !== false,
      maxHistoryMessages: Number(base.maxHistoryMessages) || 40,
      model: config.llm?.model,
      temperature: config.llm?.temperature
    }
  }

  /** Image attachments of an inbound message (ignores files/voice/etc.). */
  function inboundImages(inbound) {
    const attachments = Array.isArray(inbound?.attachments) ? inbound.attachments : []
    return attachments.filter((attachment) => isImageAttachment(attachment))
  }

  /** Fire sticker capture for inbound images; failures are only logged. */
  function captureInboundImages(inbound, config) {
    if (config.stickers?.enabled !== true || config.stickers?.captureIncoming !== true) return
    const images = inboundImages(inbound)
    if (images.length === 0) return
    if (typeof captureIncomingImage !== 'function') return
    for (const attachment of images) {
      Promise.resolve()
        .then(() => captureIncomingImage(attachment, inbound))
        .catch((error) => logger?.warn?.('入站图片入库失败', { chatId: inbound?.chatId, error: error?.message }))
    }
  }

  /**
   * Content persisted to memory and shown to the model. QQ only hands the bot a
   * text placeholder for images (and protocol markup for faces), so make the
   * image facts explicit. When a vision endpoint is configured, each image is
   * described first and the description is embedded into the marker; a failed
   * description simply degrades to the size/media-type marker.
   */
  async function buildInboundContent(inbound) {
    const rawText = String(inbound?.text ?? '').trim()
    const images = inboundImages(inbound)
    if (images.length === 0) return rawText
    let descriptions = images.map(() => '')
    if (typeof describeIncomingImage === 'function') {
      descriptions = await Promise.all(
        images.map(async (attachment) => {
          try {
            const text = await describeIncomingImage(attachment, inbound)
            return typeof text === 'string' ? clampText(text.trim(), 240) : ''
          } catch (error) {
            logger?.warn?.('入站图片描述失败', { chatId: inbound?.chatId, error: error?.message })
            return ''
          }
        })
      )
    }
    const markers = images
      .map((attachment, index) => {
        const base = describeImageMarker(attachment)
        return descriptions[index] === '' ? base : `${base}（图片内容：${descriptions[index]}）`
      })
      .join(' ')
    const withoutPlaceholder = rawText
      .replace(/\[图片\]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    return withoutPlaceholder === '' ? markers : `${withoutPlaceholder} ${markers}`
  }

  async function handleBudgetBlocked(inbound, chatId, config, content) {
    const budget = isPlainObject(config.budget) ? config.budget : {}
    const blockMessage = typeof budget.blockMessage === 'string' && budget.blockMessage.trim() !== '' ? budget.blockMessage.trim() : DEFAULT_BLOCK_MESSAGE
    const cooldownMs = Number(budget.blockCooldownMs)
    const now = Date.now()
    const lastNoticedAt = blockNoticedAt.get(chatId) ?? 0

    await appendMessageSafe(chatId, {
      role: 'user',
      content,
      ts: inbound.timestamp ?? now,
      userId: inbound.userId,
      userName: inbound.userName,
      msgId: inbound.msgId
    })

    if (lastNoticedAt === 0 || !Number.isFinite(cooldownMs) || now - lastNoticedAt >= cooldownMs) {
      const sent = await sendText(inbound, blockMessage)
      if (sent) blockNoticedAt.set(chatId, now)
      else if (lastNoticedAt === 0) blockNoticedAt.set(chatId, now)
      await appendMessageSafe(chatId, { role: 'assistant', content: blockMessage, ts: Date.now() })
    }
  }

  async function pickStickerForDirectives(requests) {
    if (typeof stickerSelector?.pickForReply !== 'function') return null
    for (const tags of requests) {
      try {
        const sticker = await stickerSelector.pickForReply(tags)
        if (sticker) return sticker
      } catch (error) {
        logger?.warn?.('按指令挑选表情包失败', { tags, error: error?.message })
      }
    }
    return null
  }

  async function maybeStickerFromText(text, persona) {
    if (typeof text !== 'string' || text.trim() === '') return null
    const chance = Number(persona?.stickerChance)
    if (!Number.isFinite(chance) || chance <= 0) return null
    if (chance < 1) {
      // Apply the effective (per-chat / per-user) chance here instead of letting
      // the selector only look at the global config.
      try {
        if (!(Math.random() < chance)) return null
      } catch {
        return null
      }
    }
    if (typeof stickerSelector?.maybeStickerFromText !== 'function') return null
    try {
      // rng() => 0 forces the selector's own roll to pass; the probability was
      // already applied above with the effective persona chance.
      return await stickerSelector.maybeStickerFromText(text, () => 0)
    } catch (error) {
      logger?.warn?.('自动挑选表情包失败', { error: error?.message })
      return null
    }
  }

  function stripJustAppended(history, inbound, content) {
    if (!Array.isArray(history) || history.length === 0) return history
    const last = history[history.length - 1]
    if (!isPlainObject(last) || last.role !== 'user') return history
    if (typeof inbound?.msgId === 'string' && inbound.msgId !== '' && last.msgId === inbound.msgId) return history.slice(0, -1)
    if (last.content === content && (last.ts === inbound?.timestamp || last.msgId === undefined)) return history.slice(0, -1)
    return history
  }

  async function processInbound(inbound) {
    const config = readConfig()
    const chatId = resolveChatId(inbound)
    if (chatId === '') return

    // 1. Local commands first.
    if (typeof commandHandler?.tryHandle === 'function') {
      let commandResult = { handled: false }
      try {
        commandResult = await commandHandler.tryHandle(inbound)
      } catch (error) {
        logger?.warn?.('命令识别失败', { chatId, error: error?.message })
      }
      if (commandResult?.handled === true) {
        if (typeof commandResult.text === 'string' && commandResult.text !== '') await sendText(inbound, commandResult.text)
        if (commandResult.sticker) await sendSticker(inbound, commandResult.sticker)
        return
      }
    }

    // 2. Inbound images: capture into the sticker candidate library + explicit marker.
    captureInboundImages(inbound, config)
    const content = await buildInboundContent(inbound)

    // 3. Budget gate.
    if (typeof budgetStore?.check === 'function') {
      let checkResult
      try {
        checkResult = await budgetStore.check({ chatId, userId: inbound.userId })
      } catch (error) {
        logger?.warn?.('预算检查失败，按放行处理', { chatId, error: error?.message })
        checkResult = { allowed: true }
      }
      if (checkResult && checkResult.allowed === false) {
        await handleBudgetBlocked(inbound, chatId, config, content)
        return
      }
    }

    const persona = await resolvePersona(inbound, chatId, config)

    // 4. Persist the user message before touching the prompt.
    const userMessage = {
      role: 'user',
      content,
      ts: inbound.timestamp ?? Date.now(),
      userId: inbound.userId,
      userName: inbound.userName,
      msgId: inbound.msgId
    }
    await appendMessageSafe(chatId, userMessage)

    // 5. Optional compression before we read history for the prompt.
    if (persona.compressEnabled !== false && typeof compressor?.maybeCompress === 'function') {
      try {
        const compression = await compressor.maybeCompress(chatId)
        if (compression?.compressed === true) logger?.debug?.('上下文已压缩', { chatId, removed: compression.removed })
      } catch (error) {
        logger?.warn?.('上下文压缩失败', { chatId, error: error?.message })
      }
    }

    // 6. Gather context and assemble the prompt.
    let chatInfo = { facts: [], summary: null }
    try {
      if (typeof memoryStore?.getChat === 'function') chatInfo = await memoryStore.getChat(chatId)
    } catch (error) {
      logger?.warn?.('读取会话记忆失败', { chatId, error: error?.message })
    }
    let history = []
    try {
      if (typeof memoryStore?.history === 'function') history = await memoryStore.history(chatId, persona.maxHistoryMessages)
    } catch (error) {
      logger?.warn?.('读取会话历史失败', { chatId, error: error?.message })
    }
    history = stripJustAppended(history, inbound, content)

    let stickerCatalog = ''
    if (config.stickers?.enabled !== false && typeof stickerSelector?.catalogText === 'function') {
      try {
        stickerCatalog = await stickerSelector.catalogText()
      } catch (error) {
        logger?.warn?.('读取表情包目录失败', { chatId, error: error?.message })
      }
    }

    const system = buildSystemPrompt({
      config,
      persona,
      facts: chatInfo?.facts ?? [],
      summary: chatInfo?.summary ?? null,
      stickerCatalog,
      now: Date.now()
    })
    const messages = buildMessages({ history, userMessage: content, maxMessages: persona.maxHistoryMessages })

    // 7. Call the model.
    if (typeof llmClient?.complete !== 'function') {
      logger?.error?.('LLM 客户端不可用', { chatId })
      const sent = await sendText(inbound, ERROR_FALLBACK)
      if (sent) await appendMessageSafe(chatId, { role: 'assistant', content: ERROR_FALLBACK, ts: Date.now() })
      return
    }

    let result
    try {
      result = await llmClient.complete({
        system,
        messages,
        maxTokens: config.llm?.maxTokens,
        temperature: persona.temperature ?? config.llm?.temperature,
        ...(typeof persona.model === 'string' && persona.model !== '' ? { model: persona.model } : {}),
        purpose: 'chat'
      })
    } catch (error) {
      logger?.warn?.('LLM 调用失败，发送兜底文案', { chatId, code: error?.code, error: error?.message })
      const sent = await sendText(inbound, ERROR_FALLBACK)
      if (sent) await appendMessageSafe(chatId, { role: 'assistant', content: ERROR_FALLBACK, ts: Date.now() })
      return
    }

    if (typeof budgetStore?.record === 'function') {
      try {
        await budgetStore.record({
          chatId,
          userId: inbound.userId,
          provider: result?.provider,
          model: result?.model,
          usage: result?.usage
        })
      } catch (error) {
        logger?.warn?.('预算记录失败', { chatId, error: error?.message })
      }
    }

    // 8. Sticker directives, markdown cleanup and char limit.
    const directives = parseStickerDirectives(result?.text ?? '')
    const cleaned = stripMarkdown(directives.text)
    const finalText = clampText(cleaned, persona.replyMaxChars)

    // 9. Send text first, then the sticker (best effort, degrade to text only).
    let sticker = null
    if (Array.isArray(directives.requests) && directives.requests.length > 0) {
      sticker = await pickStickerForDirectives(directives.requests)
    } else {
      sticker = await maybeStickerFromText(finalText, persona)
    }

    if (finalText !== '') await sendText(inbound, finalText)
    if (sticker) await sendSticker(inbound, sticker)
    if (finalText === '' && sticker === null) await sendText(inbound, EMPTY_REPLY_FALLBACK)

    // 10. Persist what the user actually saw.
    const assistantContent = finalText !== '' ? finalText : sticker !== null ? '' : EMPTY_REPLY_FALLBACK
    await appendMessageSafe(chatId, {
      role: 'assistant',
      content: assistantContent,
      ts: Date.now(),
      ...(sticker?.tags?.length ? { stickerTags: sticker.tags } : {})
    })

    // 11. Long-term memory extraction runs in the background.
    if (persona.memoryEnabled !== false && typeof extractor?.maybeExtract === 'function') {
      Promise.resolve()
        .then(() => extractor.maybeExtract({ chatId }))
        .catch((error) => logger?.warn?.('记忆抽取失败', { chatId, error: error?.message }))
    }
  }

  /** Handle one inbound message; never throws. Serialized per chatId. */
  async function handleInbound(inbound) {
    if (!isPlainObject(inbound)) return
    const chatId = resolveChatId(inbound)
    if (chatId === '') return
    return enqueue(chatId, async () => {
      try {
        await processInbound(inbound)
      } catch (error) {
        logger?.error?.('处理入站消息失败', { chatId, error: error?.message ?? String(error) })
        try {
          await sendText(inbound, ERROR_FALLBACK)
        } catch {
          // swallow: the outer contract is "never throw"
        }
      }
    })
  }

  /** Admin page: force a context compression for one chat. */
  async function compressChat(chatId) {
    const key = String(chatId ?? '')
    if (key === '') return { compressed: false, removed: 0 }
    if (typeof compressor?.compressNow !== 'function') return { compressed: false, removed: 0, error: 'compressor unavailable' }
    return enqueue(key, () => compressor.compressNow(key))
  }

  /** Admin page: force a long-term memory extraction for one chat. */
  async function extractFacts(chatId) {
    const key = String(chatId ?? '')
    if (key === '') return { extracted: false, facts: [] }
    if (typeof extractor?.extractNow !== 'function') return { extracted: false, facts: [], error: 'extractor unavailable' }
    return enqueue(key, () => extractor.extractNow(key))
  }

  return { handleInbound, compressChat, extractFacts }
}
