/**
 * Long term memory extractor.
 *
 * Every `config.memory.extractEveryUserMessages` new user messages (or when
 * forced), the extractor asks the model for durable facts and merges them into
 * the chat memory and — in group chats — into the current speaker's per-member
 * record (`data/chats/<chatId>/members/<userId>.json`).
 *
 * The model is asked for a JSON object `{ chatFacts, memberFacts }`; the older
 * plain string array format is still accepted (it is treated as chatFacts).
 * Parsing is deliberately tolerant: one bad model answer must never break a
 * chat, so failures only produce a warning log.
 */
import { clampText } from '../util/text.js'

const MAX_NEW_FACTS = 3
const MAX_FACT_CHARS = 60
const MAX_TRANSCRIPT_MESSAGES = 20
const MAX_TRANSCRIPT_CHARS = 6000
const MAX_PROMPT_FACTS = 20

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const factKey = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, '')

const EXTRACT_SYSTEM_PROMPT =
  '你是一个记忆整理助手。请从对话中提取值得长期记住的事实。' +
  '只输出一个 JSON 对象，格式为 {"chatFacts":["..."],"memberFacts":["..."]}：' +
  'chatFacts 是整个会话值得记住的事实（群聊约定、共同话题、重要事件等）；' +
  'memberFacts 是当前发言者本人的长期信息（身份、称呼、偏好、习惯、人际关系、约定等）。' +
  `两个数组各最多 ${MAX_NEW_FACTS} 条，每条不超过 ${MAX_FACT_CHARS} 个汉字；没有新增就输出 []。` +
  '不要输出 JSON 之外的任何内容，不要解释。' +
  '忽略寒暄、一次性话题和隐私敏感信息（密码、住址门牌号、证件号等）。'

function factTexts(facts) {
  const out = []
  for (const item of Array.isArray(facts) ? facts : []) {
    const text = typeof item === 'string' ? item : isPlainObject(item) ? String(item.text ?? '') : ''
    const trimmed = text.trim()
    if (trimmed !== '') out.push(trimmed)
  }
  return out
}

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

function sliceBetween(text, open, close) {
  const start = text.indexOf(open)
  const end = text.lastIndexOf(close)
  if (start === -1 || end <= start) return null
  return text.slice(start, end + 1)
}

/** Turn a parsed JSON array (or object array) into a trimmed string array. */
function toStringList(list) {
  if (!Array.isArray(list)) return []
  return list
    .map((item) => (typeof item === 'string' ? item : isPlainObject(item) ? String(item.text ?? '') : ''))
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/**
 * Tolerantly parse the extraction answer into `{ chatFacts, memberFacts }`.
 * Accepts the new object format, the legacy string array and a prose answer
 * with quoted strings.
 * @returns {{ chatFacts: string[], memberFacts: string[] }}
 */
export function parseExtractedMemory(text) {
  const empty = { chatFacts: [], memberFacts: [] }
  const raw = String(text ?? '').trim()
  if (raw === '') return empty

  const cleaned = raw
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim()

  const objectCandidate = sliceBetween(cleaned, '{', '}')
  if (objectCandidate !== null) {
    try {
      const parsed = JSON.parse(objectCandidate)
      if (isPlainObject(parsed)) {
        return {
          chatFacts: toStringList(parsed.chatFacts ?? parsed.chat_facts ?? parsed.facts),
          memberFacts: toStringList(parsed.memberFacts ?? parsed.member_facts)
        }
      }
    } catch {
      // Fall through to the other formats.
    }
  }

  const arrayCandidate = sliceBetween(cleaned, '[', ']')
  if (arrayCandidate !== null) {
    try {
      const parsed = JSON.parse(arrayCandidate)
      if (Array.isArray(parsed)) return { chatFacts: toStringList(parsed), memberFacts: [] }
    } catch {
      // Fall through to the quoted-string fallback.
    }
  }

  const quoted = []
  const matcher = /"([^"\n]{2,160})"|“([^”\n]{2,160})”/g
  let match
  while ((match = matcher.exec(cleaned)) !== null) {
    const value = (match[1] ?? match[2] ?? '').trim()
    if (value !== '') quoted.push(value)
  }
  return { chatFacts: quoted, memberFacts: [] }
}

