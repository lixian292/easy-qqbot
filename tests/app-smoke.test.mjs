/**
 * Lead-owned integration smoke test: builds the real app with fake DSH services
 * (ctx.llm, webServer, logger) and exercises the admin dispatcher end to end.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createApp } from '../host/app.js'
import { dispatchAdminMethod } from '../host/admin/routes.js'

function makeFakeCtxLlm(text = '你好呀') {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* generate() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }
  }
}

function makeFakeCtx() {
  const registeredRoutes = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get(name) {
      if (name === 'llm') return makeFakeCtxLlm()
      if (name === 'webServer') {
        return {
          register(route) {
            registeredRoutes.push(route)
            return () => {}
          }
        }
      }
      return undefined
    }
  }
  return { ctx, registeredRoutes }
}

async function withTempEnv(root, fn) {
  const previousData = process.env.QQBOT_DATA_DIR
  const previousImport = process.env.QQBOT_IMPORT_DIR
  process.env.QQBOT_DATA_DIR = path.join(root, 'data')
  process.env.QQBOT_IMPORT_DIR = path.join(root, 'import')
  try {
    return await fn()
  } finally {
    if (previousData === undefined) delete process.env.QQBOT_DATA_DIR
    else process.env.QQBOT_DATA_DIR = previousData
    if (previousImport === undefined) delete process.env.QQBOT_IMPORT_DIR
    else process.env.QQBOT_IMPORT_DIR = previousImport
  }
}

test('createApp boots with fake services, serves admin API and disposes cleanly', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-app-'))
  try {
    await withTempEnv(root, async () => {
      const { ctx, registeredRoutes } = makeFakeCtx()
      const app = await createApp({ ctx })
      try {
        assert.equal(registeredRoutes.length, 1)
        assert.equal(registeredRoutes[0].path, '/qqbot')
        assert.equal(registeredRoutes[0].kind, 'prefix')

        const snapshot = await dispatchAdminMethod('snapshot', {}, app)
        assert.equal(snapshot.version, '0.1.0')
        assert.equal(snapshot.status.state ?? 'standby', 'standby')
        assert.equal(snapshot.chats, 0)

        const llmTest = await dispatchAdminMethod('llm.test', { prompt: '在吗' }, app)
        assert.equal(llmTest.text, '你好呀')
        assert.equal(llmTest.usage.totalTokens, 10)

        const saved = await dispatchAdminMethod('config.save', { patch: { persona: { name: '测试机器人' } } }, app)
        assert.equal(saved.config.persona.name, '测试机器人')

        const stats = await dispatchAdminMethod('stickers.stats', {}, app)
        assert.equal(stats.total, 0)

        const chats = await dispatchAdminMethod('chats.list', {}, app)
        assert.deepEqual(chats.chats, [])
      } finally {
        await app.dispose()
      }
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('createApp writes a default config on first run and tolerates a corrupt one', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-app-'))
  try {
    await withTempEnv(root, async () => {
      const { ctx } = makeFakeCtx()
      const first = await createApp({ ctx })
      await first.dispose()
      const configFile = path.join(root, 'data', 'config.json')
      const config = JSON.parse(await fs.readFile(configFile, 'utf8'))
      assert.equal(config.qq.appId, '')

      await fs.writeFile(configFile, '{broken json')
      const second = await createApp({ ctx })
      try {
        const snapshot = await dispatchAdminMethod('snapshot', {}, second)
        assert.ok(Array.isArray(snapshot.configWarnings))
      } finally {
        await second.dispose()
      }
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

/** Invoke a captured webServer route handler with a minimal fake req/res. */
async function invokeRoute(route, { method = 'GET', url = '/', headers = {}, body = undefined } = {}) {
  const req = new PassThrough()
  req.method = method
  req.url = url
  req.headers = headers
  const captured = { status: 0, headers: {}, body: Buffer.alloc(0) }
  const res = {
    writeHead(status, responseHeaders = {}) {
      captured.status = status
      captured.headers = responseHeaders
    },
    end(chunk) {
      if (chunk !== undefined) captured.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    }
  }
  if (body !== undefined) {
    req.end(JSON.stringify(body))
    await route.handler(req, res)
  } else {
    req.end()
    await route.handler(req, res)
  }
  return captured
}

