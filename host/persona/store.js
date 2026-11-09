/**
 * Persona store: global persona from config plus per-chat and per-user
 * overrides persisted in `data/personas.json`.
 *
 * Resolution priority: user override > chat override > `config.persona`.
 * A field set to `null` (or an empty string) in a patch deletes that field;
 * an override with no remaining fields is dropped entirely.
 */
import fsp from 'node:fs/promises'
import { ensureDir, readJson, writeJsonAtomic } from '../util/fsx.js'

const PERSONA_FIELDS = [
  'name',
  'systemPrompt',
  'style',
  'replyMaxChars',
  'stickerChance',
  'memoryEnabled',
  'compressEnabled',
  'maxHistoryMessages',
  'model',
  'temperature',
  'extraPrompt'
]
const STRING_FIELDS = new Set(['name', 'systemPrompt', 'style', 'model', 'extraPrompt'])
const BOOLEAN_FIELDS = new Set(['memoryEnabled', 'compressEnabled'])
const NUMBER_LIMITS = {
  replyMaxChars: { min: 100, max: 4000, integer: true },
  stickerChance: { min: 0, max: 1 },
  maxHistoryMessages: { min: 2, max: 200, integer: true },
  temperature: { min: 0, max: 2 }
}
const DEFAULT_NAME = '小Q'
const DEFAULT_REPLY_MAX_CHARS = 800
const DEFAULT_STICKER_CHANCE = 0.35
const DEFAULT_MAX_HISTORY_MESSAGES = 40
const DEFAULT_TEMPERATURE = 0.8

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const numberOr = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function clonePatch(patch) {
  return patch === null || patch === undefined ? patch : { ...patch }
}

/**
 * Validate one patch value. `null`/`''` mean "delete this field".
 * Unknown keys are ignored.
 */
function sanitizePatch(raw) {
  if (!isPlainObject(raw)) return {}
  const clean = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!PERSONA_FIELDS.includes(key)) continue
    if (value === null || value === '') {
      clean[key] = null
      continue
    }
    if (STRING_FIELDS.has(key)) {
      if (typeof value !== 'string') continue
      const trimmed = value.trim()
      clean[key] = trimmed === '' ? null : trimmed.slice(0, 8192)
      continue
    }
    if (BOOLEAN_FIELDS.has(key)) {
      if (typeof value !== 'boolean') continue
      clean[key] = value
      continue
    }
    const limits = NUMBER_LIMITS[key]
    if (limits === undefined) continue
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) continue
    clean[key] = clamp(limits.integer === true ? Math.round(parsed) : parsed, limits.min, limits.max)
  }
  return clean
}

function applyPatch(base, patch) {
  const next = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next
}

function emptyData() {
  return { version: 1, chats: {}, users: {} }
}

function normalizeData(raw) {
  const data = emptyData()
  if (!isPlainObject(raw)) return data
  if (isPlainObject(raw.chats)) {
    for (const [chatId, patch] of Object.entries(raw.chats)) {
      if (typeof chatId !== 'string' || chatId === '') continue
      const clean = sanitizePatch(patch)
      if (Object.keys(clean).length > 0) data.chats[chatId] = clean
    }
  }
  if (isPlainObject(raw.users)) {
    for (const [userId, patch] of Object.entries(raw.users)) {
      if (typeof userId !== 'string' || userId === '') continue
      const clean = sanitizePatch(patch)
      if (Object.keys(clean).length > 0) data.users[userId] = clean
    }
  }
  return data
}

/**
 * @param {{ paths: object, configStore: { get(): object }, logger?: object }} deps
 */
