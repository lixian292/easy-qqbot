import test from 'node:test'
import assert from 'node:assert/strict'

import { makeConfigStore, makeFakeLlm, makeLogger, makeTempPaths } from './helpers.mjs'
import { createMemoryStore } from '../host/memory/store.js'
import { createCompressor } from '../host/memory/compress.js'

async function setup({ config = {}, llm = makeFakeLlm({ reply: '合并后的摘要' }) } = {}) {
  const { paths, cleanup } = await makeTempPaths()
  const configStore = makeConfigStore({ memory: { compressTriggerTokens: 500, keepRecentMessages: 2, summaryMaxChars: 200, ...config } })
  const logger = makeLogger()
  const memoryStore = createMemoryStore({ paths, configStore, logger })
  await memoryStore.init()
  const compressor = createCompressor({ configStore, memoryStore, llmClient: llm, logger })
  return { paths, cleanup, configStore, logger, memoryStore, llm, compressor }
}

async function seed(memoryStore, chatId, count, { roleCycle = ['user', 'assistant'], length = 120 } = {}) {
  const ts = Date.now()
  for (let index = 0; index < count; index += 1) {
    await memoryStore.appendMessage(chatId, {
      role: roleCycle[index % roleCycle.length],
      content: `${index}:${'聊'.repeat(length)}`,
      ts: ts + index
    })
  }
}

test('低于阈值时 maybeCompress 不压缩、不调用 LLM', async () => {
  const { cleanup, memoryStore, compressor, llm } = await setup()
  try {
    await seed(memoryStore, 'c2c_u1', 4, { length: 10 })
    const result = await compressor.maybeCompress('c2c_u1')
    assert.equal(result.compressed, false)
    assert.equal(result.removed, 0)
    assert.equal(llm.calls.length, 0)
    assert.equal((await memoryStore.history('c2c_u1', 100)).length, 4)
  } finally {
    await cleanup()
  }
})

test('消息数不超过 keepRecentMessages 时 compressNow 直接返回', async () => {
  const { cleanup, memoryStore, compressor, llm } = await setup()
  try {
    await seed(memoryStore, 'c2c_u1', 2)
    const result = await compressor.compressNow('c2c_u1')
    assert.deepEqual(result, { compressed: false, removed: 0 })
    assert.equal(llm.calls.length, 0)
  } finally {
    await cleanup()
  }
})

test('超过阈值时压缩：保留最近消息并写入摘要', async () => {
  const { cleanup, memoryStore, compressor, llm } = await setup()
  try {
    await seed(memoryStore, 'c2c_u1', 8)
    const result = await compressor.maybeCompress('c2c_u1')
    assert.equal(result.compressed, true)
    assert.equal(result.removed, 6)
    assert.equal(result.summary, '合并后的摘要')
    assert.equal(llm.calls.length, 1)
    assert.equal(llm.calls[0].purpose, 'memory-compress')

    const history = await memoryStore.history('c2c_u1', 100)
    assert.equal(history.length, 2)
    assert.equal(history[1].content, '7:' + '聊'.repeat(120))

    const chat = await memoryStore.getChat('c2c_u1')
    assert.equal(chat.summary.text, '合并后的摘要')
    assert.equal(chat.summary.coveredCount, 6)
  } finally {
    await cleanup()
  }
})

test('LLM 失败时返回错误且历史保持原样', async () => {
  const { cleanup, memoryStore, compressor } = await setup({ llm: makeFakeLlm({ error: new Error('boom') }) })
  try {
    await seed(memoryStore, 'c2c_u1', 8)
    const result = await compressor.maybeCompress('c2c_u1')
    assert.equal(result.compressed, false)
    assert.equal(result.removed, 0)
    assert.ok(typeof result.error === 'string' && result.error.includes('boom'))
    assert.equal((await memoryStore.history('c2c_u1', 100)).length, 8)
    assert.equal((await memoryStore.getChat('c2c_u1')).summary, null)
  } finally {
    await cleanup()
  }
})

test('摘要长度被截断到 summaryMaxChars', async () => {
  const { cleanup, memoryStore, compressor } = await setup({ llm: makeFakeLlm({ reply: 'x'.repeat(500) }) })
  try {
    await seed(memoryStore, 'c2c_u1', 8)
    const result = await compressor.compressNow('c2c_u1')
    assert.equal(result.compressed, true)
    assert.ok(result.summary.length <= 200)
    assert.ok(result.summary.endsWith('…'))
    const chat = await memoryStore.getChat('c2c_u1')
    assert.ok(chat.summary.text.length <= 200)
  } finally {
    await cleanup()
  }
})

test('compressNow 不受阈值限制，仅有更早消息即压缩', async () => {
  const { cleanup, memoryStore, compressor, llm } = await setup()
  try {
    await seed(memoryStore, 'c2c_u1', 3, { length: 10 })
    const result = await compressor.compressNow('c2c_u1')
    assert.equal(result.compressed, true)
    assert.equal(result.removed, 1)
    assert.equal(llm.calls.length, 1)
    assert.equal((await memoryStore.history('c2c_u1', 100)).length, 2)
  } finally {
    await cleanup()
  }
})

test('空会话与缺少 chatId 时安全返回', async () => {
  const { cleanup, compressor } = await setup()
  try {
    assert.deepEqual(await compressor.compressNow('c2c_empty'), { compressed: false, removed: 0 })
    assert.deepEqual(await compressor.maybeCompress(''), { compressed: false, removed: 0 })
    assert.deepEqual(await compressor.maybeCompress(undefined), { compressed: false, removed: 0 })
  } finally {
    await cleanup()
  }
})
