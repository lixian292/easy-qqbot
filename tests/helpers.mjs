/** Shared helpers for qqbot tests. Lead-owned; teammates may import but not edit. */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPaths } from '../host/paths.js'
import { DEFAULT_CONFIG, normalizeConfig } from '../host/config.js'

export async function makeTempPaths() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-test-'))
  const paths = createPaths({ packageRoot: root })
  paths.ensure()
  return {
    root,
    paths,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value !== null && typeof value === 'object' && !Array.isArray(value) ? deepMerge(out[key] ?? {}, value) : value
  }
  return out
}

/** In-memory configStore matching the contract in docs/INTERFACES.md. */
export function makeConfigStore(overrides = {}) {
  let current = normalizeConfig(deepMerge(DEFAULT_CONFIG, overrides)).config
  const listeners = new Set()
  return {
    get: () => current,
    public: () => ({ ...current, qq: { ...current.qq, appSecret: '', appSecretMasked: current.qq.appSecret === '' ? '' : '****' } }),
    async save(patch) {
      const next = normalizeConfig(deepMerge(current, patch))
      current = next.config
      for (const listener of listeners) {
        try {
          listener(current)
        } catch {
          // ignore listener failures in the mock
        }
      }
      return next
    },
    setConfig(patch) {
      const next = normalizeConfig(deepMerge(current, patch))
      current = next.config
      return next
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

/** Minimal logger matching the injected contract. */
export function makeLogger() {
  const entries = []
  const push = (level) => (msg, detail) => entries.push({ ts: Date.now(), level, msg: String(msg), detail })
  return {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    recent: (limit = 200) => entries.slice(-limit),
    entries,
    async flush() {}
  }
}

/** Fake high-level LLM client (host/brain/llm.js surface). */
export function makeFakeLlm({ reply = '好的', usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, error = null } = {}) {
  const calls = []
  return {
    calls,
    async complete(args) {
      calls.push(args)
      if (error !== null) throw error
      return {
        text: typeof reply === 'function' ? reply(args) : reply,
        usage: { ...usage },
        provider: args?.provider ?? 'deepseek-official',
        model: args?.model ?? 'deepseek-flash',
        finishKind: 'stop'
      }
    },
    async test(args = {}) {
      return this.complete({ system: 'test', messages: [{ role: 'user', content: args.prompt ?? 'hi' }] })
    }
  }
}

/** Fake `ctx.llm` service that yields llm stream chunks (for host/brain/llm.js tests). */
export function makeFakeCtxLlm({ text = '你好', usage = { inputTokens: 12, outputTokens: 6 }, finishKind = 'stop', failure = null } = {}) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* generate() {
        if (failure !== null) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: failure.code ?? 'AUTH', message: failure.message ?? 'boom' } } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        const parts = Array.isArray(text) ? text : [text]
        for (const part of parts) {
          if (part !== '') yield { type: 'text-delta', index: 0, text: part }
        }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: parts.join('') } }
        yield {
          type: 'usage',
          usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.inputTokens + usage.outputTokens }
        }
        yield { type: 'finish', reason: { kind: finishKind } }
      })()
    }
  }
}

export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('waitFor: condition not met before timeout')
}
