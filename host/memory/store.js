/**
 * Memory store: per-chat message history (JSONL), compressed summary, long
 * term facts and per-user profiles.
 *
 * Layout:
 *   data/chats/<encodeURIComponent(chatId)>/history.jsonl
 *   data/chats/<encodeURIComponent(chatId)>/summary.json
 *   data/chats/<encodeURIComponent(chatId)>/memory.json
 *   data/chats/<encodeURIComponent(chatId)>/state.json
 *   data/chats/<encodeURIComponent(chatId)>/members/<encodeURIComponent(userId)>.json
 *   data/people/<encodeURIComponent(openid)>.json
 *
 * JSON files are replaced atomically; history appends are serialized through a
 * promise chain. Corrupt JSON is backed up as `<file>.corrupt-<ts>`, logged and
 * rebuilt, matching the budget/persona stores.
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { appendJsonl, ensureDir, readJson, readJsonl, writeJsonAtomic } from '../util/fsx.js'
import { shortTitle } from '../util/text.js'

const HISTORY_FILE = 'history.jsonl'
const SUMMARY_FILE = 'summary.json'
const MEMORY_FILE = 'memory.json'
const STATE_FILE = 'state.json'
const MEMBERS_DIR = 'members'
const MAX_FACT_CHARS = 200
const MAX_PERSON_FACTS = 50
const DEFAULT_HISTORY_LIMIT = 40
const DEFAULT_MAX_FACTS = 12

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const numberOrZero = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
const integerOrZero = (value) => Math.max(0, Math.round(numberOrZero(value)))
const genId = () => crypto.randomBytes(6).toString('hex')
const factKey = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, '')
const clampFactText = (text) => String(text ?? '').trim().slice(0, MAX_FACT_CHARS)

function normalizeMessage(raw, fallbackTs = 0) {
  if (!isPlainObject(raw)) return null
  const role = raw.role === 'assistant' ? 'assistant' : raw.role === 'user' ? 'user' : null
  if (role === null) return null
  const ts = Number.isFinite(Number(raw.ts)) ? Math.trunc(Number(raw.ts)) : Math.trunc(numberOrZero(fallbackTs))
  const message = { role, content: String(raw.content ?? ''), ts }
  for (const key of ['userId', 'userName', 'msgId']) {
    if (typeof raw[key] === 'string' && raw[key] !== '') message[key] = raw[key]
  }
  if (Array.isArray(raw.stickerTags)) {
    const tags = raw.stickerTags.filter((tag) => typeof tag === 'string' && tag.trim() !== '')
    if (tags.length > 0) message.stickerTags = tags
  }
  return message
}

function normalizeHistory(raw) {
  const out = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const message = normalizeMessage(item, 0)
    if (message !== null) out.push(message)
  }
  return out
}

function normalizeSummary(raw) {
  if (!isPlainObject(raw)) return null
  const text = typeof raw.text === 'string' ? raw.text : ''
  if (text.trim() === '') return null
  return {
    text,
    coveredCount: integerOrZero(raw.coveredCount),
    updatedAt: integerOrZero(raw.updatedAt)
  }
}

/** Facts may be stored as `["a","b"]` or `{version, facts:[...]}`. */
function normalizeFacts(raw, now = 0) {
  const list = Array.isArray(raw) ? raw : isPlainObject(raw) && Array.isArray(raw.facts) ? raw.facts : []
  const out = []
  const seen = new Set()
  for (const item of list) {
    const isObject = isPlainObject(item)
    const text = clampFactText(typeof item === 'string' ? item : isObject ? String(item.text ?? '') : '')
    if (text === '') continue
    const key = factKey(text)
    if (seen.has(key)) continue
    seen.add(key)
    const fact = {
      id: isObject && typeof item.id === 'string' && item.id !== '' ? item.id : genId(),
      text,
      createdAt: integerOrZero(isObject ? item.createdAt : 0) || now
    }
    if (isObject && item.source !== undefined) fact.source = item.source
    out.push(fact)
  }
  return out
}

