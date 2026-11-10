/** Lead-owned tests for the admin API dispatcher and route registration. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { dispatchAdminMethod, registerAdminRoutes, sameOrigin } from '../host/admin/routes.js'
import { normalizeConfig } from '../host/config.js'

function makeFakeApp() {
  const config = normalizeConfig({ qq: { appId: '1', appSecret: 's' } }).config
  const calls = []
  const sticker = {
    id: 'abcdef123456',
    hash: 'abcdef123456' + '0'.repeat(52),
    ext: 'png',
    size: 3,
    layer: 'candidate',
    tags: ['无语'],
    desc: '',
    useCount: 0,
    createdAt: 1,
    updatedAt: 1
  }
  const app = {
    version: '0.2.0',
    calls,
    paths: { data: 'D:\\tmp\\qqbot-data' },
    logger: {
      recent: () => [{ ts: 1, level: 'info', msg: 'hello' }],
      warn() {},
      error() {}
    },
    configStore: {
      get: () => config,
      public: () => ({ ...config, qq: { ...config.qq, appSecret: '', appSecretMasked: '****', hasSecret: true } }),
      warnings: () => [],
      async save(patch) {
        calls.push(['config.save', patch])
        return { config, warnings: [] }
      }
    },
    qqClient: {
      status: () => ({ state: 'standby', sent: 0, received: 0 }),
      async start() { calls.push(['qq.start']) },
      async stop() {},
      async restart() {},
      async testAuth() { return { ok: true, tokenExpiresIn: 7200, gatewayUrl: 'wss://example' } }
    },
    llmClient: {
      async complete() {
        return { text: 'hi', provider: 'deepseek-official', model: 'deepseek-flash', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      }
    },
    budgetStore: {
      async snapshot() { return { today: { calls: 0 }, month: { calls: 0 }, chats: [] } },
      async reset(scope) { return { reset: scope } },
      async recent() { return [] }
    },
    personaStore: {
      async get() { return null },
      async set(chatId, patch) { return { chatId, ...patch } },
      async remove() {},
      async list() { return { chats: {}, users: {} } },
      async setUser(userId, patch) { return { userId, ...patch } },
      async removeUser() {}
    },
    memoryStore: {
      async listChats() { return [{ chatId: 'c2c_1', title: 't', kind: 'c2c' }] },
      async getChat(chatId) { return { id: chatId, history: [], facts: [] } },
      async clearChat() {},
      async listPeople() { return [] },
      async upsertPerson(openid, patch) { return { id: openid, ...patch } },
      async listChatMembers() { return [{ id: 'member-1', name: '小明', facts: [{ text: '喜欢猫' }], messageCount: 2, updatedAt: 1 }] }
    },
    stickerStore: {
      async list() { return { total: 1, items: [sticker] } },
      async get(id) { return id === sticker.id ? sticker : undefined },
      async update(id, patch) { return { ...sticker, ...patch } },
      async remove(id) { return { ...sticker, id, layer: 'trash' } },
      async purge() {},
      async restore(id) { return { ...sticker, id, layer: 'candidate' } },
      async stats() { return { total: 1, byLayer: { library: 0, candidate: 1, negative: 0, trash: 0 }, tags: 1 } },
      async catalog() { return { tags: [{ tag: '无语', count: 1 }] } },
      filePath() { return 'D:\\tmp\\x.png' }
    },
    importer: {
      async importBuffers(files, options) { calls.push(['importBuffers', files.length, options]); return { added: files, duplicates: [], skipped: [], errors: [] } },
      async scanImportDir() { return [{ path: 'a.png', name: 'a.png', size: 3 }] },
      async importDirectory(options) { calls.push(['importDirectory', options]); return { added: [sticker], duplicates: [], skipped: [], errors: [] } }
    },
    chatEngine: {
      async compressChat() { return { compressed: true } },
      async extractFacts() { return { extracted: true, facts: ['x'] } }
    }
  }
  return app
}

test('snapshot aggregates status, budget, stickers and chats', async () => {
  const app = makeFakeApp()
  const snapshot = await dispatchAdminMethod('snapshot', {}, app)
  assert.equal(snapshot.version, '0.2.0')
  assert.equal(snapshot.status.state, 'standby')
  assert.equal(snapshot.stickers.total, 1)
  assert.equal(snapshot.chats, 1)
})

test('config.save forwards the patch and returns the masked config', async () => {
  const app = makeFakeApp()
  const result = await dispatchAdminMethod('config.save', { patch: { qq: { appId: '2' } } }, app)
  assert.equal(result.config.qq.appSecret, '')
  assert.equal(result.config.qq.hasSecret, true)
  assert.equal(app.calls.at(-1)[0], 'config.save')
})

test('stickers.upload rejects empty files and decodes base64', async () => {
  const app = makeFakeApp()
  await assert.rejects(() => dispatchAdminMethod('stickers.upload', { files: [] }, app), /files/)
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')
  const result = await dispatchAdminMethod('stickers.upload', { files: [{ name: 'a.png', dataBase64: `data:image/png;base64,${png}` }], tags: ['无语'] }, app)
  assert.equal(result.added.length, 1)
  assert.deepEqual(app.calls.at(-1), ['importBuffers', 1, { tags: ['无语'], desc: '', layer: 'candidate', source: { path: 'upload' } }])
})

test('stickers.batchUpdate rejects empty ids and merges tags', async () => {
  const app = makeFakeApp()
  await assert.rejects(() => dispatchAdminMethod('stickers.batchUpdate', { ids: [] }, app), /ids/)
  const result = await dispatchAdminMethod('stickers.batchUpdate', { ids: ['abcdef123456'], addTags: ['新'] }, app)
  assert.equal(result.updated, 1)
})

test('chats.get includes per-speaker member facts for group chats', async () => {
  const app = makeFakeApp()
  const result = await dispatchAdminMethod('chats.get', { chatId: 'group_1' }, app)
  assert.equal(result.chat.id, 'group_1')
  assert.equal(result.members.length, 1)
  assert.equal(result.members[0].id, 'member-1')
  assert.equal(result.members[0].facts[0].text, '喜欢猫')
})

test('unknown admin method throws a descriptive error', async () => {
  await assert.rejects(() => dispatchAdminMethod('nope', {}, makeFakeApp()), /unknown method/)
})

test('invalid sticker layer is rejected', async () => {
  await assert.rejects(
    () => dispatchAdminMethod('stickers.update', { id: 'abcdef123456', layer: 'evil' }, makeFakeApp()),
    /非法图层/
  )
})

test('sameOrigin accepts loopback same-host requests only', () => {
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' } }), true)
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:1', origin: 'http://evil.example:1' } }), false)
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:1' } }), true)
})

test('registerAdminRoutes registers a prefix route and rejects cross-origin API calls', async () => {
  const app = makeFakeApp()
  let route
  const ctx = {
    get: (name) => (name === 'webServer' ? { register: (value) => { route = value; return () => { route = undefined } } } : undefined),
    logger: { info() {}, warn() {}, error() {} }
  }
  const dispose = registerAdminRoutes({ ctx, app })
  assert.equal(typeof dispose, 'function')
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/qqbot')

  const response = (status, headers, body) => ({ status, headers, body })

  async function invoke(req) {
    const out = { status: 0, headers: {}, body: '' }
    out.res = {
      writeHead: (status, headers = {}) => { out.status = status; out.headers = headers },
      end: (body) => { out.body = body ?? '' }
    }
    await route.handler(req, out.res)
    return out
  }

  const redirect = await invoke({ method: 'GET', url: '/qqbot', headers: { host: '127.0.0.1:1' } })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.location, '/qqbot/')

  const forbidden = await invoke({ method: 'POST', url: '/qqbot/api', headers: { host: '127.0.0.1:1', origin: 'http://evil:1' }, setEncoding() {}, on() {}, destroy() {} })
  assert.equal(forbidden.status, 403)

  dispose()
})
