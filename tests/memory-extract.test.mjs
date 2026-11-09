import test from 'node:test'
import assert from 'node:assert/strict'

import { makeConfigStore, makeFakeLlm, makeLogger, makeTempPaths } from './helpers.mjs'
import { createMemoryStore } from '../host/memory/store.js'
import { createMemoryExtractor, parseExtractedFacts } from '../host/memory/extract.js'

async function setup({ config = {}, llm = makeFakeLlm({ reply: '[]' }) } = {}) {
  const { paths, cleanup } = await makeTempPaths()
  const configStore = makeConfigStore({
    ...config,
    memory: { extractEveryUserMessages: 3, maxFacts: 12, ...(config.memory ?? {}) }
  })
  const logger = makeLogger()
  const memoryStore = createMemoryStore({ paths, configStore, logger })
  await memoryStore.init()
  const extractor = createMemoryExtractor({ configStore, llmClient: llm, memoryStore, logger })
  return { paths, cleanup, configStore, logger, memoryStore, llm, extractor }
}

async function seedConversation(memoryStore, chatId, userMessages, { userId = 'u1', userName = '小明' } = {}) {
  const ts = Date.now()
  for (let index = 0; index < userMessages; index += 1) {
    await memoryStore.appendMessage(chatId, {
      role: 'user',
      content: `第${index + 1}句：我最近在学做饭`,
      ts: ts + index * 2,
      userId,
      userName,
      msgId: `m${index}`
    })
    await memoryStore.appendMessage(chatId, { role: 'assistant', content: '听起来不错', ts: ts + index * 2 + 1 })
  }
}

test('用户消息增量不足时不抽取', async () => {
  const { cleanup, memoryStore, extractor, llm } = await setup()
  try {
    await seedConversation(memoryStore, 'c2c_u1', 2)
    const result = await extractor.maybeExtract({ chatId: 'c2c_u1' })
    assert.equal(result.extracted, false)
    assert.equal(result.reason, 'threshold')
    assert.equal(llm.calls.length, 0)
  } finally {
    await cleanup()
  }
})

test('extractNow 强制抽取并写入 facts / 用户画像', async () => {
  const { cleanup, memoryStore, extractor, llm } = await setup({
    llm: makeFakeLlm({ reply: '```json\n["用户喜欢猫","用户是程序员"]\n```' })
  })
  try {
    await seedConversation(memoryStore, 'c2c_u1', 1)
    const result = await extractor.extractNow('c2c_u1')
    assert.equal(result.extracted, true)
    assert.deepEqual(result.facts, ['用户喜欢猫', '用户是程序员'])
    assert.equal(llm.calls.length, 1)
    assert.equal(llm.calls[0].purpose, 'memory-extract')

    const chat = await memoryStore.getChat('c2c_u1')
    assert.equal(chat.facts.length, 2)
    assert.equal(chat.facts[0].text, '用户喜欢猫')
    assert.equal(chat.counters.lastExtractAt, 1)

    const person = await memoryStore.getPerson('u1')
    assert.equal(person.name, '小明')
    assert.deepEqual(person.facts, ['用户喜欢猫', '用户是程序员'])
  } finally {
    await cleanup()
  }
})

test('达到阈值后 maybeExtract 抽取，且基线避免重复抽取', async () => {
  const { cleanup, memoryStore, extractor, llm } = await setup({ llm: makeFakeLlm({ reply: '["用户喜欢狗"]' }) })
  try {
    await seedConversation(memoryStore, 'c2c_u1', 3)
    const first = await extractor.maybeExtract({ chatId: 'c2c_u1' })
    assert.equal(first.extracted, true)
    assert.deepEqual(first.facts, ['用户喜欢狗'])
    assert.equal(llm.calls.length, 1)

    const second = await extractor.maybeExtract({ chatId: 'c2c_u1' })
    assert.equal(second.extracted, false)
    assert.equal(second.reason, 'threshold')
    assert.equal(llm.calls.length, 1)
  } finally {
    await cleanup()
  }
})