/** Accept `string[]` or `[{text, source?}]` and return `[{text, source?}]`. */
function normalizeFactInput(input) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(input) ? input : []) {
    const isObject = isPlainObject(item)
    const text = clampFactText(
      typeof item === 'string' ? item.replace(/^[-*]\s+/, '') : isObject ? String(item.text ?? '').replace(/^[-*]\s+/, '') : ''
    )
    if (text === '') continue
    const key = factKey(text)
    if (seen.has(key)) continue
    seen.add(key)
    const fact = { text }
    if (isObject && item.source !== undefined) fact.source = item.source
    out.push(fact)
  }
  return out
}

function normalizeCounters(raw, historyUserCount, historyLength) {
  const counters = isPlainObject(raw) ? raw : {}
  return {
    userMessages: Math.max(integerOrZero(counters.userMessages), historyUserCount),
    lastExtractAt: integerOrZero(counters.lastExtractAt),
    messageCount: Math.max(integerOrZero(counters.messageCount), historyLength)
  }
}

function normalizePerson(id, raw) {
  const person = {
    id,
    facts: [],
    messageCount: 0,
    lastSeen: 0,
    createdAt: 0
  }
  if (!isPlainObject(raw)) return person
  if (typeof raw.name === 'string' && raw.name.trim() !== '') person.name = raw.name.trim().slice(0, 64)
  person.facts = normalizeFacts(Array.isArray(raw.facts) ? raw.facts : [])
    .map((fact) => fact.text)
    .slice(-MAX_PERSON_FACTS)
  person.messageCount = integerOrZero(raw.messageCount)
  person.lastSeen = integerOrZero(raw.lastSeen)
  person.createdAt = integerOrZero(raw.createdAt)
  return person
}

/** Empty per-chat member record; never persisted on its own. */
function emptyChatMember(chatId, userId) {
  return {
    version: 1,
    id: userId,
    chatId,
    name: '',
    facts: [],
    messageCount: 0,
    updatedAt: 0
  }
}

/**
 * Normalize one `data/chats/<chatId>/members/<userId>.json` record, keeping
 * only the fields documented in MULTIMODAL-MEMBER-DESIGN §5.1.
 */
function normalizeChatMember(raw, chatId, userId) {
  const member = emptyChatMember(chatId, userId)
  if (!isPlainObject(raw)) return member
  member.name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 64) : ''
  member.facts = normalizeFacts(Array.isArray(raw.facts) ? raw.facts : []).map((fact) => ({
    id: fact.id,
    text: fact.text,
    createdAt: fact.createdAt
  }))
  member.messageCount = integerOrZero(raw.messageCount)
  member.updatedAt = integerOrZero(raw.updatedAt)
  return member
}

function cloneChatMember(member) {
  return {
    version: member.version,
    id: member.id,
    chatId: member.chatId,
    name: member.name,
    facts: member.facts.map((fact) => ({ ...fact })),
    messageCount: member.messageCount,
    updatedAt: member.updatedAt
  }
}

/**
 * @param {{ paths: object, configStore: { get(): object }, logger?: object }} deps
 */
