/** Lead-owned tests for the admin API dispatcher and route registration. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
  const reference = {
    id: 'ref123456',
    ext: 'png',
    mime: 'image/png',
    size: 3,
    originalName: 'blue-whale-girl.png',
    createdAt: 1
  }
  const app = {
    version: '0.3.0',
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
    },
    outputStore: {
      stats() { return { total: 1, byKind: { image: 1, audio: 0, video: 0 }, bytes: 3, latestAt: 1 } },
      async list({ kind, limit, offset }) {
        const items = [{ id: 'out123456', kind: 'image', ext: 'png', mime: 'image/png', size: 3, prompt: '猫', createdAt: 1, model: 'm', provider: 'p' }]
        return { total: items.length, items: items.slice(offset, offset + limit) }
      },
      async get(id) { return id === 'out123456' ? { id, kind: 'image', ext: 'png', mime: 'image/png', size: 3, createdAt: 1 } : undefined },
      filePath(record) { return `D:\\tmp\\${record.id}.${record.ext}` },
      async remove(id) { return { id, kind: 'image', ext: 'png', mime: 'image/png' } },
      async clear() { return { removed: 1 } }
    },
    referenceStore: {
      async list() { return { items: [reference] } },
      async get(id) { return id === reference.id ? reference : undefined },
      filePath(record) { return `D:\\tmp\\references\\${record.id}.${record.ext}` },
      async add({ buffer, mime, originalName }) {
        calls.push(['reference.add', buffer.length, mime, originalName])
        return { ...reference, size: buffer.length, originalName }
      },
      async remove(id) { calls.push(['reference.remove', id]); return { ...reference, id } }
    },
    outputClient: {
      status() {
        return {
          enabled: true,
          commandAccess: 'admin',
          sendToQQ: true,
          image: { enabled: true, configured: true, model: 'img', baseUrl: 'https://api.example.com/v1' },
          audio: { enabled: false, configured: false, model: '' },
          video: { enabled: false, configured: false, model: '' }
        }
      },
      async test({ kind }) { calls.push(['output.test', kind]); return { ok: true, kind, mode: 'models', modelFound: true } },
      async generate({ kind, prompt, source }) {
        calls.push(['output.generate', kind, prompt, source])
        const record = { id: 'out123456', kind, ext: 'png', mime: 'image/png', size: 3, prompt, createdAt: 1, filePath: 'D:\\tmp\\out123456.png' }
        return { kind, record, records: [record] }
      }
    }
  }
  return app
}

test('snapshot aggregates status, budget, stickers and chats', async () => {
  const app = makeFakeApp()
  const snapshot = await dispatchAdminMethod('snapshot', {}, app)
  assert.equal(snapshot.version, '0.3.0')
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

test('snapshot includes multimodal output status and library stats', async () => {
  const app = makeFakeApp()
  const snapshot = await dispatchAdminMethod('snapshot', {}, app)
  assert.equal(snapshot.output.enabled, true)
  assert.equal(snapshot.output.image.configured, true)
  assert.equal(snapshot.outputs.total, 1)
  assert.equal(snapshot.references.items.length, 1)
  assert.equal(snapshot.references.items[0].originalName, 'blue-whale-girl.png')
})

test('output.status / test / generate / history / delete / clear work through the dispatcher', async () => {
  const app = makeFakeApp()
  const status = await dispatchAdminMethod('output.status', {}, app)
  assert.equal(status.status.image.model, 'img')
  assert.equal(status.store.total, 1)

  const tested = await dispatchAdminMethod('output.test', { kind: 'image' }, app)
  assert.equal(tested.modelFound, true)

  const generated = await dispatchAdminMethod('output.generate', { kind: 'image', prompt: '一只猫' }, app)
  assert.equal(generated.records.length, 1)
  assert.equal('filePath' in generated.records[0], false, 'admin API must never expose local file paths')
  assert.equal(generated.record.id, 'out123456')
  assert.deepEqual(app.calls.at(-1), ['output.generate', 'image', '一只猫', { kind: 'admin', chatId: '' }])

  const history = await dispatchAdminMethod('output.history', { limit: 10, offset: 0 }, app)
  assert.equal(history.total, 1)
  assert.equal('filePath' in history.items[0], false)

  const removed = await dispatchAdminMethod('output.delete', { id: 'out123456' }, app)
  assert.equal(removed.ok, true)

  const cleared = await dispatchAdminMethod('output.clear', {}, app)
  assert.equal(cleared.ok, true)
  assert.equal(cleared.removed, 1)
})

test('reference list / upload / activate / delete are exposed through the admin API', async () => {
  const app = makeFakeApp()
  const listed = await dispatchAdminMethod('output.reference.list', {}, app)
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0].originalName, 'blue-whale-girl.png')
  assert.equal('filePath' in listed.items[0], false)

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')
  const uploaded = await dispatchAdminMethod('output.reference.upload', { name: 'ref.png', dataBase64: png }, app)
  assert.equal(uploaded.item.id, 'ref123456')
  assert.deepEqual(app.calls.at(-1), ['reference.add', 16, '', 'ref.png'])

  const activated = await dispatchAdminMethod('output.reference.activate', { id: 'ref123456', enabled: true }, app)
  assert.equal(activated.item.id, 'ref123456')
  assert.equal(app.calls.some((call) => call[0] === 'config.save'), true)

  const deleted = await dispatchAdminMethod('output.reference.delete', { id: 'ref123456' }, app)
  assert.equal(deleted.ok, true)
  assert.equal(app.calls.some((call) => call[0] === 'reference.remove'), true)
})

test('reference upload rejects empty or malformed base64', async () => {
  const app = makeFakeApp()
  await assert.rejects(() => dispatchAdminMethod('output.reference.upload', { name: 'x', dataBase64: '' }, app), /文件内容为空/)
})

test('output methods validate kind and prompt', async () => {
  const app = makeFakeApp()
  await assert.rejects(() => dispatchAdminMethod('output.test', { kind: 'nope' }, app), /kind/)
  await assert.rejects(() => dispatchAdminMethod('output.generate', { kind: 'image', prompt: '' }, app), /prompt/)
  await assert.rejects(() => dispatchAdminMethod('output.generate', { kind: 'image', prompt: 'x'.repeat(2001) }, app), /2000/)
  await assert.rejects(() => dispatchAdminMethod('output.generate', { kind: 'gif', prompt: 'x' }, app), /kind/)
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

test('serves character reference images from the local store', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-reference-media-'))
  try {
    const file = path.join(dir, 'ref.png')
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    await fs.writeFile(file, png)
    const app = makeFakeApp()
    app.referenceStore.get = async (id) => (id === 'ref123456' ? { id, ext: 'png', mime: 'image/png', size: png.length } : undefined)
    app.referenceStore.filePath = () => file
    let route
    const ctx = {
      get: (name) => (name === 'webServer' ? { register: (value) => { route = value; return () => {} } } : undefined),
      logger: { info() {}, warn() {}, error() {} }
    }
    registerAdminRoutes({ ctx, app })
    const out = { status: 0, headers: {}, body: Buffer.alloc(0) }
    const res = {
      writeHead: (status, headers = {}) => { out.status = status; out.headers = headers },
      end: (body) => { out.body = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body)) }
    }
    await route.handler({ method: 'GET', url: '/qqbot/media/reference/ref123456', headers: { host: '127.0.0.1:1' } }, res)
    assert.equal(out.status, 200)
    assert.equal(out.headers['content-type'], 'image/png')
    assert.deepEqual(out.body, png)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('serves generated output media with content-type and byte ranges', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-output-media-'))
  try {
    const file = path.join(dir, 'out.png')
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    await fs.writeFile(file, png)
    const app = makeFakeApp()
    app.outputStore.get = async (id) => (id === 'out123456' ? { id, ext: 'png', mime: 'image/png', size: png.length } : undefined)
    app.outputStore.filePath = () => file
    let route
    const ctx = {
      get: (name) => (name === 'webServer' ? { register: (value) => { route = value; return () => {} } } : undefined),
      logger: { info() {}, warn() {}, error() {} }
    }
    registerAdminRoutes({ ctx, app })

    async function invoke(req) {
      const out = { status: 0, headers: {}, body: Buffer.alloc(0) }
      out.res = {
        writeHead: (status, headers = {}) => { out.status = status; out.headers = headers },
        end: (body) => { out.body = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body)) }
      }
      await route.handler(req, out.res)
      return out
    }

    const full = await invoke({ method: 'GET', url: '/qqbot/media/output/out123456', headers: { host: '127.0.0.1:1' } })
    assert.equal(full.status, 200)
    assert.equal(full.headers['content-type'], 'image/png')
    assert.equal(full.headers['accept-ranges'], 'bytes')
    assert.deepEqual(full.body, png)

    const head = await invoke({ method: 'HEAD', url: '/qqbot/media/output/out123456', headers: { host: '127.0.0.1:1' } })
    assert.equal(head.status, 200)
    assert.equal(head.body.length, 0)

    const ranged = await invoke({ method: 'GET', url: '/qqbot/media/output/out123456', headers: { host: '127.0.0.1:1', range: 'bytes=0-7' } })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers['content-range'], `bytes 0-7/${png.length}`)
    assert.deepEqual(ranged.body, png.subarray(0, 8))

    const missing = await invoke({ method: 'GET', url: '/qqbot/media/output/nope123', headers: { host: '127.0.0.1:1' } })
    assert.equal(missing.status, 404)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