/** Legacy helper: parse just the chat facts (kept for backwards compatibility). */
export function parseExtractedFacts(text) {
  return parseExtractedMemory(text).chatFacts
}

function normalizeFactList(list, maxItems = MAX_NEW_FACTS) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(list) ? list : []) {
    const text = clampText(String(item ?? '').trim().replace(/^[-*\d.\s]+/, '').trim(), MAX_FACT_CHARS)
    if (text === '') continue
    const key = factKey(text)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= maxItems) break
  }
  return out
}

function newFactsOnly(candidates, existing) {
  const keys = new Set((Array.isArray(existing) ? existing : []).map((fact) => factKey(fact)))
  return (Array.isArray(candidates) ? candidates : []).filter((fact) => !keys.has(factKey(fact)))
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

  async function upsertSpeakerPerson(userId, name, facts) {
    if (!Array.isArray(facts) || facts.length === 0) return
    if (typeof memoryStore.upsertPerson !== 'function') return
    try {
      await memoryStore.upsertPerson(userId, {
        ...(typeof name === 'string' && name.trim() !== '' ? { name: name.trim().slice(0, 64) } : {}),
        addFacts: facts
      })
    } catch (error) {
      logger?.warn?.('更新用户画像失败', { userId, error: error?.message })
    }
  }

  async function runExtraction(chatId, speaker) {
    const chat = await memoryStore.getChat(chatId)
    const recent = await memoryStore.history(chatId, MAX_TRANSCRIPT_MESSAGES)
    const emptyResult = { extracted: false, facts: [], memberFacts: [], reason: 'empty' }
    if (!Array.isArray(recent) || recent.length === 0) return emptyResult

    const transcript = formatTranscript(recent)
    if (transcript.trim() === '') return emptyResult

    const existingChatFacts = factTexts(chat?.facts).slice(-MAX_PROMPT_FACTS)
    const isGroup = speaker?.isGroup === true && typeof speaker?.userId === 'string' && speaker.userId !== ''
    let existingMemberFacts = []
    let speakerName = typeof speaker?.name === 'string' ? speaker.name.trim().slice(0, 64) : ''

    if (isGroup && typeof memoryStore.getChatMember === 'function') {
      try {
        const member = await memoryStore.getChatMember(chatId, speaker.userId)
        existingMemberFacts = factTexts(member?.facts)
        if (typeof member?.name === 'string' && member.name !== '') speakerName = member.name
      } catch (error) {
        logger?.warn?.('读取群成员记忆失败', { chatId, userId: speaker.userId, error: error?.message })
      }
    }

    const parts = []
    if (existingChatFacts.length > 0) {
      parts.push(`【已有会话记忆】\n${existingChatFacts.map((fact) => `- ${fact}`).join('\n')}`)
    }
    if (isGroup) {
      parts.push(`【当前发言者】${speakerName !== '' ? speakerName : speaker.userId}（ID: ${speaker.userId}）`)
      if (existingMemberFacts.length > 0) {
        parts.push(`【该成员已有记忆】\n${existingMemberFacts.map((fact) => `- ${fact}`).join('\n')}`)
      }
    }
    parts.push(`【最近的对话】\n${transcript}`)
    parts.push('请输出 JSON 对象：{"chatFacts":[...],"memberFacts":[...]}；没有新增事实就输出空数组。')

    let result
    try {
      result = await llmClient.complete({
        system: EXTRACT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: parts.join('\n\n') }],
        maxTokens: 400,
        temperature: 0.2,
        purpose: 'memory-extract'
      })
    } catch (error) {
      logger?.warn?.('记忆抽取失败', { chatId, error: error?.message, code: error?.code })
      return { extracted: false, facts: [], memberFacts: [], reason: 'error', error: error?.message ?? 'extract failed' }
    }

    const parsed = parseExtractedMemory(result?.text)
    let chatFacts = normalizeFactList(parsed.chatFacts)
    let memberFacts = normalizeFactList(parsed.memberFacts)

    // Single chats have no member store: keep everything on the chat record.
    // Group extraction without a usable speaker id falls back the same way so
    // the extracted information is not lost.
    if (!isGroup) {
      chatFacts = normalizeFactList([...chatFacts, ...memberFacts])
      memberFacts = []
    }

    const newChatFacts = newFactsOnly(chatFacts, existingChatFacts)
    const newMemberFacts = isGroup ? newFactsOnly(memberFacts, existingMemberFacts) : []

    try {
      if (chatFacts.length > 0) await memoryStore.addFacts(chatId, chatFacts)
      if (isGroup && memberFacts.length > 0 && typeof memoryStore.addChatMemberFacts === 'function') {
        await memoryStore.addChatMemberFacts(chatId, speaker.userId, memberFacts, { name: speakerName })
      }
      if (typeof memoryStore.setCounters === 'function') {
        await memoryStore.setCounters(chatId, { lastExtractAt: chat?.counters?.userMessages ?? 0 })
      }
    } catch (error) {
      logger?.warn?.('写入长期记忆失败', { chatId, error: error?.message })
      return { extracted: false, facts: [], memberFacts: [], reason: 'error', error: error?.message ?? 'extract failed' }
    }

    if (isGroup) {
      if (newMemberFacts.length > 0) await upsertSpeakerPerson(speaker.userId, speakerName, newMemberFacts)
    } else if (newChatFacts.length > 0) {
      await upsertPersonFromChat(chatId, newChatFacts)
    }

    if (chatFacts.length === 0 && memberFacts.length === 0) {
      logger?.debug?.('记忆抽取完成，无新事实', { chatId })
      return { extracted: false, facts: [], memberFacts: [], reason: 'empty' }
    }
    const extracted = newChatFacts.length > 0 || newMemberFacts.length > 0
    logger?.info?.('记忆抽取完成', { chatId, newChatFacts: newChatFacts.length, newMemberFacts: newMemberFacts.length, isGroup })
    return {
      extracted,
      facts: newChatFacts,
      memberFacts: newMemberFacts,
      ...(extracted ? {} : { reason: 'duplicate' })
    }
  }

  function withInFlight(chatId, speaker) {
    const key = String(chatId)
    const running = inFlight.get(key)
    if (running !== undefined) return running
    const promise = runExtraction(key, speaker).finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key)
    })
    inFlight.set(key, promise)
    return promise
  }

  /**
   * Extract only when enough new user messages accumulated (or when forced).
   * @param {{ chatId: string, force?: boolean, speaker?: { userId?: string, name?: string, isGroup?: boolean } }} [options]
   */
  async function maybeExtract({ chatId, force = false, speaker = null } = {}) {
    if (typeof chatId !== 'string' || chatId === '') {
      return { extracted: false, facts: [], memberFacts: [], reason: 'invalid' }
    }
    const config = readConfig()
    if (config.persona?.memoryEnabled === false) return { extracted: false, facts: [], memberFacts: [], reason: 'disabled' }

    let chat
    try {
      chat = await memoryStore.getChat(chatId)
    } catch (error) {
      logger?.warn?.('读取会话记忆失败', { chatId, error: error?.message })
      return { extracted: false, facts: [], memberFacts: [], reason: 'error', error: error?.message }
    }

    const counters = isPlainObject(chat?.counters) ? chat.counters : {}
    const userMessages = Math.max(0, Number(counters.userMessages) || 0)
    const baseline = Math.max(0, Number(counters.lastExtractAt) || 0)

    if (!force) {
      const every = Math.max(1, Math.round(Number(config.memory?.extractEveryUserMessages) || 8))
      if (userMessages - baseline < every) {
        return { extracted: false, facts: [], memberFacts: [], reason: 'threshold', delta: userMessages - baseline }
      }
    }

    return withInFlight(chatId, speaker)
  }

  /** Force extraction regardless of the message threshold (admin page). */
  async function extractNow(chatId, speaker = null) {
    return maybeExtract({ chatId, force: true, speaker })
  }

  return { maybeExtract, extractNow }
}
