import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { makeConfigStore, makeFakeLlm, makeLogger, makeTempPaths } from './helpers.mjs'
import { createMemoryStore } from '../host/memory/store.js'
import { createMemoryExtractor, parseExtractedFacts, parseExtractedMemory } from '../host/memory/extract.js'

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

function groupSpeaker(userId = 'u1', name = '小明') {
  return { userId, name, isGroup: true }
}

test('群聊：对象输出分别写 chatFacts / memberFacts，并 upsertPerson', async () => {
  const reply = JSON.stringify({ chatFacts: ['群规：周末晚上开黑'], memberFacts: ['小明喜欢猫'] })
  const { cleanup, memoryStore, extractor } = await setup({ llm: makeFakeLlm({ reply }) })
  try {
    await seedConversation(memoryStore, 'group_g1', 1)
    const result = await extractor.maybeExtract({ chatId: 'group_g1', force: true, speaker: groupSpeaker() })
    assert.equal(result.extracted, true)
    assert.deepEqual(result.facts, ['群规：周末晚上开黑'])
    assert.deepEqual(result.memberFacts, ['小明喜欢猫'])

    const chat = await memoryStore.getChat('group_g1')
    assert.deepEqual(chat.facts.map((fact) => fact.text), ['群规：周末晚上开黑'])

    const member = await memoryStore.getChatMember('group_g1', 'u1')
    assert.equal(member.name, '小明')
    assert.deepEqual(member.facts.map((fact) => fact.text), ['小明喜欢猫'])

    const person = await memoryStore.getPerson('u1')
    assert.equal(person.name, '小明')
    assert.deepEqual(person.facts, ['小明喜欢猫'])
  } finally {
    await cleanup()
  }
})

test('群聊：不同发言者的成员事实文件互相独立', async () => {
  let call = 0
  const replies = [
    JSON.stringify({ chatFacts: [], memberFacts: ['小明喜欢猫'] }),
    JSON.stringify({ chatFacts: [], memberFacts: ['小红喜欢狗'] })
  ]
  const { cleanup, memoryStore, extractor } = await setup({
    llm: makeFakeLlm({
      reply: () => replies[Math.min(call++, replies.length - 1)]
    })
  })
  try {
    await seedConversation(memoryStore, 'group_g1', 1, { userId: 'u1', userName: '小明' })
    await extractor.maybeExtract({ chatId: 'group_g1', force: true, speaker: groupSpeaker('u1', '小明') })

    await seedConversation(memoryStore, 'group_g1', 1, { userId: 'u2', userName: '小红' })
    await extractor.maybeExtract({ chatId: 'group_g1', force: true, speaker: groupSpeaker('u2', '小红') })

    const members = await memoryStore.listChatMembers('group_g1')
    assert.equal(members.length, 2)
    const byId = Object.fromEntries(members.map((member) => [member.id, member.facts.map((fact) => fact.text)]))
    assert.deepEqual(byId.u1, ['小明喜欢猫'])
    assert.deepEqual(byId.u2, ['小红喜欢狗'])
    // Nothing about either member leaked into the shared chat facts.
    assert.deepEqual((await memoryStore.getChat('group_g1')).facts, [])
  } finally {
    await cleanup()
  }
})

test('单聊：memberFacts 归入 chatFacts，不写成员文件', async () => {
  const reply = JSON.stringify({ chatFacts: [], memberFacts: ['用户喜欢猫'] })
  const { paths, cleanup, memoryStore, extractor } = await setup({ llm: makeFakeLlm({ reply }) })
  try {
    await seedConversation(memoryStore, 'c2c_u1', 1)
    const result = await extractor.maybeExtract({
      chatId: 'c2c_u1',
      force: true,
      speaker: { userId: 'u1', name: '小明', isGroup: false }
    })
    assert.equal(result.extracted, true)
    assert.deepEqual(result.facts, ['用户喜欢猫'])
    assert.deepEqual(result.memberFacts, [])
    assert.deepEqual((await memoryStore.getChat('c2c_u1')).facts.map((fact) => fact.text), ['用户喜欢猫'])
    assert.deepEqual(await memoryStore.listChatMembers('c2c_u1'), [])
    await assert.rejects(fs.access(path.join(paths.chatDir('c2c_u1'), 'members')))
  } finally {
    await cleanup()
  }
})

