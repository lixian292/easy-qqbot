/**
 * Long term memory extractor.
 *
 * Every `config.memory.extractEveryUserMessages` new user messages (or when
 * forced), the extractor asks the model for a small JSON string array of
 * durable facts and merges them into the chat memory / user profile.
 *
 * It is deliberately defensive: one bad model answer must never break a chat,
 * so parsing is tolerant (code fences, prose around the array, quoted strings)
 * and every failure only produces a warning log.
 */
import { clampText } from '../util/text.js'

const MAX_NEW_FACTS = 3
const MAX_FACT_CHARS = 60
const MAX_TRANSCRIPT_MESSAGES = 20
const MAX_TRANSCRIPT_CHARS = 6000

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const factKey = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, '')

const EXTRACT_SYSTEM_PROMPT =
  '你是一个记忆整理助手。请从对话中提取值得长期记住的事实，例如用户的身份、称呼、偏好、习惯、人际关系、约定和重要事件。' +
  '只输出一个 JSON 字符串数组，例如 ["用户喜欢猫","用户住在杭州","用户是程序员"]。' +
  `最多 ${MAX_NEW_FACTS} 条，每条不超过 ${MAX_FACT_CHARS} 个汉字；不要输出 JSON 之外的任何内容，不要解释。` +
  '忽略寒暄、一次性话题和隐私敏感信息（密码、住址门牌号、证件号等）。'

function formatTranscript(messages) {
  const lines = []
  let budget = MAX_TRANSCRIPT_CHARS
  for (const message of messages) {
    const role = message?.role === 'assistant' ? '助手' : '用户'
    const content = String(message?.content ?? '').trim()
    if (content === '') continue
    const clipped = content.length > 300 ? `${content.slice(0, 299)}…` : content
    const line = `${role}：${clipped}`
    if (line.length > budget) break
    budget -= line.length
    lines.push(line)
  }
  return lines.join('\n')
}

/**
 * Tolerantly pull a string array out of the model answer.
 * @returns {string[]}
 */
export function parseExtractedFacts(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return []

  const cleaned = raw
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim()

  const candidates = []
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start !== -1 && end > start) candidates.push(cleaned.slice(start, end + 1))
  candidates.push(cleaned)

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      const list = Array.isArray(parsed) ? parsed : isPlainObject(parsed) && Array.isArray(parsed.facts) ? parsed.facts : null
      if (list !== null) {
        return list
          .map((item) => (typeof item === 'string' ? item : isPlainObject(item) ? String(item.text ?? '') : ''))
          .map((item) => item.trim())
          .filter((item) => item !== '')
      }
    } catch {
      // Try the next candidate / fallback below.
    }
  }

  // Last resort: quoted strings inside a prose answer.
  const quoted = []
  const matcher = /"([^"\n]{2,160})"|“([^”\n]{2,160})”/g
  let match
  while ((match = matcher.exec(cleaned)) !== null) {
    const value = (match[1] ?? match[2] ?? '').trim()
    if (value !== '') quoted.push(value)
  }
  return quoted
}

function normalizeFacts(list) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(list) ? list : []) {
    const text = clampText(String(item ?? '').trim().replace(/^[-*\d.\s]+/, '').trim(), MAX_FACT_CHARS)
    if (text === '') continue
    const key = factKey(text)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= MAX_NEW_FACTS) break
  }
  return out
}

/**
 * @param {{ configStore: { get(): object }, llmClient: object, memoryStore: object, logger?: object }} deps
 */
