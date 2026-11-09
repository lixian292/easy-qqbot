import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { makeConfigStore, makeLogger, makeTempPaths } from './helpers.mjs'
import { createMemoryStore } from '../host/memory/store.js'

async function setup(overrides = {}) {
  const { paths, cleanup } = await makeTempPaths()
  const configStore = makeConfigStore(overrides.config ?? {})
  const logger = makeLogger()
  const store = createMemoryStore({ paths, configStore, logger })
  await store.init()
  return { paths, cleanup, configStore, logger, store }
}

const now = () => Date.now()

test('getChat 对不存在的会话返回空结构且不落盘', async () => {
  const { paths, cleanup, store } = await setup()
  try {
    const chat = await store.getChat('c2c_missing')
    assert.equal(chat.id, 'c2c_missing')
    assert.deepEqual(chat.history, [])
    assert.equal(chat.summary, null)
    assert.deepEqual(chat.facts, [])
    assert.deepEqual(chat.counters, { userMessages: 0, lastExtractAt: 0 })
    assert.equal(chat.title, '')
    assert.equal(chat.createdAt, 0)
    assert.equal(chat.updatedAt, 0)

    await assert.rejects(fs.access(paths.chatDir('c2c_missing')))
  } finally {
    await cleanup()
  }
})

test('appendMessage 追加历史、计数 user 消息并生成标题', async () => {
  const { cleanup, store } = await setup()
  try {
    const ts = now()
    await store.appendMessage('c2c_u1', { role: 'user', content: '今天天气真不错', ts, userId: 'u1', userName: '小明', msgId: 'm1' })
    await store.appendMessage('c2c_u1', { role: 'assistant', content: '是呀', ts: ts + 1, msgId: 'm2' })

    const history = await store.history('c2c_u1')
    assert.equal(history.length, 2)
    assert.equal(history[0].role, 'user')
    assert.equal(history[1].role, 'assistant')
    assert.equal(history[0].msgId, 'm1')

    const chat = await store.getChat('c2c_u1')
    assert.equal(chat.counters.userMessages, 1)
    assert.ok(chat.title.length > 0)
    assert.ok(chat.title.includes('今天天气'))
    assert.ok(chat.createdAt > 0)
    assert.ok(chat.updatedAt >= chat.createdAt)
  } finally {
    await cleanup()
  }
})

test('history() 支持 limit 与默认 historyLimit', async () => {
  const { cleanup, store } = await setup({ config: { memory: { historyLimit: 3 } } })
  try {
    for (let index = 0; index < 6; index += 1) {
      await store.appendMessage('c2c_u1', { role: index % 2 === 0 ? 'user' : 'assistant', content: `消息${index}`, ts: now() + index })
    }
    assert.equal((await store.history('c2c_u1')).length, 3)
    assert.equal((await store.history('c2c_u1', 2)).length, 2)
    assert.equal((await store.history('c2c_u1', 2))[1].content, '消息5')
    assert.deepEqual(await store.history('c2c_u1', 0), [])
  } finally {
    await cleanup()
  }
})

test('replaceHistory 重写历史，但 userMessages 计数保持单调', async () => {
  const { cleanup, store } = await setup()
  try {
    for (let index = 0; index < 4; index += 1) {
      await store.appendMessage('c2c_u1', { role: 'user', content: `问${index}`, ts: now() + index })
    }
    const before = await store.getChat('c2c_u1')
    assert.equal(before.counters.userMessages, 4)

    await store.replaceHistory('c2c_u1', [
      { role: 'user', content: '保留的问题', ts: now() + 10 },
      { role: 'assistant', content: '保留的回答', ts: now() + 11 }
    ])
    const chat = await store.getChat('c2c_u1')
    assert.equal(chat.history.length, 2)
    assert.equal(chat.counters.userMessages, 4)
  } finally {
    await cleanup()
  }
})

test('setSummary 写入与清除摘要', async () => {
  const { cleanup, store } = await setup()
  try {
    const saved = await store.setSummary('c2c_u1', { text: '之前聊过旅行计划', coveredCount: 6, updatedAt: now() })
    assert.equal(saved.text, '之前聊过旅行计划')
    let chat = await store.getChat('c2c_u1')
    assert.equal(chat.summary.text, '之前聊过旅行计划')
    assert.equal(chat.summary.coveredCount, 6)

    await store.setSummary('c2c_u1', null)
    chat = await store.getChat('c2c_u1')
    assert.equal(chat.summary, null)
  } finally {
    await cleanup()
  }
})

test('addFacts 去重（忽略大小写/空白）并按 maxFacts 截断', async () => {
  const { cleanup, store } = await setup({ config: { memory: { maxFacts: 2 } } })
  try {
    await store.addFacts('c2c_u1', ['用户喜欢猫', ' 用户喜欢猫 ', '用户喜欢狗'])
    let chat = await store.getChat('c2c_u1')
    assert.equal(chat.facts.length, 2)
    assert.equal(chat.facts[0].text, '用户喜欢猫')
    assert.equal(chat.facts[1].text, '用户喜欢狗')

    await store.addFacts('c2c_u1', [{ text: '用户住在杭州', source: 'chat' }])
    chat = await store.getChat('c2c_u1')
    assert.equal(chat.facts.length, 2)
    assert.equal(chat.facts[1].text, '用户住在杭州')

    const replaced = await store.setFacts('c2c_u1', ['用户是程序员'])
    assert.equal(replaced.length, 1)
    assert.equal((await store.getChat('c2c_u1')).facts[0].text, '用户是程序员')
  } finally {
    await cleanup()
  }
})

