/**
 * LLM client for the qqbot brain.
 *
 * The DSH host injects `ctx.llm` (a streaming LLM service). This module wraps
 * `ctx.llm.stream()` into a small request/response helper:
 *
 *   complete({ system, messages, maxTokens, temperature, purpose, signal })
 *     -> { text, usage, provider, model, finishKind }
 *
 * It also normalizes the provider specific message format (assistant messages
 * must carry `source: { kind: 'model', provider, model }`) and maps every kind
 * of failure into `LlmCallError` with a stable `code`, so upper layers can
 * decide whether to retry, degrade or surface a fallback message.
 */
import { formatDateTime } from '../util/text.js'

export class LlmCallError extends Error {
  /**
   * @param {string} message human readable message (Chinese when user facing)
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, { code = 'LLM_ERROR', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LlmCallError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

const DEFAULT_PROVIDER = 'deepseek-official'
const DEFAULT_MODEL = 'deepseek-flash'
const DEFAULT_MAX_TOKENS = 800
const DEFAULT_TEMPERATURE = 0.8
const DEFAULT_TIMEOUT_MS = 120000
const UNKNOWN_FINISH = 'unknown'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const numberOrZero = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Convert a message content (string or text-block array) into DSH text blocks. */
function toTextBlocks(content) {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }]
  }
  if (!Array.isArray(content)) return []
  const blocks = []
  for (const block of content) {
    if (!isPlainObject(block)) continue
    if (block.type !== undefined && block.type !== 'text') continue
    if (typeof block.text !== 'string' || block.text === '') continue
    blocks.push({ type: 'text', text: block.text })
  }
  return blocks
}

/**
 * Convert contract messages (`{role, content: string}`) into the shape the DSH
 * LLM adapters expect. `system` role messages are folded into the top level
 * `system` argument; assistant turns get their `source` attached.
 */
function convertMessages(messages, provider, model) {
  const converted = []
  const systemParts = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isPlainObject(message)) continue
    const blocks = toTextBlocks(message.content)
    if (blocks.length === 0) continue
    if (message.role === 'system') {
      systemParts.push(blocks.map((block) => block.text).join('\n'))
      continue
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const entry = { role: message.role, content: blocks }
    if (message.role === 'assistant') entry.source = { kind: 'model', provider, model }
    converted.push(entry)
  }
  return { messages: converted, systemParts }
}

/** Merge two usage chunks; later values win field by field. */
function mergeUsage(previous, raw) {
  if (!isPlainObject(raw)) return previous
  const merged = previous === null ? { inputTokens: 0, outputTokens: 0 } : { ...previous }
  if (raw.inputTokens !== undefined) merged.inputTokens = numberOrZero(raw.inputTokens)
  if (raw.outputTokens !== undefined) merged.outputTokens = numberOrZero(raw.outputTokens)
  return merged
}

/**
 * @param {{ ctx?: object, configStore?: { get(): object }, logger?: object }} deps
 */
