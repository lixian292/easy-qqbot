import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { makeConfigStore, makeLogger, makeTempPaths } from './helpers.mjs'
import { createBudgetStore } from '../host/budget/store.js'

async function setup(overrides = {}) {
  const { paths, root, cleanup } = await makeTempPaths()
  const configStore = makeConfigStore(overrides.config ?? {})
  const logger = makeLogger()
  const store = createBudgetStore({ paths, configStore, logger })
  return { paths, root, cleanup, configStore, logger, store }
}

async function listCorruptBackups(dir) {
  try {
    const names = await fs.readdir(dir)
    return names.filter((name) => name.includes('.corrupt-'))
  } catch {
    return []
  }
}

test('budget.enabled=false 时放行并返回 disabled', async () => {
  const { store, cleanup } = await setup({ config: { budget: { enabled: false } } })
  try {
    const check = await store.check({ chatId: 'c2c_u1', userId: 'u1' })
    assert.equal(check.allowed, true)
    assert.equal(check.reason, 'disabled')
    assert.deepEqual(check.limits, {
      dailyTokens: 200000,
      monthlyTokens: 3000000,
      perChatDailyTokens: 50000,
      dailyCalls: 1000
    })
  } finally {
    await cleanup()
  }
})

test('正常记录：累加 today/month/chat，并计算费用', async () => {
  const { store, cleanup, paths } = await setup({
    config: { budget: { priceInPerMillion: 10, priceOutPerMillion: 30 } }
  })
  try {
    const check = await store.check({ chatId: 'c2c_u1', userId: 'u1' })
    assert.equal(check.allowed, true)
    assert.equal(check.reason, 'ok')
    assert.equal(check.usage.calls, 0)

    const usage = await store.record({
      chatId: 'c2c_u1',
      userId: 'u1',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      usage: { inputTokens: 1000000, outputTokens: 500000 }
    })
    assert.equal(usage.inputTokens, 1000000)
    assert.equal(usage.outputTokens, 500000)
    assert.equal(usage.totalTokens, 1500000)
    assert.equal(usage.cost, 25) // 1M*10/1M + 0.5M*30/1M = 10 + 15

    const snapshot = await store.snapshot()
    assert.equal(snapshot.currency, 'CNY')
    assert.match(snapshot.date, /^\d{4}-\d{2}-\d{2}$/)
    assert.match(snapshot.monthKey, /^\d{4}-\d{2}$/)
    assert.equal(snapshot.today.calls, 1)
    assert.equal(snapshot.today.totalTokens, 1500000)
    assert.equal(snapshot.today.cost, 25)
    assert.equal(snapshot.month.totalTokens, 1500000)
    assert.equal(snapshot.chats.length, 1)
    assert.equal(snapshot.chats[0].chatId, 'c2c_u1')
    assert.equal(snapshot.chats[0].totalTokens, 1500000)
    assert.ok(snapshot.chats[0].lastAt > 0)

    await store.flush()
    const eventsRaw = await fs.readFile(paths.budgetEvents, 'utf8')
    const events = eventsRaw.trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(events.length, 1)
    assert.equal(events[0].inputTokens, 1000000)
    assert.equal(events[0].provider, 'deepseek-official')
    assert.equal(events[0].chatId, 'c2c_u1')
  } finally {
    await cleanup()
  }
})

test('超过日 token 限额时拒绝', async () => {
  const { store, cleanup } = await setup({ config: { budget: { dailyTokens: 100, dailyCalls: 0 } } })
  try {
    await store.record({ chatId: 'c2c_u1', usage: { inputTokens: 60, outputTokens: 0 } })
    let check = await store.check({ chatId: 'c2c_u1' })
    assert.equal(check.allowed, true)
    await store.record({ chatId: 'c2c_u1', usage: { inputTokens: 40, outputTokens: 0 } })
    check = await store.check({ chatId: 'c2c_u1' })
    assert.equal(check.allowed, false)
    assert.equal(check.reason, 'daily')
    assert.equal(check.usage.totalTokens, 100)
  } finally {
    await cleanup()
  }
})