test('listChats 汇总并按时间倒序', async () => {
  const { cleanup, store } = await setup()
  try {
    const base = now()
    await store.appendMessage('c2c_old', { role: 'user', content: '旧会话', ts: base })
    await store.appendMessage('group_1', { role: 'user', content: '新会话', ts: base + 1000 })
    await store.addFacts('group_1', ['群规：不刷屏'])
    await store.setSummary('group_1', { text: '摘要内容', coveredCount: 1, updatedAt: base + 1000 })

    const chats = await store.listChats()
    assert.equal(chats.length, 2)
    assert.equal(chats[0].chatId, 'group_1')
    assert.equal(chats[0].kind, 'group')
    assert.equal(chats[0].messageCount, 1)
    assert.equal(chats[0].userMessages, 1)
    assert.equal(chats[0].factsCount, 1)
    assert.equal(chats[0].summaryChars, 4)
    assert.equal(chats[1].chatId, 'c2c_old')
    assert.equal(chats[1].kind, 'c2c')
    assert.ok(chats[0].lastAt >= chats[1].lastAt)
  } finally {
    await cleanup()
  }
})

test('clearChat 默认保留长期事实，keepFacts=false 时一并清空', async () => {
  const { cleanup, store } = await setup()
  try {
    await store.appendMessage('c2c_u1', { role: 'user', content: '聊了会儿', ts: now() })
    await store.setSummary('c2c_u1', { text: '摘要', coveredCount: 1, updatedAt: now() })
    await store.addFacts('c2c_u1', ['用户喜欢猫'])

    const cleared = await store.clearChat('c2c_u1')
    assert.deepEqual(cleared.history, [])
    assert.equal(cleared.summary, null)
    assert.equal(cleared.counters.userMessages, 0)
    assert.equal(cleared.facts.length, 1)

    await store.clearChat('c2c_u1', { keepFacts: false })
    assert.equal((await store.getChat('c2c_u1')).facts.length, 0)
  } finally {
    await cleanup()
  }
})

test('people：upsertPerson / getPerson / listPeople', async () => {
  const { cleanup, store } = await setup()
  try {
    assert.equal(await store.getPerson('u1'), null)
    const person = await store.upsertPerson('u1', { name: '小明', addFacts: ['喜欢猫'], messageCount: 2 })
    assert.equal(person.name, '小明')
    assert.equal(person.facts.length, 1)
    assert.equal(person.messageCount, 2)
    assert.ok(person.lastSeen > 0)
    assert.ok(person.createdAt > 0)

    const updated = await store.upsertPerson('u1', { addFacts: ['喜欢猫', '住在杭州'], messageCount: 3 })
    assert.equal(updated.facts.length, 2)
    assert.equal(updated.messageCount, 5)

    const listed = await store.listPeople()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, 'u1')
    assert.equal(listed[0].name, '小明')
  } finally {
    await cleanup()
  }
})

test('损坏的 summary.json 会被备份，其它数据仍可读取', async () => {
  const { paths, cleanup, store } = await setup()
  try {
    await store.appendMessage('c2c_u1', { role: 'user', content: '正常消息', ts: now() })
    const dir = paths.chatDir('c2c_u1')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'summary.json'), '{broken json', 'utf8')

    const freshStore = createMemoryStore({ paths, configStore: makeConfigStore(), logger: makeLogger() })
    const chat = await freshStore.getChat('c2c_u1')
    assert.equal(chat.summary, null)
    assert.equal(chat.history.length, 1)
    const names = await fs.readdir(dir)
    assert.ok(names.some((name) => name.startsWith('summary.json.corrupt-')))
  } finally {
    await cleanup()
  }
})

test('flush 后新实例可以读回历史、摘要与事实', async () => {
  const { paths, cleanup, configStore } = await setup()
  try {
    const store = createMemoryStore({ paths, configStore })
    await store.appendMessage('c2c_u1', { role: 'user', content: '记住我喜欢猫', ts: now(), userId: 'u1' })
    await store.setSummary('c2c_u1', { text: '聊过猫', coveredCount: 1, updatedAt: now() })
    await store.addFacts('c2c_u1', ['用户喜欢猫'])
    await store.flush()

    const reloaded = createMemoryStore({ paths, configStore, logger: makeLogger() })
    const chat = await reloaded.getChat('c2c_u1')
    assert.equal(chat.history.length, 1)
    assert.equal(chat.summary.text, '聊过猫')
    assert.equal(chat.facts.length, 1)
    assert.equal(chat.counters.userMessages, 1)
  } finally {
    await cleanup()
  }
})