test('admin HTTP surface serves the page, accepts sticker upload and persists config', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-app-'))
  try {
    await withTempEnv(root, async () => {
      const { ctx, registeredRoutes } = makeFakeCtx()
      const app = await createApp({ ctx })
      const route = registeredRoutes[0]
      const pageOrigin = 'http://127.0.0.1:63520'
      try {
        const page = await invokeRoute(route, { url: '/qqbot/', headers: { host: '127.0.0.1:63520' } })
        assert.equal(page.status, 200)
        assert.ok(String(page.headers['content-type']).includes('text/html'))
        const html = page.body.toString('utf8')
        assert.ok(html.includes('app.js'))
        assert.ok(html.toLowerCase().includes('qqbot'))
        assert.ok(html.includes('exitBtn'), 'console page must expose an exit button')
        assert.ok(html.includes('退出工作台'))

        const emptyPayload = await invokeRoute(route, {
          method: 'POST',
          url: '/qqbot/api',
          headers: { host: '127.0.0.1:63520', origin: pageOrigin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
          body: { method: 'snapshot', args: {} }
        })
        assert.equal(emptyPayload.status, 200)
        const snapshot = JSON.parse(emptyPayload.body.toString('utf8'))
        assert.equal(snapshot.ok, true)
        assert.equal(snapshot.result.stickers.total, 0)

        const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')
        const upload = await invokeRoute(route, {
          method: 'POST',
          url: '/qqbot/api',
          headers: { host: '127.0.0.1:63520', origin: pageOrigin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
          body: {
            method: 'stickers.upload',
            args: { files: [{ name: 'test.png', dataBase64: png.toString('base64') }], tags: ['无语', '敷衍'] }
          }
        })
        const uploaded = JSON.parse(upload.body.toString('utf8'))
        assert.equal(uploaded.ok, true, uploaded.error)
        assert.equal(uploaded.result.added.length, 1)
        const stickerId = uploaded.result.added[0].id

        const listed = JSON.parse(
          (
            await invokeRoute(route, {
              method: 'POST',
              url: '/qqbot/api',
              headers: { host: '127.0.0.1:63520', origin: pageOrigin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
              body: { method: 'stickers.list', args: { layer: 'candidate' } }
            })
          ).body.toString('utf8')
        )
        assert.equal(listed.ok, true)
        assert.equal(listed.result.total, 1)
        assert.deepEqual(listed.result.items[0].tags, ['无语', '敷衍'])

        const media = await invokeRoute(route, { url: `/qqbot/media/sticker/${stickerId}`, headers: { host: '127.0.0.1:63520' } })
        assert.equal(media.status, 200)
        assert.equal(media.body.equals(png), true)

        const updated = JSON.parse(
          (
            await invokeRoute(route, {
              method: 'POST',
              url: '/qqbot/api',
              headers: { host: '127.0.0.1:63520', origin: pageOrigin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
              body: { method: 'stickers.update', args: { id: stickerId, layer: 'library', tags: ['无语'] } }
            })
          ).body.toString('utf8')
        )
        assert.equal(updated.ok, true)
        assert.equal(updated.result.item.layer, 'library')

        // config.save must actually persist the edited value (regression for the
        // patchConfig return-shape bug fixed in host/app.js).
        const saved = JSON.parse(
          (
            await invokeRoute(route, {
              method: 'POST',
              url: '/qqbot/api',
              headers: { host: '127.0.0.1:63520', origin: pageOrigin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
              body: { method: 'config.save', args: { patch: { persona: { name: '路由测试' } } } }
            })
          ).body.toString('utf8')
        )
        assert.equal(saved.ok, true, saved.error)
        const persisted = JSON.parse(await fs.readFile(path.join(root, 'data', 'config.json'), 'utf8'))
        assert.equal(persisted.persona.name, '路由测试')
      } finally {
        await app.dispose()
      }
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
