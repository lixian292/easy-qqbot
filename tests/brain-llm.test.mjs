import test from 'node:test'
import assert from 'node:assert/strict'

import { createLlmClient, LlmCallError } from '../host/brain/llm.js'
import { makeConfigStore, makeFakeCtxLlm } from './helpers.mjs'

/** tests/helpers.mjs exposes a fake `ctx.llm` service, so wrap it in a ctx. */
function wrapCtx(fake) {
  return { llm: fake }
}

function makeHangingCtx() {
  const calls = []
  return {
    calls,
    llm: {
      stream(options) {
        calls.push(options)
        return (async function* hang() {
          await new Promise(() => {})
        })()
      }
    }
  }
}

function isLlmError(code) {
  return (error) => error instanceof LlmCallError && error.code === code
}

test('complete 收集 text-delta / usage / finish，并从配置读取 provider/model', async () => {
  const fake = makeFakeCtxLlm({ text: '你好世界' })
  const ctx = wrapCtx(fake)
  const configStore = makeConfigStore()
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  const client = createLlmClient({ ctx, configStore, logger })

  const result = await client.complete({
    system: '系统提示',
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在的' },
      { role: 'system', content: '额外规则' }
    ]
  })

  assert.equal(result.text, '你好世界')
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 6, totalTokens: 18 })
  assert.equal(result.provider, 'deepseek-official')
  assert.equal(result.model, 'deepseek-flash')
  assert.equal(result.finishKind, 'stop')

  assert.equal(fake.calls.length, 1)
  const options = fake.calls[0]
  assert.equal(options.provider, 'deepseek-official')
  assert.equal(options.model, 'deepseek-flash')
  assert.equal(options.system, '系统提示\n\n额外规则')
  assert.equal(options.messages.length, 2)
  assert.deepEqual(options.messages[0], { role: 'user', content: [{ type: 'text', text: '你好' }] })
  assert.deepEqual(options.messages[1].source, { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.ok(options.signal instanceof AbortSignal)
})

test('complete 尊重 temperature / maxTokens 覆盖', async () => {
  const fake = makeFakeCtxLlm({ text: 'ok' })
  const client = createLlmClient({ ctx: wrapCtx(fake), configStore: makeConfigStore() })
  await client.complete({ messages: [{ role: 'user', content: 'hi' }], temperature: 0.1, maxTokens: 64, purpose: 'memory-extract' })
  assert.equal(fake.calls[0].temperature, 0.1)
  assert.equal(fake.calls[0].maxTokens, 64)
  assert.equal(fake.calls[0].purpose, 'memory-extract')
})

test('complete 在没有 text-delta 时使用 block-end 文本', async () => {
  const fake = {
    calls: [],
    stream(options) {
      this.calls.push(options)
      return (async function* generate() {
        yield { type: 'block-end', block: { type: 'text', text: '块文本' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }
  }
  const client = createLlmClient({ ctx: wrapCtx(fake), configStore: makeConfigStore() })
  const result = await client.complete({ messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(result.text, '块文本')
})

test('错误 finish 抛出 LlmCallError 并保留 code', async () => {
  const fake = makeFakeCtxLlm({ failure: { code: 'AUTH', message: 'invalid api key' } })
  const client = createLlmClient({ ctx: wrapCtx(fake), configStore: makeConfigStore() })
  await assert.rejects(
    client.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    (error) => {
      assert.ok(error instanceof LlmCallError)
      assert.equal(error.code, 'AUTH')
      assert.ok(error.message.includes('invalid api key'))
      return true
    }
  )
})

test('空响应抛出 EMPTY_RESPONSE', async () => {
  const fake = makeFakeCtxLlm({ text: '' })
  const client = createLlmClient({ ctx: wrapCtx(fake), configStore: makeConfigStore() })
  await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'hi' }] }), isLlmError('EMPTY_RESPONSE'))
})

test('ctx.llm 缺失时抛出 LLM_UNAVAILABLE', async () => {
  const client = createLlmClient({ ctx: {}, configStore: makeConfigStore() })
  await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'hi' }] }), isLlmError('LLM_UNAVAILABLE'))
})

test('超时（流永不返回）抛出 TIMEOUT', async () => {
  const ctx = makeHangingCtx()
  const configStore = {
    get: () => ({ llm: { provider: 'p', model: 'm', timeoutMs: 30, maxTokens: 64, temperature: 0.5 } })
  }
  const client = createLlmClient({ ctx, configStore })
  await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'hi' }] }), isLlmError('TIMEOUT'))
})

test('外部 signal 取消时抛出 ABORTED', async () => {
  const ctx = makeHangingCtx()
  const client = createLlmClient({ ctx, configStore: makeConfigStore() })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20)
  try {
    await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }), isLlmError('ABORTED'))
  } finally {
    clearTimeout(timer)
  }
})

test('complete 支持按调用覆盖 model（会话级人设）', async () => {
  const fake = makeFakeCtxLlm({ text: 'ok' })
  const client = createLlmClient({ ctx: wrapCtx(fake), configStore: makeConfigStore() })
  const result = await client.complete({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' }
    ],
    model: 'deepseek-reasoner'
  })
  assert.equal(result.model, 'deepseek-reasoner')
  assert.equal(fake.calls[0].model, 'deepseek-reasoner')
  assert.deepEqual(fake.calls[0].messages[1].source, {
    kind: 'model',
    provider: 'deepseek-official',
    model: 'deepseek-reasoner'
  })
})

test('test() 便捷自检返回文本与耗时', async () => {
  const fake = makeFakeCtxLlm({ text: '连通正常' })
  const client = createLlmClient({ ctx: wrapCtx(fake), configStore: makeConfigStore() })
  const result = await client.test({ prompt: '在吗' })
  assert.equal(result.text, '连通正常')
  assert.equal(typeof result.elapsedMs, 'number')
  assert.equal(fake.calls[0].maxTokens, 64)
})
