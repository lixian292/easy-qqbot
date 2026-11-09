/**
 * Budget store: token / cost accounting and three level limit checks
 * (daily, monthly, per-chat daily) plus a daily call cap.
 *
 * Storage:
 *   data/budget/usage.json   aggregated counters (last 62 days, 24 months)
 *   data/budget/events.jsonl append-only per-call detail
 *
 * Every write is funneled through one promise chain so concurrent calls are
 * serialized, and JSON files are replaced atomically. A corrupt usage file is
 * backed up as `usage.json.corrupt-<ts>` and rebuilt from scratch.
 */
import fsp from 'node:fs/promises'
import { appendJsonl, ensureDir, readJson, readJsonl, writeJsonAtomic } from '../util/fsx.js'
import { formatDate, formatMonth } from '../util/text.js'

const MAX_DAYS = 62
const MAX_MONTHS = 24
const MAX_EVENTS = 500
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_KEY_RE = /^\d{4}-\d{2}$/

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const numberOrZero = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
const integerOrZero = (value) => Math.max(0, Math.round(numberOrZero(value)))
const roundCost = (value) => Math.round(numberOrZero(value) * 1e6) / 1e6

function emptyCounters() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }
}

function emptyUsageEntry() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, lastAt: 0 }
}

function emptyDay() {
  return { ...emptyCounters(), chats: {}, users: {} }
}

function normalizeCounters(raw) {
  const out = emptyCounters()
  if (!isPlainObject(raw)) return out
  out.calls = integerOrZero(raw.calls)
  out.inputTokens = integerOrZero(raw.inputTokens)
  out.outputTokens = integerOrZero(raw.outputTokens)
  out.totalTokens = integerOrZero(raw.totalTokens) || out.inputTokens + out.outputTokens
  out.cost = roundCost(raw.cost)
  return out
}

function normalizeUsageEntry(raw) {
  const out = emptyUsageEntry()
  if (!isPlainObject(raw)) return out
  const counters = normalizeCounters(raw)
  Object.assign(out, counters)
  out.lastAt = integerOrZero(raw.lastAt)
  return out
}

function normalizeEntryMap(raw) {
  const out = {}
  if (!isPlainObject(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || key === '') continue
    out[key] = normalizeUsageEntry(value)
  }
  return out
}

function normalizeDay(raw) {
  const out = emptyDay()
  if (!isPlainObject(raw)) return out
  const counters = normalizeCounters(raw)
  out.calls = counters.calls
  out.inputTokens = counters.inputTokens
  out.outputTokens = counters.outputTokens
  out.totalTokens = counters.totalTokens
  out.cost = counters.cost
  out.chats = normalizeEntryMap(raw.chats)
  out.users = normalizeEntryMap(raw.users)
  return out
}

function normalizeMonth(raw) {
  return normalizeCounters(raw)
}

function normalizeState(raw) {
  const state = { version: 1, updatedAt: 0, days: {}, months: {} }
  if (!isPlainObject(raw)) return state
  state.updatedAt = integerOrZero(raw.updatedAt)
  if (isPlainObject(raw.days)) {
    for (const [key, value] of Object.entries(raw.days)) {
      if (DAY_KEY_RE.test(key)) state.days[key] = normalizeDay(value)
    }
  }
  if (isPlainObject(raw.months)) {
    for (const [key, value] of Object.entries(raw.months)) {
      if (MONTH_KEY_RE.test(key)) state.months[key] = normalizeMonth(value)
    }
  }
  return state
}

function addCounters(target, inputTokens, outputTokens, totalTokens, cost) {
  target.calls += 1
  target.inputTokens += inputTokens
  target.outputTokens += outputTokens
  target.totalTokens += totalTokens
  target.cost = roundCost(target.cost + cost)
}

/**
 * @param {{ paths: object, configStore: { get(): object }, logger?: object }} deps
 */