test('超过单会话日限额时只拒绝该会话', async () => {
  const { store, cleanup } = await setup({ config: { budget: { perChatDailyTokens: 50 } } })
  try {
    await store.record({ chatId: 'c2c_a', usage: { inputTokens: 80, outputTokens: 0 } })
    const chatA = await store.check({ chatId: 'c2c_a' })
    assert.equal(chatA.allowed, false)
    assert.equal(chatA.reason, 'chat')
    const chatB = await store.check({ chatId: 'c2c_b' })
    assert.equal(chatB.allowed, true)
  } finally {
    await cleanup()
  }
})

test('超过每日调用次数限额时拒绝', async () => {
  const { store, cleanup } = await setup({ config: { budget: { dailyCalls: 1, dailyTokens: 0, monthlyTokens: 0, perChatDailyTokens: 0 } } })
  try {
    await store.record({ chatId: 'c2c_u1', usage: { inputTokens: 1, outputTokens: 1 } })
    const check = await store.check({ chatId: 'c2c_u1' })
    assert.equal(check.allowed, false)
    assert.equal(check.reason, 'calls')
  } finally {
    await cleanup()
  }
})

test('recent() 返回最近调用明细（新→旧）', async () => {
  const { store, cleanup } = await setup()
  try {
    await store.record({ chatId: 'c2c_u1', usage: { inputTokens: 10, outputTokens: 1 } })
    await store.record({ chatId: 'c2c_u1', usage: { inputTokens: 20, outputTokens: 2 } })
    const newest = await store.recent(1)
    assert.equal(newest.length, 1)
    assert.equal(newest[0].inputTokens, 20)
    const all = await store.recent()
    assert.equal(all.length, 2)
    assert.equal(all[0].inputTokens, 20)
    assert.equal(all[1].inputTokens, 10)
    assert.deepEqual(await store.recent(0), [])
  } finally {
    await cleanup()
  }
})

test('reset() 支持 today / all', async () => {
  const { store, cleanup } = await setup()
  try {
    await store.record({ chatId: 'c2c_u1', usage: { inputTokens: 100, outputTokens: 10 } })
    const todayReset = await store.reset('today')
    assert.equal(todayReset.today.calls, 0)
    assert.equal(todayReset.today.totalTokens, 0)
    assert.equal(todayReset.month.totalTokens, 110)

    await store.record({ chatId: 'c2c_u1', usage: { inputTokens: 5, outputTokens: 5 } })
    const allReset = await store.reset('all')
    assert.equal(allReset.today.calls, 0)
    assert.equal(allReset.month.totalTokens, 0)
    assert.equal((await store.recent()).length, 2) // reset never deletes the audit log
  } finally {
    await cleanup()
  }
})

test('损坏的 usage.json 会被备份并重建', async () => {
  const { paths, cleanup, store, logger } = await setup()
  try {
    await fs.writeFile(paths.budgetUsage, '{ this is not json', 'utf8')
    const check = await store.check({ chatId: 'c2c_u1' })
    assert.equal(check.allowed, true)
    const backups = await listCorruptBackups(paths.budget)
    assert.equal(backups.length, 1)
    assert.ok(logger.entries.some((entry) => entry.level === 'warn'))

    await store.record({ chatId: 'c2c_u1', usage: { inputTokens: 7, outputTokens: 3 } })
    const snapshot = await store.snapshot()
    assert.equal(snapshot.today.totalTokens, 10)
    const persisted = JSON.parse(await fs.readFile(paths.budgetUsage, 'utf8'))
    assert.ok(persisted.days[snapshot.date])
  } finally {
    await cleanup()
  }
})

test('并发 record 不会丢计数（串行化写入）', async () => {
  const { store, cleanup, paths } = await setup()
  try {
    await Promise.all(
      Array.from({ length: 5 }, (_, index) => store.record({ chatId: 'c2c_u1', userId: 'u1', usage: { inputTokens: index + 1, outputTokens: 0 } }))
    )
    const snapshot = await store.snapshot()
    assert.equal(snapshot.today.calls, 5)
    assert.equal(snapshot.today.inputTokens, 15)
    assert.equal(snapshot.month.calls, 5)
    assert.equal((await store.recent()).length, 5)
    const persisted = JSON.parse(await fs.readFile(paths.budgetUsage, 'utf8'))
    assert.ok(persisted.days[snapshot.date])
  } finally {
    await cleanup()
  }
})
