/**
 * Context compressor.
 *
 * When the estimated token size of `summary + history` exceeds
 * `config.memory.compressTriggerTokens`, the oldest messages are merged into the
 * rolling summary (via one LLM call) and only the most recent
 * `keepRecentMessages` messages are kept verbatim.
 *
 * Failures never throw: they are logged and reported as `{ compressed:false, error }`.
 */
import { clampText, estimateMessagesTokens, estimateTokens } from '../util/text.js'

const DEFAULT_TRIGGER_TOKENS = 8000
const DEFAULT_KEEP_RECENT = 12
const DEFAULT_SUMMARY_MAX_CHARS = 1200
const MAX_TRANSCRIPT_MESSAGES = 200

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const integerOr = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(max, Math.round(parsed))
}

function formatMessageForSummary(message) {
  const role = message?.role === 'assistant' ? '助手' : '用户'
  const content = String(message?.content ?? '').trim()
  if (content === '') return null
  const clipped = content.length > 300 ? `${content.slice(0, 299)}…` : content
  return `${role}：${clipped}`
}

function buildCompressInput(previousSummary, oldMessages, summaryMaxChars) {
  const parts = []
  const summaryText = isPlainObject(previousSummary) ? String(previousSummary.text ?? '').trim() : ''
  if (summaryText !== '') parts.push(`【已有摘要】\n${summaryText}`)
  const transcript = oldMessages
    .map((message) => formatMessageForSummary(message))
    .filter((line) => line !== null)
    .join('\n')
  parts.push(`【需要合并进摘要的较早对话】\n${transcript}`)
  parts.push(`请输出一段不超过 ${summaryMaxChars} 个字符的中文摘要。`)
  return parts.join('\n\n')
}

/**
 * @param {{ configStore: { get(): object }, memoryStore: object, llmClient: object, logger?: object }} deps
 */
export function createCompressor({ configStore, memoryStore, llmClient, logger } = {}) {
  const inFlight = new Map()

  function readConfig() {
    try {
      const config = configStore?.get?.() ?? {}
      return isPlainObject(config) ? config : {}
    } catch (error) {
      logger?.warn?.('读取压缩配置失败，使用默认值', { error: error?.message })
      return {}
    }
  }

  function readSettings(config) {
    const memory = isPlainObject(config.memory) ? config.memory : {}
    return {
      triggerTokens: integerOr(memory.compressTriggerTokens, DEFAULT_TRIGGER_TOKENS),
      keepRecentMessages: Math.max(2, integerOr(memory.keepRecentMessages, DEFAULT_KEEP_RECENT, 200)),
      summaryMaxChars: Math.max(200, integerOr(memory.summaryMaxChars, DEFAULT_SUMMARY_MAX_CHARS, 8000))
    }
  }

  async function runCompression(chatId, { force = false } = {}) {
    const config = readConfig()
    const settings = readSettings(config)
    const history = await memoryStore.history(chatId, Number.MAX_SAFE_INTEGER)
    if (!Array.isArray(history) || history.length === 0) return { compressed: false, removed: 0 }
    if (history.length <= settings.keepRecentMessages) return { compressed: false, removed: 0 }

    const chat = await memoryStore.getChat(chatId)
    const previousSummary = chat?.summary ?? null

    if (!force) {
      const estimated = estimateTokens(previousSummary?.text ?? '') + estimateMessagesTokens(history)
      if (estimated <= settings.triggerTokens) return { compressed: false, removed: 0, estimatedTokens: estimated }
    }

    const oldMessages = history.slice(0, history.length - settings.keepRecentMessages).slice(-MAX_TRANSCRIPT_MESSAGES)
    const recentMessages = history.slice(-settings.keepRecentMessages)
    const summaryMaxChars = settings.summaryMaxChars

    let summaryText
    try {
      const result = await llmClient.complete({
        system:
          '你是对话摘要助手。请把「已有摘要」和「较早的对话」合并成一段简洁的中文摘要，保留人物、关系、偏好、约定和未完成的话题，去掉寒暄与重复内容。' +
          `只输出摘要正文，不要解释，不要使用 Markdown 或列表，长度不超过 ${summaryMaxChars} 个字符。`,
        messages: [{ role: 'user', content: buildCompressInput(previousSummary, oldMessages, summaryMaxChars) }],
        maxTokens: 800,
        temperature: 0.2,
        purpose: 'memory-compress'
      })
      summaryText = clampText(String(result?.text ?? '').trim(), summaryMaxChars)
      if (summaryText.trim() === '') throw new Error('摘要内容为空')
    } catch (error) {
      logger?.warn?.('上下文压缩失败，已回滚', { chatId, error: error?.message })
      return { compressed: false, removed: 0, error: error?.message ?? 'compress failed' }
    }

    const summary = {
      text: summaryText,
      coveredCount: integerOr(previousSummary?.coveredCount, 0) + oldMessages.length,
      updatedAt: Date.now()
    }

    try {
      await memoryStore.setSummary(chatId, summary)
      await memoryStore.replaceHistory(chatId, recentMessages)
    } catch (error) {
      // Roll back whichever half may have been written.
      try {
        await memoryStore.replaceHistory(chatId, history)
        await memoryStore.setSummary(chatId, previousSummary)
      } catch {
        // Rollback is best effort; the original history is still on disk if
        // replaceHistory never ran, so just log.
      }
      logger?.warn?.('上下文压缩写入失败，已回滚', { chatId, error: error?.message })
      return { compressed: false, removed: 0, error: error?.message ?? 'compress failed' }
    }

    logger?.info?.('上下文已压缩', { chatId, removed: oldMessages.length, summaryChars: summaryText.length })
    return { compressed: true, removed: oldMessages.length, summary: summaryText, coveredCount: summary.coveredCount }
  }

  function withInFlight(chatId, force) {
    const key = String(chatId)
    const running = inFlight.get(key)
    if (running !== undefined) return running
    const promise = runCompression(key, { force }).finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key)
    })
    inFlight.set(key, promise)
    return promise
  }

  /** Compress only when `summary + history` is over the configured token threshold. */
  async function maybeCompress(chatId) {
    if (chatId === undefined || chatId === null || String(chatId) === '') return { compressed: false, removed: 0 }
    return withInFlight(String(chatId), false)
  }

  /** Compress unconditionally (still needs more than `keepRecentMessages` messages). */
  async function compressNow(chatId) {
    if (chatId === undefined || chatId === null || String(chatId) === '') return { compressed: false, removed: 0 }
    return withInFlight(String(chatId), true)
  }

  return { maybeCompress, compressNow }
}