export function createBudgetStore({ paths, configStore, logger } = {}) {
  let state = null
  let loadPromise = null
  let writeChain = Promise.resolve()

  function enqueue(task) {
    const run = writeChain.then(task, task)
    writeChain = run.then(() => undefined, () => undefined)
    return run
  }

  async function backupCorrupt(file) {
    try {
      await fsp.rename(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      // Best effort only; the caller rebuilds the in-memory state anyway.
    }
  }

  function prune() {
    const dayKeys = Object.keys(state.days).sort()
    while (dayKeys.length > MAX_DAYS) {
      const oldest = dayKeys.shift()
      delete state.days[oldest]
    }
    const monthKeys = Object.keys(state.months).sort()
    while (monthKeys.length > MAX_MONTHS) {
      const oldest = monthKeys.shift()
      delete state.months[oldest]
    }
  }

  async function loadState() {
    let raw
    try {
      raw = await readJson(paths.budgetUsage, undefined)
    } catch (error) {
      await backupCorrupt(paths.budgetUsage)
      logger?.warn?.('预算用量文件损坏，已备份并重建', { file: paths.budgetUsage, error: error?.message })
      raw = undefined
    }
    state = normalizeState(raw)
    prune()
    return state
  }

  async function ensureLoaded() {
    if (state !== null) return state
    if (loadPromise === null) loadPromise = loadState()
    return loadPromise
  }

  async function persistSafe() {
    try {
      await ensureDir(paths.budget)
      state.updatedAt = Date.now()
      await writeJsonAtomic(paths.budgetUsage, state)
    } catch (error) {
      logger?.warn?.('预算用量写入失败', { error: error?.message })
    }
  }

  function readConfig() {
    let config
    try {
      config = configStore?.get?.() ?? {}
    } catch (error) {
      logger?.warn?.('读取预算配置失败，使用默认值', { error: error?.message })
      config = {}
    }
    return isPlainObject(config) ? config : {}
  }

  function limitsOf(config) {
    const budget = isPlainObject(config.budget) ? config.budget : {}
    return {
      dailyTokens: integerOrZero(budget.dailyTokens),
      monthlyTokens: integerOrZero(budget.monthlyTokens),
      perChatDailyTokens: integerOrZero(budget.perChatDailyTokens),
      dailyCalls: integerOrZero(budget.dailyCalls)
    }
  }

  function ensureDay(dateKey) {
    if (!isPlainObject(state.days[dateKey])) state.days[dateKey] = emptyDay()
    return state.days[dateKey]
  }

  function ensureMonth(monthKey) {
    if (!isPlainObject(state.months[monthKey])) state.months[monthKey] = emptyCounters()
    return state.months[monthKey]
  }

  /**
   * Check whether another LLM call is allowed for this chat / user.
   * @param {{ chatId?: string, userId?: string }} [options]
   */
  async function check({ chatId, userId } = {}) {
    const config = readConfig()
    const budget = isPlainObject(config.budget) ? config.budget : {}
    const limits = limitsOf(config)
    await ensureLoaded()

    const now = Date.now()
    const day = state.days[formatDate(now)] ?? emptyDay()
    const month = state.months[formatMonth(now)] ?? emptyCounters()
    const chatKey = typeof chatId === 'string' && chatId !== '' ? chatId : ''
    const chat = chatKey !== '' ? (day.chats[chatKey] ?? emptyUsageEntry()) : null

    const usage = {
      calls: day.calls,
      inputTokens: day.inputTokens,
      outputTokens: day.outputTokens,
      totalTokens: day.totalTokens,
      cost: roundCost(day.cost)
    }

    if (budget.enabled === false) {
      return { allowed: true, reason: 'disabled', usage, limits }
    }

    let reason = 'ok'
    if (limits.dailyTokens > 0 && usage.totalTokens >= limits.dailyTokens) reason = 'daily'
    else if (limits.monthlyTokens > 0 && month.totalTokens >= limits.monthlyTokens) reason = 'monthly'
    else if (limits.perChatDailyTokens > 0 && chat !== null && chat.totalTokens >= limits.perChatDailyTokens) reason = 'chat'
    else if (limits.dailyCalls > 0 && usage.calls >= limits.dailyCalls) reason = 'calls'

    return { allowed: reason === 'ok', reason, usage, limits }
  }

  /**
   * Record one LLM call.
   * @param {{ chatId?: string, userId?: string, provider?: string, model?: string, usage?: { inputTokens?: number, outputTokens?: number } }} [options]
   * @returns {Promise<{ inputTokens: number, outputTokens: number, totalTokens: number, cost: number }>}
   */
  async function record({ chatId, userId, provider, model, usage } = {}) {
    const config = readConfig()
    const budget = isPlainObject(config.budget) ? config.budget : {}
    const priceIn = numberOrZero(budget.priceInPerMillion)
    const priceOut = numberOrZero(budget.priceOutPerMillion)
    const currency = typeof budget.currency === 'string' && budget.currency !== '' ? budget.currency : 'CNY'

    await ensureLoaded()

    const now = Date.now()
    const inputTokens = integerOrZero(usage?.inputTokens)
    const outputTokens = integerOrZero(usage?.outputTokens)
    const totalTokens = inputTokens + outputTokens
    const cost = roundCost((inputTokens / 1e6) * priceIn + (outputTokens / 1e6) * priceOut)
    const dateKey = formatDate(now)
    const monthKey = formatMonth(now)

    const day = ensureDay(dateKey)
    const month = ensureMonth(monthKey)
    addCounters(day, inputTokens, outputTokens, totalTokens, cost)
    addCounters(month, inputTokens, outputTokens, totalTokens, cost)

    const chatKey = typeof chatId === 'string' && chatId !== '' ? chatId : ''
    if (chatKey !== '') {
      if (!isPlainObject(day.chats[chatKey])) day.chats[chatKey] = emptyUsageEntry()
      const chatEntry = day.chats[chatKey]
      addCounters(chatEntry, inputTokens, outputTokens, totalTokens, cost)
      chatEntry.lastAt = now
    }

    const userKey = typeof userId === 'string' && userId !== '' ? userId : ''
    if (userKey !== '') {
      if (!isPlainObject(day.users[userKey])) day.users[userKey] = emptyUsageEntry()
      const userEntry = day.users[userKey]
      addCounters(userEntry, inputTokens, outputTokens, totalTokens, cost)
      userEntry.lastAt = now
    }

    prune()

    const event = {
      ts: now,
      date: dateKey,
      month: monthKey,
      provider: typeof provider === 'string' ? provider : '',
      model: typeof model === 'string' ? model : '',
      chatId: chatKey,
      userId: userKey,
      inputTokens,
      outputTokens,
      totalTokens,
      cost,
      currency
    }

    await enqueue(async () => {
      await persistSafe()
      try {
        await appendJsonl(paths.budgetEvents, event)
      } catch (error) {
        logger?.warn?.('预算事件写入失败', { error: error?.message })
      }
    })

    logger?.debug?.('预算记录', { chatId: chatKey, provider: event.provider, model: event.model, inputTokens, outputTokens, cost })

    return { inputTokens, outputTokens, totalTokens, cost }
  }

  /**
   * Aggregated view used by the admin page and the `#预算` command.
   * Note: `month` is the month usage object; the month key is `monthKey`.
   */
  async function snapshot() {
    const config = readConfig()
    await ensureLoaded()

    const now = Date.now()
    const dateKey = formatDate(now)
    const monthKey = formatMonth(now)
    const day = state.days[dateKey] ?? emptyDay()
    const month = state.months[monthKey] ?? emptyCounters()

    const chatAggregates = new Map()
    for (const bucket of Object.values(state.days)) {
      for (const [chatId, entry] of Object.entries(bucket.chats ?? {})) {
        if (!chatAggregates.has(chatId)) chatAggregates.set(chatId, emptyUsageEntry())
        const aggregate = chatAggregates.get(chatId)
        aggregate.calls += entry.calls
        aggregate.inputTokens += entry.inputTokens
        aggregate.outputTokens += entry.outputTokens
        aggregate.totalTokens += entry.totalTokens
        aggregate.cost = roundCost(aggregate.cost + entry.cost)
        if (entry.lastAt > aggregate.lastAt) aggregate.lastAt = entry.lastAt
      }
    }
    const chats = [...chatAggregates.entries()]
      .map(([chatId, entry]) => ({
        chatId,
        calls: entry.calls,
        totalTokens: entry.totalTokens,
        cost: roundCost(entry.cost),
        lastAt: entry.lastAt
      }))
      .sort((a, b) => b.lastAt - a.lastAt)

    return {
      date: dateKey,
      monthKey,
      today: {
        calls: day.calls,
        inputTokens: day.inputTokens,
        outputTokens: day.outputTokens,
        totalTokens: day.totalTokens,
        cost: roundCost(day.cost)
      },
      month: {
        calls: month.calls,
        inputTokens: month.inputTokens,
        outputTokens: month.outputTokens,
        totalTokens: month.totalTokens,
        cost: roundCost(month.cost)
      },
      chats,
      limits: limitsOf(config),
      currency: typeof config.budget?.currency === 'string' && config.budget.currency !== '' ? config.budget.currency : 'CNY'
    }
  }

  /** Recent call events, newest first. */
  async function recent(limit = 50) {
    const requested = Number(limit)
    const size = Number.isFinite(requested) ? Math.max(0, Math.min(Math.round(requested), MAX_EVENTS)) : 50
    if (size === 0) return []
    const events = await readJsonl(paths.budgetEvents)
    return events.filter((event) => isPlainObject(event)).slice(-size).reverse()
  }

  /** Reset the current day/month (or everything) and return a fresh snapshot. */
  async function reset(scope = 'today') {
    await ensureLoaded()
    const now = Date.now()
    if (scope === 'today') delete state.days[formatDate(now)]
    else if (scope === 'month') delete state.months[formatMonth(now)]
    else if (scope === 'all') {
      state.days = {}
      state.months = {}
    }
    await enqueue(persistSafe)
    logger?.info?.('预算已重置', { scope })
    return snapshot()
  }

  /** Wait for all pending writes to reach disk. */
  async function flush() {
    await writeChain
  }

  return { check, record, snapshot, recent, reset, flush }
}
