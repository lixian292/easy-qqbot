/** Tests for host/qq/gateway.js and the qq/index.js glue — fake sockets only. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildHeartbeatPayload,
  buildIdentifyPayload,
  buildResumePayload,
  createGateway,
  isResumableCloseCode,
  nextBackoffMs
} from '../host/qq/gateway.js'
import { createQQClient } from '../host/qq/index.js'
import { makeConfigStore, makeLogger, waitFor } from './helpers.mjs'

class FakeWebSocket {
  static instances = []

  static reset() {
    FakeWebSocket.instances = []
  }

  constructor(url) {
    this.url = String(url)
    this.readyState = 0
    this.sent = []
    this.closed = false
    this.closeCode = null
    this.listeners = new Map()
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }

  send(data) {
    if (this.closed) throw new Error('socket 已关闭')
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data)
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.closeCode = code
    this.closeReason = reason
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  open() {
    this.readyState = 1
    this.emit('open', {})
  }

  message(payload) {
    this.emit('message', { data: typeof payload === 'string' ? payload : JSON.stringify(payload) })
  }

  serverClose(code = 1006, reason = '') {
    this.closed = true
    this.readyState = 3
    this.closeCode = code
    this.emit('close', { code, reason })
  }

  serverError(message = 'boom') {
    this.emit('error', { message })
  }
}

function makeApiStub(overrides = {}) {
  return {
    async getToken() {
      return { accessToken: 'tok-123', expiresIn: 7200, fetchedAt: Date.now() }
    },
    async getGatewayUrl() {
      return 'wss://gateway.test/ws'
    },
    invalidateToken() {},
    ...overrides
  }
}

function gatewayConfigStore(extra = {}) {
  return makeConfigStore({
    qq: {
      appId: '1000001',
      appSecret: 'secret-value',
      reconnect: { baseDelayMs: 200, maxDelayMs: 400, maxAttempts: 0 },
      ...extra
    }
  })
}

function bootGateway(t, { api = makeApiStub(), configStore = gatewayConfigStore(), logger = makeLogger() } = {}) {
  FakeWebSocket.reset()
  const dispatches = []
  const statuses = []
  const gateway = createGateway({
    api,
    configStore,
    logger,
    onDispatch: (dispatch) => dispatches.push(dispatch),
    onStatusChange: (status) => statuses.push(status),
    WebSocketImpl: FakeWebSocket
  })
  t.after(async () => {
    await gateway.stop({ clearSession: true })
  })
  return { gateway, dispatches, statuses, logger, configStore, api }
}

async function goOnline(gateway, socket, { sessionId = 'sess-1', user = { id: 'bot-1', username: '小Q' }, seq = 1, heartbeatInterval = 5000 } = {}) {
  socket.open()
  socket.message({ op: 10, d: { heartbeat_interval: heartbeatInterval } })
  await waitFor(() => socket.sent.some((payload) => payload.op === 2 || payload.op === 6))
  socket.message({ op: 0, t: 'READY', s: seq, id: 'evt-ready', d: { session_id: sessionId, user } })
  await waitFor(() => gateway.status().state === 'online')
}

test('Hello → Identify → READY：状态、dispatch 与停止', async (t) => {
  const { gateway, dispatches, statuses } = bootGateway(t)
  const started = await gateway.start()
  assert.equal(started.state, 'connecting')

  const socket = FakeWebSocket.instances[0]
  assert.equal(FakeWebSocket.instances.length, 1)
  assert.equal(socket.url, 'wss://gateway.test/ws')

  socket.open()
  socket.message({ op: 10, d: { heartbeat_interval: 5000 } })
  await waitFor(() => socket.sent.length >= 1)
  const identify = socket.sent[0]
  assert.equal(identify.op, 2)
  assert.equal(identify.d.token, 'QQBot tok-123')
  assert.equal(identify.d.intents, 33554432)
  assert.deepEqual(identify.d.shard, [0, 1])
  assert.equal(identify.d.properties.$os, process.platform)

  socket.message({ op: 0, t: 'READY', s: 1, id: 'evt-ready', d: { session_id: 'sess-1', user: { id: 'bot-1', username: '小Q' } } })
  await waitFor(() => gateway.status().state === 'online')
  const status = gateway.status()
  assert.equal(status.sessionId, 'sess-1')
  assert.equal(status.seq, 1)
  assert.deepEqual(status.bot, { id: 'bot-1', username: '小Q' })
  assert.equal(status.attempts, 0)
  assert.ok(dispatches.some((dispatch) => dispatch.t === 'READY'))
  assert.ok(statuses.some((entry) => entry.state === 'online'))
  assert.equal(typeof gateway.status().lastEventAt, 'number')

  const stopped = await gateway.stop()
  assert.equal(stopped.state, 'idle')
  assert.equal(socket.closed, true, 'stop 应关闭 socket')
})

test('心跳：按 Hello interval 发送 op1（带 lastSeq），响应服务端 op1，记录 op11', async (t) => {
  const { gateway } = bootGateway(t)
  await gateway.start()
  const socket = FakeWebSocket.instances[0]
  socket.open()
  socket.message({ op: 10, d: { heartbeat_interval: 50 } })
  await waitFor(() => socket.sent.some((payload) => payload.op === 2))
  socket.message({ op: 0, t: 'READY', s: 7, id: 'evt-ready', d: { session_id: 'sess-hb', user: { id: 'bot-1' } } })
  await waitFor(() => gateway.status().state === 'online')

  await waitFor(() => socket.sent.some((payload) => payload.op === 1))
  const heartbeat = socket.sent.find((payload) => payload.op === 1)
  assert.equal(heartbeat.d, 7, '心跳应携带最后一个 dispatch seq')

  const heartbeatCount = socket.sent.filter((payload) => payload.op === 1).length
  const before = Date.now()
  socket.message({ op: 11 })
  assert.ok(gateway.status().lastHeartbeatAt >= before, 'op11 应刷新 lastHeartbeatAt')

  socket.message({ op: 1, d: null })
  await waitFor(() => socket.sent.filter((payload) => payload.op === 1).length > heartbeatCount)
})

test('op7 立即重连并 Resume（保留 session）', async (t) => {
  const { gateway } = bootGateway(t)
  await gateway.start()
  const socket = FakeWebSocket.instances[0]
  await goOnline(gateway, socket)

  socket.message({ op: 7 })
  assert.equal(gateway.status().state, 'reconnecting')
  assert.equal(socket.closed, true, 'op7 应丢弃当前连接')
  await waitFor(() => FakeWebSocket.instances.length === 2)

  const resumedSocket = FakeWebSocket.instances[1]
  resumedSocket.open()
  resumedSocket.message({ op: 10, d: { heartbeat_interval: 5000 } })
  await waitFor(() => resumedSocket.sent.length >= 1)
  const resume = resumedSocket.sent[0]
  assert.equal(resume.op, 6)
  assert.equal(resume.d.token, 'QQBot tok-123')
  assert.equal(resume.d.session_id, 'sess-1')
  assert.equal(resume.d.seq, 1)
})

test('op9 清空 session 后重新 Identify', async (t) => {
  const { gateway } = bootGateway(t)
  await gateway.start()
  const socket = FakeWebSocket.instances[0]
  await goOnline(gateway, socket)

  socket.message({ op: 9 })
  await waitFor(() => FakeWebSocket.instances.length === 2)
  assert.equal(gateway.status().sessionId, null, 'op9 应清空 session_id')
  assert.equal(gateway.status().seq, null)

  const freshSocket = FakeWebSocket.instances[1]
  freshSocket.open()
  freshSocket.message({ op: 10, d: { heartbeat_interval: 5000 } })
  await waitFor(() => freshSocket.sent.length >= 1)
  assert.equal(freshSocket.sent[0].op, 2, 'session 清除后应重新 Identify')
})

test('致命关闭码 4004 进入 offline 且不再重连', async (t) => {
  const { gateway } = bootGateway(t)
  await gateway.start()
  const socket = FakeWebSocket.instances[0]
  await goOnline(gateway, socket)

  socket.serverClose(4004, 'auth failed')
  await waitFor(() => gateway.status().state === 'offline')
  assert.match(gateway.status().lastError, /4004/)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(FakeWebSocket.instances.length, 1, '致命关闭码不应重连')
})

test('异常关闭 1006 指数退避后自动重连并 Resume', async (t) => {
  const { gateway } = bootGateway(t)
  await gateway.start()
  const socket = FakeWebSocket.instances[0]
  await goOnline(gateway, socket)

  socket.serverClose(1006, 'network lost')
  assert.equal(gateway.status().state, 'reconnecting')
  assert.ok(gateway.status().attempts >= 1)
  await waitFor(() => FakeWebSocket.instances.length === 2)

  const retrySocket = FakeWebSocket.instances[1]
  retrySocket.open()
  retrySocket.message({ op: 10, d: { heartbeat_interval: 5000 } })
  await waitFor(() => retrySocket.sent.length >= 1)
  assert.equal(retrySocket.sent[0].op, 6)
})

test('连接失败按 maxAttempts 停在 offline，start 不抛错', async (t) => {
  const api = makeApiStub({
    async getGatewayUrl() {
      throw new Error('无法获取网关地址')
    }
  })
  const configStore = gatewayConfigStore({ reconnect: { baseDelayMs: 200, maxDelayMs: 400, maxAttempts: 1 } })
  const { gateway, logger } = bootGateway(t, { api, configStore })

  const started = await gateway.start()
  assert.equal(started.state, 'reconnecting', '首次失败进入重连等待')
  await waitFor(() => gateway.status().state === 'offline', { timeoutMs: 4000 })
  assert.match(gateway.status().lastError, /无法获取网关地址/)
  assert.equal(FakeWebSocket.instances.length, 0)
  assert.ok(logger.entries.some((entry) => entry.level === 'warn'))
})

test('WebSocket error 事件不会崩溃并触发重连', async (t) => {
  const { gateway } = bootGateway(t)
  await gateway.start()
  const socket = FakeWebSocket.instances[0]
  await goOnline(gateway, socket)

  socket.serverError('socket reset')
  assert.equal(gateway.status().state, 'reconnecting')
  assert.match(gateway.status().lastError, /socket reset/)
  await waitFor(() => FakeWebSocket.instances.length === 2)
})

test('stop 后旧 socket 的 close 事件不会再重连', async (t) => {
  const { gateway } = bootGateway(t)
  await gateway.start()
  const socket = FakeWebSocket.instances[0]
  await goOnline(gateway, socket)

  await gateway.stop()
  socket.serverClose(1006, 'late close')
  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.equal(FakeWebSocket.instances.length, 1, 'stop 后不得重连')
  assert.equal(gateway.status().state, 'idle')
})

test('畸形/未知网关消息只记日志，不影响后续握手', async (t) => {
  const { gateway, logger } = bootGateway(t)
  await gateway.start()
  const socket = FakeWebSocket.instances[0]
  socket.open()
  socket.message('not-json')
  socket.message({ op: 999, d: {} })
  await waitFor(() => logger.entries.some((entry) => entry.level === 'warn'))
  assert.equal(gateway.status().state, 'connecting')

  socket.message({ op: 10, d: { heartbeat_interval: 5000 } })
  await waitFor(() => socket.sent.length >= 1)
  assert.equal(socket.sent[0].op, 2, '畸形消息后仍能正常 Identify')
})

test('协议构造函数：Identify / Resume / Heartbeat / 退避 / 关闭码', () => {
  const identify = buildIdentifyPayload({ accessToken: 'tok-1', intents: 33554432, shard: [0, 1] })
  assert.equal(identify.op, 2)
  assert.equal(identify.d.token, 'QQBot tok-1')
  assert.equal(identify.d.intents, 33554432)
  assert.deepEqual(identify.d.shard, [0, 1])
  assert.equal(identify.d.properties.$os, process.platform)
  assert.equal(typeof identify.d.properties.$browser, 'string')
  assert.equal(buildIdentifyPayload({}).d.token, 'QQBot ')

  const resume = buildResumePayload({ accessToken: 'tok-2', sessionId: 'sess-1', seq: 42 })
  assert.deepEqual(resume, { op: 6, d: { token: 'QQBot tok-2', session_id: 'sess-1', seq: 42 } })

  assert.deepEqual(buildHeartbeatPayload(9), { op: 1, d: 9 })
  assert.deepEqual(buildHeartbeatPayload(null), { op: 1, d: null })
  assert.deepEqual(buildHeartbeatPayload(undefined), { op: 1, d: null })

  const backoff = { baseDelayMs: 200, maxDelayMs: 500 }
  assert.equal(nextBackoffMs(1, backoff), 200)
  assert.equal(nextBackoffMs(2, backoff), 400)
  assert.equal(nextBackoffMs(3, backoff), 500)
  assert.equal(nextBackoffMs(100, backoff), 500)
  assert.equal(nextBackoffMs(0, { baseDelayMs: 100, maxDelayMs: 1000 }), 100)

  for (const code of [4004, 4006, 4007, 4009, 4010, 4914, 4915]) {
    assert.equal(isResumableCloseCode(code), false, `${code} 不应恢复 session`)
  }
  for (const code of [1000, 1006, 4008, 4011]) {
    assert.equal(isResumableCloseCode(code), true, `${code} 可以恢复 session`)
  }
  assert.equal(isResumableCloseCode(undefined), false)
})

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() {
      return JSON.stringify(body)
    }
  }
}

function makeIndexFetch() {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    calls.push({ url: target, init })
    if (target.includes('/app/getAppAccessToken')) return jsonResponse({ access_token: 'tok-index', expires_in: 7200 })
    if (target.endsWith('/gateway')) return jsonResponse({ url: 'wss://gateway.test/ws' })
    if (target.includes('/users/@me')) return jsonResponse({ id: 'bot-9', username: '小Q' })
    if (target.includes('/messages')) return jsonResponse({ id: 'sent-1' })
    return jsonResponse({})
  }
  fetchImpl.calls = calls
  return fetchImpl
}

test('createQQClient：待命 → 连接 → 去重入站 → 发送 → testAuth', async (t) => {
  FakeWebSocket.reset()
  const configStore = makeConfigStore({
    qq: { appId: '', appSecret: '', reconnect: { baseDelayMs: 200, maxDelayMs: 400, maxAttempts: 0 } }
  })
  const logger = makeLogger()
  const inbound = []
  const fetchImpl = makeIndexFetch()
  const client = createQQClient({
    configStore,
    logger,
    onInbound: (event) => inbound.push(event),
    fetchImpl,
    WebSocketImpl: FakeWebSocket
  })
  t.after(async () => {
    await client.stop()
  })

  await client.start()
  assert.equal(client.status().state, 'standby')
  assert.equal(client.status().enabled, true)
  assert.equal(client.status().hasCredentials, false)
  await assert.rejects(client.sendText({ kind: 'c2c', targetId: 'u-1' }, '你好'), /QQ bot is not connected/)

  configStore.setConfig({ qq: { appId: '1000001', appSecret: 'secret-value' } })
  await client.restart()
  const socket = FakeWebSocket.instances.at(-1)
  assert.ok(socket, '有凭据后应建立 WebSocket')

  socket.open()
  socket.message({ op: 10, d: { heartbeat_interval: 5000 } })
  await waitFor(() => socket.sent.some((payload) => payload.op === 2))
  socket.message({ op: 0, t: 'READY', s: 1, id: 'evt-ready', d: { session_id: 'sess-index', user: { id: 'bot-9' } } })
  await waitFor(() => client.status().state === 'online')
  assert.equal(client.status().bot.id, 'bot-9')

  const data = { id: 'msg-100', content: '  你好  ', timestamp: '2026-11-09T10:00:00+08:00', author: { user_openid: 'u-1' } }
  socket.message({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, id: 'evt-msg-1', d: data })
  socket.message({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 3, id: 'evt-msg-1', d: data })
  await waitFor(() => inbound.length === 1)
  assert.equal(inbound[0].kind, 'c2c')
  assert.equal(inbound[0].chatId, 'c2c_u-1')
  assert.equal(inbound[0].text, '你好')
  assert.equal(client.status().received, 1, '重复事件应被去重')
  assert.equal(typeof client.status().lastInboundAt, 'number')

  const result = await client.sendText(
    { kind: 'c2c', targetId: 'u-1' },
    '收到',
    { replyTo: { msgId: 'msg-100', receivedAt: Date.now(), kind: 'c2c' } }
  )
  assert.deepEqual(result, { ids: ['sent-1'], passive: true })
  assert.equal(client.status().sent, 1)

  const messageCall = fetchImpl.calls.filter((call) => call.url.includes('/v2/users/u-1/messages')).at(-1)
  const body = JSON.parse(messageCall.init.body)
  assert.equal(body.content, '收到')
  assert.equal(body.msg_id, 'msg-100')
  assert.equal(body.msg_seq, 1)
  assert.equal(messageCall.init.headers.Authorization, 'QQBot tok-index')

  const auth = await client.testAuth()
  assert.equal(auth.ok, true)
  assert.equal(auth.tokenExpiresIn, 7200)
  assert.equal(auth.gatewayUrl, 'wss://gateway.test/ws')
  assert.deepEqual(auth.bot, { id: 'bot-9', username: '小Q' })
  assert.equal(JSON.stringify(auth).includes('tok-index'), false, 'testAuth 不得回传 token')
})