export function createPersonaStore({ paths, configStore, logger } = {}) {
  let data = null
  let loadPromise = null
  let writeChain = Promise.resolve()

  function enqueue(task) {
    const run = writeChain.then(task, task)
    writeChain = run.then(() => undefined, () => undefined)
    return run
  }

  async function backupCorrupt() {
    try {
      await fsp.rename(paths.personas, `${paths.personas}.corrupt-${Date.now()}`)
    } catch {
      // Best effort only.
    }
  }

  async function loadData() {
    let raw
    try {
      raw = await readJson(paths.personas, undefined)
    } catch (error) {
      await backupCorrupt()
      logger?.warn?.('个性化配置文件损坏，已备份并重建', { file: paths.personas, error: error?.message })
      raw = undefined
    }
    data = normalizeData(raw)
    return data
  }

  async function ensureLoaded() {
    if (data !== null) return data
    if (loadPromise === null) loadPromise = loadData()
    return loadPromise
  }

  async function persist() {
    try {
      await ensureDir(paths.data)
      await writeJsonAtomic(paths.personas, { version: 1, chats: data.chats, users: data.users })
    } catch (error) {
      logger?.warn?.('个性化配置写入失败', { error: error?.message })
    }
  }

  function readConfig() {
    try {
      const config = configStore?.get?.() ?? {}
      return isPlainObject(config) ? config : {}
    } catch (error) {
      logger?.warn?.('读取个性化配置失败，使用默认值', { error: error?.message })
      return {}
    }
  }

  function updateOverride(scope, id, patch) {
    const key = String(id ?? '')
    if (key === '') return null
    const bucket = data[scope]
    const clean = sanitizePatch(patch)
    const next = applyPatch(bucket[key] ?? {}, clean)
    if (Object.keys(next).length === 0) delete bucket[key]
    else bucket[key] = next
    return bucket[key] === undefined ? null : clonePatch(bucket[key])
  }

  /** Load `data/personas.json` into memory (idempotent). */
  async function init() {
    await ensureLoaded()
    return { chats: { ...data.chats }, users: { ...data.users } }
  }

  /**
   * Merge the effective persona for one conversation.
   * `kind` is accepted for logging/record purposes only and does not affect the merge.
   */
  async function resolve({ chatId, userId } = {}) {
    await ensureLoaded()
    const config = readConfig()
    const base = isPlainObject(config.persona) ? config.persona : {}
    const llm = isPlainObject(config.llm) ? config.llm : {}

    const chatKey = String(chatId ?? '')
    const userKey = String(userId ?? '')
    const chatPatch = chatKey !== '' ? data.chats[chatKey] ?? {} : {}
    const userPatch = userKey !== '' ? data.users[userKey] ?? {} : {}
    const merged = { ...base, ...chatPatch, ...userPatch }

    const effective = {
      name: String(merged.name ?? base.name ?? DEFAULT_NAME).trim() || DEFAULT_NAME,
      systemPrompt: String(merged.systemPrompt ?? base.systemPrompt ?? ''),
      style: String(merged.style ?? base.style ?? ''),
      replyMaxChars: clamp(
        Math.round(numberOr(merged.replyMaxChars, numberOr(base.replyMaxChars, DEFAULT_REPLY_MAX_CHARS))),
        100,
        4000
      ),
      stickerChance: clamp(numberOr(merged.stickerChance, numberOr(base.stickerChance, DEFAULT_STICKER_CHANCE)), 0, 1),
      memoryEnabled: typeof merged.memoryEnabled === 'boolean' ? merged.memoryEnabled : base.memoryEnabled !== false,
      compressEnabled: typeof merged.compressEnabled === 'boolean' ? merged.compressEnabled : base.compressEnabled !== false,
      maxHistoryMessages: clamp(
        Math.round(numberOr(merged.maxHistoryMessages, numberOr(base.maxHistoryMessages, DEFAULT_MAX_HISTORY_MESSAGES))),
        2,
        200
      ),
      model: typeof merged.model === 'string' && merged.model !== '' ? merged.model : llm.model,
      temperature: clamp(numberOr(merged.temperature, numberOr(llm.temperature, DEFAULT_TEMPERATURE)), 0, 2)
    }
    const extraPrompt = typeof merged.extraPrompt === 'string' ? merged.extraPrompt.trim() : ''
    if (extraPrompt !== '') effective.extraPrompt = extraPrompt
    return effective
  }

  /** Chat level override or null. */
  async function get(chatId) {
    await ensureLoaded()
    const key = String(chatId ?? '')
    if (key === '' || data.chats[key] === undefined) return null
    return clonePatch(data.chats[key])
  }

  /** Partially update a chat level override. Returns the new override or null. */
  async function set(chatId, patch) {
    await ensureLoaded()
    const next = updateOverride('chats', chatId, patch)
    await enqueue(persist)
    return next
  }

  /** Partially update a user level override. Returns the new override or null. */
  async function setUser(userId, patch) {
    await ensureLoaded()
    const next = updateOverride('users', userId, patch)
    await enqueue(persist)
    return next
  }

  async function remove(chatId) {
    await ensureLoaded()
    const key = String(chatId ?? '')
    if (key !== '') delete data.chats[key]
    await enqueue(persist)
  }

  async function removeUser(userId) {
    await ensureLoaded()
    const key = String(userId ?? '')
    if (key !== '') delete data.users[key]
    await enqueue(persist)
  }

  async function list() {
    await ensureLoaded()
    return {
      chats: Object.fromEntries(Object.entries(data.chats).map(([key, patch]) => [key, clonePatch(patch)])),
      users: Object.fromEntries(Object.entries(data.users).map(([key, patch]) => [key, clonePatch(patch)]))
    }
  }

  async function flush() {
    await writeChain
  }

  return { init, resolve, get, set, setUser, remove, removeUser, list, flush }
}