export function createLlmClient({ ctx, configStore, logger } = {}) {
  function readConfig() {
    let config
    try {
      config = configStore?.get?.() ?? {}
    } catch (error) {
      logger?.warn?.('读取 LLM 配置失败，使用默认值', { error: error?.message })
      config = {}
    }
    return isPlainObject(config) ? config : {}
  }

  /**
   * Call the streaming LLM once and collect the text response.
   * `model` / `provider` are optional per-call overrides used by per-chat
   * persona settings; they fall back to the global config when omitted.
   * @param {{ system?: string, messages?: object[], maxTokens?: number, temperature?: number, purpose?: string, signal?: AbortSignal, provider?: string, model?: string }} [options]
   * @returns {Promise<{ text: string, usage: { inputTokens: number, outputTokens: number, totalTokens: number }, provider: string, model: string, finishKind: string }>}
   */
  async function complete({
    system = '',
    messages = [],
    maxTokens,
    temperature,
    purpose,
    signal,
    provider: providerOverride,
    model: modelOverride
  } = {}) {
    const config = readConfig()
    const llmConfig = isPlainObject(config.llm) ? config.llm : {}
    const provider =
      typeof providerOverride === 'string' && providerOverride !== ''
        ? providerOverride
        : typeof llmConfig.provider === 'string' && llmConfig.provider !== ''
          ? llmConfig.provider
          : DEFAULT_PROVIDER
    const model =
      typeof modelOverride === 'string' && modelOverride !== ''
        ? modelOverride
        : typeof llmConfig.model === 'string' && llmConfig.model !== ''
          ? llmConfig.model
          : DEFAULT_MODEL
    const timeoutCandidate = Number(llmConfig.timeoutMs)
    const timeoutMs = Number.isFinite(timeoutCandidate) && timeoutCandidate > 0 ? timeoutCandidate : DEFAULT_TIMEOUT_MS

    const streamFn = ctx?.llm?.stream
    if (typeof streamFn !== 'function') {
      throw new LlmCallError('LLM 服务不可用：当前 DSH 环境没有提供 ctx.llm.stream', { code: 'LLM_UNAVAILABLE' })
    }

    if (signal?.aborted) {
      throw new LlmCallError('模型请求已取消', { code: 'ABORTED' })
    }

    const converted = convertMessages(messages, provider, model)
    const systemText = [String(system ?? ''), ...converted.systemParts].filter((part) => part.trim() !== '').join('\n\n')

    const controller = new AbortController()
    let abortReason = null
    let rejectAbort = null
    const abortPromise = new Promise((_resolve, reject) => {
      rejectAbort = reject
    })

    const onAbort = () => {
      const code = abortReason === 'timeout' ? 'TIMEOUT' : 'ABORTED'
      rejectAbort(new LlmCallError(abortReason === 'timeout' ? '模型请求超时' : '模型请求已取消', { code }))
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })

    const onExternalAbort = () => {
      if (abortReason === null) abortReason = 'external'
      controller.abort()
    }
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onExternalAbort, { once: true })

    const timer = setTimeout(() => {
      abortReason = 'timeout'
      controller.abort()
    }, timeoutMs)

    const options = {
      provider,
      model,
      system: systemText,
      messages: converted.messages,
      temperature: temperature ?? (Number.isFinite(Number(llmConfig.temperature)) ? Number(llmConfig.temperature) : DEFAULT_TEMPERATURE),
      maxTokens: maxTokens ?? (Number.isFinite(Number(llmConfig.maxTokens)) ? Number(llmConfig.maxTokens) : DEFAULT_MAX_TOKENS),
      signal: controller.signal
    }
    if (typeof purpose === 'string' && purpose !== '') options.purpose = purpose

    let text = ''
    let sawDelta = false
    const blockTexts = []
    let usage = null
    let finishKind = UNKNOWN_FINISH

    logger?.debug?.('调用 LLM', { provider, model, purpose: purpose ?? 'chat', timeoutMs, messageCount: converted.messages.length })

    try {
      let stream = streamFn.call(ctx.llm, options)
      if (stream && typeof stream.then === 'function') stream = await stream
      if (stream === null || stream === undefined || typeof stream[Symbol.asyncIterator] !== 'function') {
        throw new LlmCallError('LLM 返回的数据流不可用', { code: 'LLM_UNAVAILABLE' })
      }

      const iterator = stream[Symbol.asyncIterator]()
      try {
        for (;;) {
          const nextPromise = iterator.next()
          if (nextPromise && typeof nextPromise.catch === 'function') nextPromise.catch(() => {})
          const step = await Promise.race([nextPromise, abortPromise])
          if (step.done === true) break
          const chunk = step.value
          if (!isPlainObject(chunk)) continue
          switch (chunk.type) {
            case 'text-delta':
              if (typeof chunk.text === 'string' && chunk.text !== '') {
                sawDelta = true
                text += chunk.text
              }
              break
            case 'block-end':
              if (!sawDelta && chunk.block?.type === 'text' && typeof chunk.block.text === 'string' && chunk.block.text !== '') {
                blockTexts.push(chunk.block.text)
              }
              break
            case 'usage':
              usage = mergeUsage(usage, chunk.usage)
              break
            case 'finish': {
              finishKind = typeof chunk.reason?.kind === 'string' && chunk.reason.kind !== '' ? chunk.reason.kind : UNKNOWN_FINISH
              if (finishKind === 'error' || finishKind === 'aborted') {
                const failure = chunk.reason?.failure
                const failureCode = typeof failure?.code === 'string' && failure.code !== '' ? failure.code : null
                const code = failureCode ?? (abortReason === 'timeout' ? 'TIMEOUT' : finishKind === 'aborted' ? 'ABORTED' : 'LLM_ERROR')
                const detail = typeof failure?.message === 'string' && failure.message !== '' ? failure.message : ''
                const message = finishKind === 'aborted' ? (detail === '' ? '模型请求已中断' : `模型请求已中断：${detail}`) : detail === '' ? '模型调用失败' : `模型调用失败：${detail}`
                throw new LlmCallError(message, { code })
              }
              break
            }
            default:
              // Unknown chunk types are ignored on purpose: the DSH stream is
              // forward compatible and we only depend on the documented ones.
              break
          }
        }
      } finally {
        // Never await return(): a broken/unresponsive stream must not block us.
        try {
          const returned = iterator.return?.()
          if (returned && typeof returned.catch === 'function') returned.catch(() => {})
        } catch {
          // ignore cleanup failures
        }
      }

      if (!sawDelta && blockTexts.length > 0) text = blockTexts.join('')
      if (text.trim() === '') {
        throw new LlmCallError('模型没有返回内容', { code: 'EMPTY_RESPONSE' })
      }

      const inputTokens = numberOrZero(usage?.inputTokens)
      const outputTokens = numberOrZero(usage?.outputTokens)
      logger?.debug?.('LLM 调用完成', { provider, model, purpose: purpose ?? 'chat', finishKind, inputTokens, outputTokens })

      return {
        text,
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        provider,
        model,
        finishKind
      }
    } catch (error) {
      if (error instanceof LlmCallError) throw error
      if (abortReason !== null) {
        const code = abortReason === 'timeout' ? 'TIMEOUT' : 'ABORTED'
        throw new LlmCallError(abortReason === 'timeout' ? '模型请求超时' : '模型请求已取消', { code, cause: error })
      }
      if (error?.name === 'AbortError') {
        throw new LlmCallError('模型请求已取消', { code: 'ABORTED', cause: error })
      }
      const rawCode = typeof error?.code === 'string' ? error.code.trim() : ''
      const code = /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : 'LLM_ERROR'
      const detail = typeof error?.message === 'string' && error.message !== '' ? error.message : '未知错误'
      throw new LlmCallError(`模型调用失败：${detail}`, { code, cause: error })
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', onAbort)
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onExternalAbort)
    }
  }

  /** Connectivity self test used by the admin page. */
  async function test({ prompt = '你好' } = {}) {
    const startedAt = Date.now()
    logger?.debug?.('LLM 连通性测试开始', { startedAt: formatDateTime(Date.now()) })
    const result = await complete({
      system: '你是连通性测试助手，只回复一行。',
      messages: [{ role: 'user', content: String(prompt ?? '你好') }],
      maxTokens: 64
    })
    return { ...result, elapsedMs: Date.now() - startedAt }
  }

  return { complete, test }
}