export function createMemoryExtractor({ configStore, llmClient, memoryStore, logger } = {}) {
  const inFlight = new Map()

  function readConfig() {
    try {
      const config = configStore?.get?.() ?? {}
      return isPlainObject(config) ? config : {}
    } catch (error) {
      logger?.warn?.('读取记忆抽取配置失败，使用默认值', { error: error?.message })
      return {}
    }
  }

  async function upsertPersonFromChat(chatId, facts) {
    if (!Array.isArray(facts) || facts.length === 0) return
    if (typeof memoryStore.upsertPerson !== 'function') return
    let recent
    try {
      recent = await memoryStore.history(chatId, MAX_TRANSCRIPT_MESSAGES)
    } catch {
      return
    }
    let lastUser = null
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      if (recent[index]?.role === 'user' && typeof recent[index]?.userId === 'string' && recent[index].userId !== '') {
        lastUser = recent[index]
        break
      }
    }
    if (lastUser === null) return
    try {
      await memoryStore.upsertPerson(lastUser.userId, {
        ...(typeof lastUser.userName === 'string' && lastUser.userName !== '' ? { name: lastUser.userName } : {}),
        addFacts: facts
      })
    } catch (error) {
      logger?.warn?.('更新用户画像失败', { chatId, error: error?.message })
    }
  }

  async function runExtraction(chatId) {
    const chat = await memoryStore.getChat(chatId)
    const recent = await memoryStore.history(chatId, MAX_TRANSCRIPT_MESSAGES)
    if (!Array.isArray(recent) || recent.length === 0) return { extracted: false, facts: [], reason: 'empty' }

    const existingFacts = Array.isArray(chat?.facts) ? chat.facts.map((fact) => (typeof fact === 'string' ? fact : String(fact?.text ?? ''))) : []
    const transcript = formatTranscript(recent)
    if (transcript.trim() === '') return { extracted: false, facts: [], reason: 'empty' }

    const parts = []
    if (existingFacts.length > 0) {
      parts.push(`【已有记忆】\n${existingFacts.map((fact) => `- ${fact}`).join('\n')}`)
    }
    parts.push(`【最近的对话】\n${transcript}`)
    parts.push('请输出需要新增的长期事实的 JSON 字符串数组；如果没有新的长期事实，输出 []。')

    let result
    try {
      result = await llmClient.complete({
        system: EXTRACT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: parts.join('\n\n') }],
        maxTokens: 300,
        temperature: 0.2,
        purpose: 'memory-extract'
      })
    } catch (error) {
      logger?.warn?.('记忆抽取失败', { chatId, error: error?.message, code: error?.code })
      return { extracted: false, facts: [], reason: 'error', error: error?.message ?? 'extract failed' }
    }

    const parsed = normalizeFacts(parseExtractedFacts(result?.text))
    const existingKeys = new Set(existingFacts.map((fact) => factKey(fact)))
    const newFacts = parsed.filter((fact) => !existingKeys.has(factKey(fact)))

    try {
      if (parsed.length > 0) await memoryStore.addFacts(chatId, parsed)
      if (typeof memoryStore.setCounters === 'function') {
        await memoryStore.setCounters(chatId, { lastExtractAt: chat?.counters?.userMessages ?? 0 })
      }
    } catch (error) {
      logger?.warn?.('写入长期记忆失败', { chatId, error: error?.message })
      return { extracted: false, facts: [], reason: 'error', error: error?.message ?? 'extract failed' }
    }

    if (newFacts.length > 0) await upsertPersonFromChat(chatId, newFacts)

    if (parsed.length === 0) {
      logger?.debug?.('记忆抽取完成，无新事实', { chatId })
      return { extracted: false, facts: [], reason: 'empty' }
    }
    logger?.info?.('记忆抽取完成', { chatId, newFacts: newFacts.length })
    return { extracted: newFacts.length > 0, facts: newFacts, ...(newFacts.length === 0 ? { reason: 'duplicate' } : {}) }
  }

  function withInFlight(chatId) {
    const key = String(chatId)
    const running = inFlight.get(key)
    if (running !== undefined) return running
    const promise = runExtraction(key).finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key)
    })
    inFlight.set(key, promise)
    return promise
  }

  /**
   * Extract only when enough new user messages accumulated (or when forced).
   * @param {{ chatId: string, force?: boolean }} [options]
   */
  async function maybeExtract({ chatId, force = false } = {}) {
    if (typeof chatId !== 'string' || chatId === '') return { extracted: false, facts: [], reason: 'invalid' }
    const config = readConfig()
    if (config.persona?.memoryEnabled === false) return { extracted: false, facts: [], reason: 'disabled' }

    let chat
    try {
      chat = await memoryStore.getChat(chatId)
    } catch (error) {
      logger?.warn?.('读取会话记忆失败', { chatId, error: error?.message })
      return { extracted: false, facts: [], reason: 'error', error: error?.message }
    }

    const counters = isPlainObject(chat?.counters) ? chat.counters : {}
    const userMessages = Math.max(0, Number(counters.userMessages) || 0)
    const baseline = Math.max(0, Number(counters.lastExtractAt) || 0)

    if (!force) {
      const every = Math.max(1, Math.round(Number(config.memory?.extractEveryUserMessages) || 8))
      if (userMessages - baseline < every) return { extracted: false, facts: [], reason: 'threshold', delta: userMessages - baseline }
    }

    return withInFlight(chatId)
  }

  /** Force extraction regardless of the message threshold. */
  async function extractNow(chatId) {
    return maybeExtract({ chatId, force: true })
  }

  return { maybeExtract, extractNow }
}