test('群聊：重复的成员事实返回 duplicate 且不新增', async () => {
  const reply = JSON.stringify({ chatFacts: [], memberFacts: ['小明喜欢猫'] })
  const { cleanup, memoryStore, extractor } = await setup({ llm: makeFakeLlm({ reply }) })
  try {
    await seedConversation(memoryStore, 'group_g1', 1)
    await memoryStore.addChatMemberFacts('group_g1', 'u1', ['小明喜欢猫'], { name: '小明' })
    const result = await extractor.maybeExtract({ chatId: 'group_g1', force: true, speaker: groupSpeaker() })
    assert.equal(result.extracted, false)
    assert.equal(result.reason, 'duplicate')
    assert.deepEqual(result.memberFacts, [])
    assert.equal((await memoryStore.getChatMember('group_g1', 'u1')).facts.length, 1)
  } finally {
    await cleanup()
  }
})

test('群聊：speaker 缺少 userId 时 memberFacts 归入 chatFacts', async () => {
  const reply = JSON.stringify({ chatFacts: ['群友喜欢猫'], memberFacts: ['某人喜欢狗'] })
  const { cleanup, memoryStore, extractor } = await setup({ llm: makeFakeLlm({ reply }) })
  try {
    await seedConversation(memoryStore, 'group_g1', 1)
    const result = await extractor.maybeExtract({
      chatId: 'group_g1',
      force: true,
      speaker: { name: '匿名', isGroup: true }
    })
    assert.equal(result.extracted, true)
    assert.deepEqual(result.facts, ['群友喜欢猫', '某人喜欢狗'])
    assert.deepEqual(result.memberFacts, [])
    assert.deepEqual(await memoryStore.listChatMembers('group_g1'), [])
  } finally {
    await cleanup()
  }
})

test('群聊抽取时给模型的 prompt 包含当前发言者与已有成员记忆', async () => {
  const reply = JSON.stringify({ chatFacts: [], memberFacts: ['小明喜欢猫'] })
  const { cleanup, memoryStore, extractor, llm } = await setup({ llm: makeFakeLlm({ reply }) })
  try {
    await seedConversation(memoryStore, 'group_g1', 1)
    await memoryStore.addChatMemberFacts('group_g1', 'u1', ['小明住在杭州'], { name: '小明' })
    await extractor.maybeExtract({ chatId: 'group_g1', force: true, speaker: groupSpeaker() })
    const prompt = llm.calls[0].messages[0].content
    assert.ok(prompt.includes('当前发言者'))
    assert.ok(prompt.includes('小明住在杭州'))
    assert.ok(prompt.includes('chatFacts'))
    assert.ok(prompt.includes('memberFacts'))
  } finally {
    await cleanup()
  }
})

test('parseExtractedMemory 支持对象 / 旧数组 / 兼容键名', () => {
  assert.deepEqual(parseExtractedMemory('{"chatFacts":["a"],"memberFacts":["b"]}'), {
    chatFacts: ['a'],
    memberFacts: ['b']
  })
  assert.deepEqual(parseExtractedMemory('好的：\n```json\n{"facts":["x"],"memberFacts":["y"]}\n```'), {
    chatFacts: ['x'],
    memberFacts: ['y']
  })
  assert.deepEqual(parseExtractedMemory('["a","b"]'), { chatFacts: ['a', 'b'], memberFacts: [] })
  assert.deepEqual(parseExtractedMemory('{"chat_facts":["x"],"member_facts":["y"]}'), {
    chatFacts: ['x'],
    memberFacts: ['y']
  })
  assert.deepEqual(parseExtractedMemory(''), { chatFacts: [], memberFacts: [] })
})