test('模型输出无法解析时不抛错，facts 保持不变', async () => {
  const { cleanup, memoryStore, extractor, logger } = await setup({ llm: makeFakeLlm({ reply: '抱歉，我不会整理记忆。' }) })
  try {
    await seedConversation(memoryStore, 'c2c_u1', 1)
    const result = await extractor.extractNow('c2c_u1')
    assert.equal(result.extracted, false)
    assert.equal(result.reason, 'empty')
    assert.equal((await memoryStore.getChat('c2c_u1')).facts.length, 0)
    assert.ok(logger.entries.length >= 0)
  } finally {
    await cleanup()
  }
})

test('LLM 报错时不抛错，返回 error reason 并记 warn', async () => {
  const { cleanup, memoryStore, extractor, logger } = await setup({ llm: makeFakeLlm({ error: new Error('network down') }) })
  try {
    await seedConversation(memoryStore, 'c2c_u1', 1)
    const result = await extractor.extractNow('c2c_u1')
    assert.equal(result.extracted, false)
    assert.equal(result.reason, 'error')
    assert.ok(logger.entries.some((entry) => entry.level === 'warn'))
  } finally {
    await cleanup()
  }
})

test('最多保留 3 条，超出丢弃', async () => {
  const reply = JSON.stringify(['事实一', '事实二', '事实三', '事实四'])
  const { cleanup, memoryStore, extractor } = await setup({ llm: makeFakeLlm({ reply }) })
  try {
    await seedConversation(memoryStore, 'c2c_u1', 1)
    const result = await extractor.extractNow('c2c_u1')
    assert.equal(result.extracted, true)
    assert.deepEqual(result.facts, ['事实一', '事实二', '事实三'])
  } finally {
    await cleanup()
  }
})

test('每条事实截断到 60 字，并与已有事实去重', async () => {
  const longFact = '长'.repeat(100)
  const reply = JSON.stringify([longFact, '用户喜欢猫'])
  const { cleanup, memoryStore, extractor } = await setup({ llm: makeFakeLlm({ reply }) })
  try {
    await seedConversation(memoryStore, 'c2c_u1', 1)
    await memoryStore.addFacts('c2c_u1', ['用户喜欢猫'])
    const result = await extractor.extractNow('c2c_u1')
    assert.equal(result.extracted, true)
    assert.equal(result.facts.length, 1)
    assert.ok(result.facts[0].length <= 60)
    const chat = await memoryStore.getChat('c2c_u1')
    assert.equal(chat.facts.length, 2)
  } finally {
    await cleanup()
  }
})

test('全部为重复事实时返回 duplicate 且不新增', async () => {
  const { cleanup, memoryStore, extractor } = await setup({ llm: makeFakeLlm({ reply: '["用户喜欢猫"]' }) })
  try {
    await seedConversation(memoryStore, 'c2c_u1', 1)
    await memoryStore.addFacts('c2c_u1', ['用户喜欢猫'])
    const result = await extractor.extractNow('c2c_u1')
    assert.equal(result.extracted, false)
    assert.equal(result.reason, 'duplicate')
    assert.deepEqual(result.facts, [])
    assert.equal((await memoryStore.getChat('c2c_u1')).facts.length, 1)
  } finally {
    await cleanup()
  }
})

test('persona.memoryEnabled=false 时跳过抽取', async () => {
  const { cleanup, memoryStore, extractor, llm } = await setup({ config: { persona: { memoryEnabled: false } } })
  try {
    await seedConversation(memoryStore, 'c2c_u1', 5)
    const result = await extractor.maybeExtract({ chatId: 'c2c_u1' })
    assert.equal(result.extracted, false)
    assert.equal(result.reason, 'disabled')
    assert.equal(llm.calls.length, 0)
  } finally {
    await cleanup()
  }
})

test('parseExtractedFacts 容错解析多种输出格式', () => {
  assert.deepEqual(parseExtractedFacts('["a","b"]'), ['a', 'b'])
  assert.deepEqual(parseExtractedFacts('好的：\n```json\n["a"]\n```'), ['a'])
  assert.deepEqual(parseExtractedFacts('{"facts":["x"]}'), ['x'])
  assert.deepEqual(parseExtractedFacts('结果是 "喜欢猫" 和 "住在杭州"。'), ['喜欢猫', '住在杭州'])
  assert.deepEqual(parseExtractedFacts(''), [])
  assert.deepEqual(parseExtractedFacts('完全没有信息'), [])
})