export function createMemoryStore({ paths, configStore, logger } = {}) {
  const cache = new Map()
  const loading = new Map()
  let readyPromise = null
  let writeChain = Promise.resolve()

  function enqueue(task) {
    const run = writeChain.then(task, task)
    writeChain = run.then(() => undefined, () => undefined)
    return run
  }

  function ensureReady() {
    if (readyPromise === null) {
      readyPromise = Promise.all([ensureDir(paths.chats), ensureDir(paths.people)]).then(() => undefined)
    }
    return readyPromise
  }

  async function backupCorrupt(file) {
    try {
      await fsp.rename(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      // Best effort only.
    }
  }

  async function readJsonTolerant(file, label) {
    try {
      return await readJson(file, undefined)
    } catch (error) {
      await backupCorrupt(file)
      logger?.warn?.(`${label} 文件损坏，已备份并重建`, { file, error: error?.message })
      return undefined
    }
  }

  async function writeJsonlAtomic(file, rows) {
    await ensureDir(path.dirname(file))
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    const body = rows.map((row) => JSON.stringify(row)).join('\n')
    await fsp.writeFile(tmp, rows.length === 0 ? '' : `${body}\n`, 'utf8')
    await fsp.rename(tmp, file)
  }

  function chatFiles(chatId) {
    const dir = paths.chatDir(chatId)
    return {
      dir,
      history: path.join(dir, HISTORY_FILE),
      summary: path.join(dir, SUMMARY_FILE),
      memory: path.join(dir, MEMORY_FILE),
      state: path.join(dir, STATE_FILE)
    }
  }

  function personFile(openid) {
    return path.join(paths.people, `${encodeURIComponent(String(openid))}.json`)
  }

  function memberFile(chatId, userId) {
    return path.join(paths.chatDir(chatId), MEMBERS_DIR, `${encodeURIComponent(String(userId))}.json`)
  }

  function memberDir(chatId) {
    return path.join(paths.chatDir(chatId), MEMBERS_DIR)
  }

  function stateOf(entry) {
    return {
      version: 1,
      title: entry.title,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      counters: {
        userMessages: entry.counters.userMessages,
        lastExtractAt: entry.counters.lastExtractAt,
        messageCount: entry.counters.messageCount
      }
    }
  }

  function memoryOf(entry) {
    return { version: 1, facts: entry.facts }
  }

  async function loadChat(chatId) {
    await ensureReady()
    const files = chatFiles(chatId)
    const [historyRaw, summaryRaw, memoryRaw, stateRaw] = await Promise.all([
      readJsonl(files.history),
      readJsonTolerant(files.summary, 'summary.json'),
      readJsonTolerant(files.memory, 'memory.json'),
      readJsonTolerant(files.state, 'state.json')
    ])
    const history = normalizeHistory(historyRaw)
    const now = Date.now()
    const facts = normalizeFacts(memoryRaw, now)
    const state = isPlainObject(stateRaw) ? stateRaw : {}
    const counters = normalizeCounters(state.counters, history.filter((message) => message.role === 'user').length, history.length)
    const firstTs = history.length > 0 ? history[0].ts : 0
    const lastTs = history.length > 0 ? history[history.length - 1].ts : 0
    return {
      id: String(chatId),
      history,
      summary: normalizeSummary(summaryRaw),
      facts,
      counters,
      title: typeof state.title === 'string' ? state.title : '',
      createdAt: integerOrZero(state.createdAt) || firstTs || 0,
      updatedAt: integerOrZero(state.updatedAt) || lastTs || 0
    }
  }

  async function cacheEntry(chatId) {
    const key = String(chatId)
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const pending = loading.get(key)
    if (pending !== undefined) return pending
    const promise = loadChat(key)
      .then((entry) => {
        cache.set(key, entry)
        loading.delete(key)
        return entry
      })
      .catch((error) => {
        loading.delete(key)
        throw error
      })
    loading.set(key, promise)
    return promise
  }

  function readConfig() {
    try {
      const config = configStore?.get?.() ?? {}
      return isPlainObject(config) ? config : {}
    } catch (error) {
      logger?.warn?.('读取记忆配置失败，使用默认值', { error: error?.message })
      return {}
    }
  }

  function maxFactsOf(config) {
    const value = Number(config.memory?.maxFacts)
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : DEFAULT_MAX_FACTS
  }

  async function persistState(entry) {
    await writeJsonAtomic(chatFiles(entry.id).state, stateOf(entry))
  }

  function persistMemoryFile(entry) {
    return writeJsonAtomic(chatFiles(entry.id).memory, memoryOf(entry))
  }

  function persistSummaryFile(entry) {
    const files = chatFiles(entry.id)
    if (entry.summary === null) {
      return fsp.unlink(files.summary).catch(() => {})
    }
    return writeJsonAtomic(files.summary, entry.summary)
  }

  async function persistSummaryFileSafe(entry) {
    try {
      await persistSummaryFile(entry)
    } catch (error) {
      logger?.warn?.('摘要写入失败', { chatId: entry.id, error: error?.message })
    }
  }

  /** Ensure directories exist; chat data itself is loaded lazily. */
  async function init() {
    await ensureReady()
  }

  /**
   * Full chat record. Non-existent chats return an empty structure without
   * writing anything to disk.
   */
  async function getChat(chatId) {
    const entry = await cacheEntry(chatId)
    return {
      id: entry.id,
      history: entry.history.map((message) => ({ ...message })),
      summary: entry.summary === null ? null : { ...entry.summary },
      facts: entry.facts.map((fact) => ({ ...fact })),
      counters: {
        userMessages: entry.counters.userMessages,
        lastExtractAt: entry.counters.lastExtractAt
      },
      title: entry.title,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    }
  }

  /** Append one message to history and update counters/title/updatedAt. */
  async function appendMessage(chatId, message) {
    const entry = await cacheEntry(chatId)
    const now = Date.now()
    const normalized = normalizeMessage(message, now)
    if (normalized === null) throw new TypeError('appendMessage: message.role 必须是 user 或 assistant')
    entry.history.push(normalized)
    entry.counters.messageCount = entry.history.length
    if (normalized.role === 'user') {
      entry.counters.userMessages += 1
      if (entry.title === '') {
        entry.title = shortTitle(normalized.content || normalized.userName || '新会话', 24)
      }
    }
    if (!entry.createdAt) entry.createdAt = normalized.ts || now
    entry.updatedAt = Math.max(entry.updatedAt, normalized.ts || now)
    const files = chatFiles(entry.id)
    await enqueue(async () => {
      await appendJsonl(files.history, normalized)
      await writeJsonAtomic(files.state, stateOf(entry))
    })
    return { ...normalized }
  }

  /** Recent messages (old -> new), limited by `limit` or `config.memory.historyLimit`. */
  async function history(chatId, limit) {
    const entry = await cacheEntry(chatId)
    const requested = limit === undefined || limit === null ? Number(readConfig().memory?.historyLimit) : Number(limit)
    const size = Number.isFinite(requested) ? Math.max(0, Math.round(requested)) : DEFAULT_HISTORY_LIMIT
    if (size === 0) return []
    return entry.history.slice(-size).map((message) => ({ ...message }))
  }

  /** Rewrite history.jsonl (used after compression). */
  async function replaceHistory(chatId, messages) {
    const entry = await cacheEntry(chatId)
    const normalized = []
    for (const item of Array.isArray(messages) ? messages : []) {
      const message = normalizeMessage(item, Date.now())
      if (message !== null) normalized.push(message)
    }
    entry.history = normalized
    entry.counters.messageCount = normalized.length
    entry.updatedAt = Date.now()
    await enqueue(async () => {
      await writeJsonlAtomic(chatFiles(entry.id).history, normalized)
      await writeJsonAtomic(chatFiles(entry.id).state, stateOf(entry))
    })
    return normalized.map((message) => ({ ...message }))
  }

  /** Store (or clear with null/empty text) the compressed summary. */
  async function setSummary(chatId, summary) {
    const entry = await cacheEntry(chatId)
    const next = normalizeSummary(summary)
    if (next === null) entry.summary = null
    else {
      entry.summary = {
        text: String(next.text),
        coveredCount: next.coveredCount || entry.summary?.coveredCount || 0,
        updatedAt: next.updatedAt || Date.now()
      }
    }
    entry.updatedAt = Date.now()
    await enqueue(() => persistSummaryFileSafe(entry))
    return entry.summary === null ? null : { ...entry.summary }
  }

  async function persistFacts(entry) {
    await enqueue(() => persistMemoryFile(entry))
  }

  /** Add facts (deduped, newest kept when over `config.memory.maxFacts`). */
  async function addFacts(chatId, facts) {
    const entry = await cacheEntry(chatId)
    const config = readConfig()
    const now = Date.now()
    const incoming = normalizeFactInput(facts)
    const existing = new Set(entry.facts.map((fact) => factKey(fact.text)))
    let added = 0
    for (const item of incoming) {
      const key = factKey(item.text)
      if (key === '' || existing.has(key)) continue
      existing.add(key)
      const fact = { id: genId(), text: item.text, createdAt: now }
      if (item.source !== undefined) fact.source = item.source
      entry.facts.push(fact)
      added += 1
    }
    const maxFacts = maxFactsOf(config)
    const before = entry.facts.length
    if (entry.facts.length > maxFacts) entry.facts = maxFacts === 0 ? [] : entry.facts.slice(-maxFacts)
    const changed = added > 0 || entry.facts.length !== before
    if (changed) entry.updatedAt = now
    if (changed) await persistFacts(entry)
    return entry.facts.map((fact) => ({ ...fact }))
  }

  /** Replace all facts. */
  async function setFacts(chatId, facts) {
    const entry = await cacheEntry(chatId)
    const config = readConfig()
    const now = Date.now()
    const maxFacts = maxFactsOf(config)
    const items = normalizeFactInput(facts).map((item) => {
      const fact = { id: genId(), text: item.text, createdAt: now }
      if (item.source !== undefined) fact.source = item.source
      return fact
    })
    entry.facts = items.length > maxFacts ? (maxFacts === 0 ? [] : items.slice(-maxFacts)) : items
    entry.updatedAt = now
    await persistFacts(entry)
    return entry.facts.map((fact) => ({ ...fact }))
  }

  // ---- per-chat member facts (group chats) ---------------------------------

  /** One member's long-term facts inside a group chat. Empty structure when absent. */
  async function getChatMember(chatId, userId) {
    await ensureReady()
    const chatKey = String(chatId ?? '')
    const userKey = String(userId ?? '')
    if (chatKey === '' || userKey === '') return emptyChatMember(chatKey, userKey)
    const file = memberFile(chatKey, userKey)
    let raw
    try {
      raw = await readJson(file, undefined)
    } catch (error) {
      await backupCorrupt(file)
      logger?.warn?.('群成员记忆文件损坏，已备份', { chatId: chatKey, userId: userKey, error: error?.message })
      return emptyChatMember(chatKey, userKey)
    }
    if (raw === undefined) return emptyChatMember(chatKey, userKey)
    return cloneChatMember(normalizeChatMember(raw, chatKey, userKey))
  }

  async function saveMember(member) {
    await writeJsonAtomic(memberFile(member.chatId, member.id), {
      version: 1,
      id: member.id,
      chatId: member.chatId,
      name: member.name,
      facts: member.facts,
      messageCount: member.messageCount,
      updatedAt: member.updatedAt
    })
  }

  /**
   * Merge facts into one group member's record (deduped, capped to
   * `config.memory.maxFacts`, newest kept). The read+write happens inside the
   * serialized queue so concurrent extractions cannot lose updates.
   */
  async function addChatMemberFacts(chatId, userId, facts, { name } = {}) {
    await ensureReady()
    const chatKey = String(chatId ?? '')
    const userKey = String(userId ?? '')
    if (chatKey === '' || userKey === '') return emptyChatMember(chatKey, userKey)
    const config = readConfig()
    const maxFacts = maxFactsOf(config)
    const now = Date.now()
    let member = null
    await enqueue(async () => {
      const file = memberFile(chatKey, userKey)
      let raw
      try {
        raw = await readJson(file, undefined)
      } catch (error) {
        await backupCorrupt(file)
        logger?.warn?.('群成员记忆文件损坏，已备份并重建', { chatId: chatKey, userId: userKey, error: error?.message })
        raw = undefined
      }
      member = normalizeChatMember(raw, chatKey, userKey)
      if (typeof name === 'string' && name.trim() !== '') member.name = name.trim().slice(0, 64)
      const existing = new Set(member.facts.map((fact) => factKey(fact.text)))
      for (const item of normalizeFactInput(facts)) {
        const key = factKey(item.text)
        if (key === '' || existing.has(key)) continue
        existing.add(key)
        member.facts.push({ id: genId(), text: item.text, createdAt: now })
      }
      if (member.facts.length > maxFacts) member.facts = maxFacts === 0 ? [] : member.facts.slice(-maxFacts)
      member.updatedAt = now
      await saveMember(member)
    })
    return cloneChatMember(member)
  }

  /** All member records of one chat, most recently updated first. */
  async function listChatMembers(chatId) {
    await ensureReady()
    const chatKey = String(chatId ?? '')
    if (chatKey === '') return []
    let entries
    try {
      entries = await fsp.readdir(memberDir(chatKey), { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const members = []
    for (const dirent of entries) {
      if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue
      let userId
      try {
        userId = decodeURIComponent(dirent.name.slice(0, -'.json'.length))
      } catch {
        userId = dirent.name.slice(0, -'.json'.length)
      }
      const file = path.join(memberDir(chatKey), dirent.name)
      let raw
      try {
        raw = await readJson(file, undefined)
      } catch (error) {
        await backupCorrupt(file)
        logger?.warn?.('群成员记忆读取失败，已跳过', { chatId: chatKey, userId, error: error?.message })
        continue
      }
      if (raw === undefined) continue
      members.push(cloneChatMember(normalizeChatMember(raw, chatKey, userId)))
    }
    members.sort((a, b) => b.updatedAt - a.updatedAt)
    return members
  }

  /** Extra (non-contract) helper used by the memory extractor. */
  async function setCounters(chatId, patch) {    const entry = await cacheEntry(chatId)
    if (!isPlainObject(patch)) return { userMessages: entry.counters.userMessages, lastExtractAt: entry.counters.lastExtractAt }
    let changed = false
    for (const key of ['userMessages', 'lastExtractAt', 'messageCount']) {
      if (patch[key] === undefined || patch[key] === null) continue
      const value = Number(patch[key])
      if (!Number.isFinite(value)) continue
      entry.counters[key] = Math.max(0, Math.round(value))
      changed = true
    }
    if (changed) {
      entry.updatedAt = Date.now()
      await enqueue(() => persistState(entry))
    }
    return { userMessages: entry.counters.userMessages, lastExtractAt: entry.counters.lastExtractAt }
  }

  /** Summary of every known chat, newest activity first. */
  async function listChats() {
    await ensureReady()
    let entries = []
    try {
      entries = await fsp.readdir(paths.chats, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const chats = []
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue
      let chatId
      try {
        chatId = decodeURIComponent(dirent.name)
      } catch {
        chatId = dirent.name
      }
      let entry
      try {
        entry = await cacheEntry(chatId)
      } catch (error) {
        logger?.warn?.('读取会话数据失败，已跳过', { chatId, error: error?.message })
        continue
      }
      const lastMessage = entry.history.length > 0 ? entry.history[entry.history.length - 1] : null
      chats.push({
        chatId,
        title: entry.title,
        kind: chatId.startsWith('group_') ? 'group' : 'c2c',
        messageCount: entry.counters.messageCount,
        userMessages: entry.counters.userMessages,
        lastAt: entry.updatedAt || lastMessage?.ts || 0,
        summaryChars: entry.summary === null ? 0 : entry.summary.text.length,
        factsCount: entry.facts.length
      })
    }
    chats.sort((a, b) => b.lastAt - a.lastAt)
    return chats
  }

  /** Clear history + summary; facts are kept unless `keepFacts` is false. */
  async function clearChat(chatId, { keepFacts = true } = {}) {
    const entry = await cacheEntry(chatId)
    const now = Date.now()
    entry.history = []
    entry.summary = null
    entry.counters = { userMessages: 0, lastExtractAt: 0, messageCount: 0 }
    entry.title = ''
    if (!keepFacts) entry.facts = []
    entry.updatedAt = now
    if (!entry.createdAt) entry.createdAt = now
    const files = chatFiles(entry.id)
    await enqueue(async () => {
      await writeJsonlAtomic(files.history, [])
      await fsp.unlink(files.summary).catch(() => {})
      if (!keepFacts) await persistMemoryFile(entry)
      await writeJsonAtomic(files.state, stateOf(entry))
    })
    return getChat(entry.id)
  }

  async function getPerson(openid) {
    await ensureReady()
    const key = String(openid ?? '')
    if (key === '') return null
    let raw
    try {
      raw = await readJson(personFile(key), undefined)
    } catch (error) {
      await backupCorrupt(personFile(key))
      logger?.warn?.('用户画像文件损坏，已备份', { openid: key, error: error?.message })
      return null
    }
    if (raw === undefined) return null
    return normalizePerson(key, raw)
  }

  /** Upsert a person profile. `messageCount` is treated as a delta. */
  async function upsertPerson(openid, patch = {}) {
    await ensureReady()
    const key = String(openid ?? '')
    if (key === '') throw new TypeError('upsertPerson: openid 不能为空')
    const file = personFile(key)
    let raw
    try {
      raw = await readJson(file, undefined)
    } catch (error) {
      await backupCorrupt(file)
      logger?.warn?.('用户画像文件损坏，已备份并重建', { openid: key, error: error?.message })
      raw = undefined
    }
    const person = normalizePerson(key, raw ?? {})
    const now = Date.now()
    if (isPlainObject(patch)) {
      if ('name' in patch) {
        const name = typeof patch.name === 'string' ? patch.name.trim().slice(0, 64) : ''
        if (name === '') delete person.name
        else person.name = name
      }
      if (Array.isArray(patch.addFacts)) {
        const existing = new Set(person.facts.map((text) => factKey(text)))
        for (const item of normalizeFactInput(patch.addFacts)) {
          const factText = item.text
          if (factText === '' || existing.has(factKey(factText))) continue
          existing.add(factKey(factText))
          person.facts.push(factText)
        }
        if (person.facts.length > MAX_PERSON_FACTS) person.facts = person.facts.slice(-MAX_PERSON_FACTS)
      }
      if (patch.messageCount !== undefined && patch.messageCount !== null) {
        const delta = Number(patch.messageCount)
        if (Number.isFinite(delta) && delta > 0) person.messageCount += Math.round(delta)
      }
    }
    if (!person.createdAt) person.createdAt = now
    person.lastSeen = now
    await enqueue(() => writeJsonAtomic(file, person))
    return { ...person, facts: [...person.facts] }
  }

  async function listPeople() {
    await ensureReady()
    let entries = []
    try {
      entries = await fsp.readdir(paths.people, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const people = []
    for (const dirent of entries) {
      if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue
      let id
      try {
        id = decodeURIComponent(dirent.name.slice(0, -'.json'.length))
      } catch {
        id = dirent.name.slice(0, -'.json'.length)
      }
      let raw
      try {
        raw = await readJson(path.join(paths.people, dirent.name), undefined)
      } catch (error) {
        logger?.warn?.('用户画像读取失败，已跳过', { file: dirent.name, error: error?.message })
        continue
      }
      if (raw === undefined) continue
      people.push(normalizePerson(id, raw))
    }
    people.sort((a, b) => b.lastSeen - a.lastSeen)
    return people
  }

  async function flush() {
    await writeChain
  }

  return {
    init,
    getChat,
    appendMessage,
    history,
    replaceHistory,
    setSummary,
    addFacts,
    setFacts,
    setCounters,
    getChatMember,
    addChatMemberFacts,
    listChatMembers,
    listChats,
    clearChat,
    getPerson,
    upsertPerson,
    listPeople,
    flush
  }
}
