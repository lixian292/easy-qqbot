/** Tests for host/qq/api.js — no network, injected fetch only. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createQQApi, QQApiError } from '../host/qq/api.js'
import { makeConfigStore, makeLogger } from './helpers.mjs'

function makeResponse({ body, status = 200, headers = {} } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headerMap.get(String(name).toLowerCase()) ?? null },
    async text() {
      return body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
    },
    async json() {
      return body ?? {}
    }
  }
}

function makeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init, calls.length)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function credentialStore(overrides = {}) {
  return makeConfigStore({ qq: { appId: '1000001', appSecret: 'secret-value', ...overrides } })
}

function tokenOk(token = 'tok-abc', expiresIn = 7200) {
  return makeResponse({ body: { access_token: token, expires_in: expiresIn } })
}

function isTokenUrl(url) {
  return url.includes('/app/getAppAccessToken')
}

test('getToken 获取并缓存 access_token，force 强制刷新，且不泄露密钥', async () => {
  const logger = makeLogger()
  const fetchImpl = makeFetch((url) => (isTokenUrl(url) ? tokenOk('tok-abc') : makeResponse({ body: {} })))
  const api = createQQApi({ configStore: credentialStore(), logger, fetchImpl })

  const first = await api.getToken()
  assert.equal(first.accessToken, 'tok-abc')
  assert.equal(first.expiresIn, 7200)
  assert.equal(typeof first.fetchedAt, 'number')
  assert.equal(fetchImpl.calls.length, 1)

  const second = await api.getToken()
  assert.equal(second.accessToken, 'tok-abc')
  assert.equal(fetchImpl.calls.length, 1, 'token 应命中缓存')

  await api.getToken({ force: true })
  assert.equal(fetchImpl.calls.length, 2, 'force 应重新请求 token')

  const init = fetchImpl.calls[0].init
  assert.equal(init.method, 'POST')
  assert.deepEqual(JSON.parse(init.body), { appId: '1000001', clientSecret: 'secret-value' })
  assert.ok(fetchImpl.calls[0].url.startsWith('https://api.bot.qq.com/'))

  const dumped = JSON.stringify(logger.entries)
  assert.equal(dumped.includes('secret-value'), false, 'AppSecret 不得进日志')
  assert.equal(dumped.includes('tok-abc'), false, 'access_token 不得进日志')
})

test('request 带 QQBot 鉴权头，getGatewayUrl 返回 url，invalidateToken 清缓存', async () => {
  const fetchImpl = makeFetch((url) => {
    if (isTokenUrl(url)) return tokenOk('tok-xyz')
    return makeResponse({ body: { url: 'wss://gateway.example/ws' } })
  })
  const api = createQQApi({ configStore: credentialStore(), logger: makeLogger(), fetchImpl })

  const gatewayUrl = await api.getGatewayUrl()
  assert.equal(gatewayUrl, 'wss://gateway.example/ws')

  const gatewayCall = fetchImpl.calls.find((call) => call.url.endsWith('/gateway'))
  assert.ok(gatewayCall, '应请求 /gateway')
  assert.equal(gatewayCall.init.headers.Authorization, 'QQBot tok-xyz')

  api.invalidateToken()
  await api.getGatewayUrl()
  assert.equal(fetchImpl.calls.filter((call) => isTokenUrl(call.url)).length, 2, 'invalidateToken 后应重新取 token')
})

test('HTTP 错误与业务 err_code 都映射为 QQApiError', async () => {
  const fetchImpl = makeFetch((url) => {
    if (isTokenUrl(url)) return tokenOk('tok-1')
    if (url.includes('/v2/users/u-1/messages')) {
      return makeResponse({ status: 401, body: { err_code: 11244, message: 'token invalid' }, headers: { 'x-trace-id': 'trace-1' } })
    }
    return makeResponse({ body: { err_code: 50001, message: 'group restricted' } })
  })
  const api = createQQApi({ configStore: credentialStore(), logger: makeLogger(), fetchImpl })

  await assert.rejects(api.sendText({ kind: 'c2c', targetId: 'u-1', content: 'hi' }), (error) => {
    assert.ok(error instanceof QQApiError)
    assert.equal(error.name, 'QQApiError')
    assert.equal(error.code, 'HTTP_401')
    assert.equal(error.status, 401)
    assert.equal(error.errCode, 11244)
    assert.equal(error.traceId, 'trace-1')
    assert.match(error.message, /token invalid/)
    return true
  })
  assert.ok(fetchImpl.calls.some((call) => call.url.includes('/v2/users/u-1/messages')))

  await assert.rejects(api.sendText({ kind: 'group', targetId: 'g-1', content: 'hi' }), (error) => {
    assert.ok(error instanceof QQApiError)
    assert.equal(error.code, 'API_50001')
    assert.equal(error.errCode, 50001)
    return true
  })
})

test('网络错误与超时分别映射为 NETWORK / TIMEOUT', async () => {
  const networkFetch = makeFetch((url) => {
    if (isTokenUrl(url)) return tokenOk('tok-2')
    throw new Error('ECONNRESET')
  })
  const networkApi = createQQApi({ configStore: credentialStore(), logger: makeLogger(), fetchImpl: networkFetch })
  await assert.rejects(networkApi.sendText({ kind: 'c2c', targetId: 'u-1', content: 'hi' }), (error) => {
    assert.ok(error instanceof QQApiError)
    assert.equal(error.code, 'NETWORK')
    return true
  })

  const slowFetch = makeFetch((url) => {
    if (isTokenUrl(url)) return tokenOk('tok-3')
    return new Promise(() => {})
  })
  const slowApi = createQQApi({ configStore: credentialStore(), logger: makeLogger(), fetchImpl: slowFetch })
  await assert.rejects(slowApi.request({ path: '/slow', timeoutMs: 30 }), (error) => {
    assert.ok(error instanceof QQApiError)
    assert.equal(error.code, 'TIMEOUT')
    return true
  })
})

test('缺少凭据 / token 接口报错 / 机器人信息失败降级', async () => {
  const noCredFetch = makeFetch(() => makeResponse({ body: {} }))
  const noCredApi = createQQApi({
    configStore: makeConfigStore({ qq: { appId: '', appSecret: '' } }),
    logger: makeLogger(),
    fetchImpl: noCredFetch
  })
  await assert.rejects(noCredApi.getToken(), (error) => {
    assert.ok(error instanceof QQApiError)
    assert.equal(error.code, 'NO_CREDENTIALS')
    return true
  })
  await assert.rejects(noCredApi.request({ path: '/gateway' }), (error) => error.code === 'NO_CREDENTIALS')
  assert.equal(noCredFetch.calls.length, 0, '缺凭据时不应发请求')

  const badTokenFetch = makeFetch(() => makeResponse({ body: { code: 100007, message: 'invalid appid' } }))
  const badTokenApi = createQQApi({ configStore: credentialStore(), logger: makeLogger(), fetchImpl: badTokenFetch })
  await assert.rejects(badTokenApi.getToken(), (error) => {
    assert.ok(error instanceof QQApiError)
    assert.equal(error.code, 'TOKEN_FAILED')
    assert.equal(error.errCode, 100007)
    assert.match(error.message, /invalid appid/)
    return true
  })

  const botFailFetch = makeFetch((url) => {
    if (isTokenUrl(url)) return tokenOk('tok-4')
    return makeResponse({ status: 500, body: { message: 'server error' } })
  })
  const botFailApi = createQQApi({ configStore: credentialStore(), logger: makeLogger(), fetchImpl: botFailFetch })
  assert.equal(await botFailApi.getBotMe(), null, 'getBotMe 失败返回 null')

  const botOkFetch = makeFetch((url) => {
    if (isTokenUrl(url)) return tokenOk('tok-5')
    return makeResponse({ body: { id: 'bot-1', username: '小Q' } })
  })
  const botOkApi = createQQApi({ configStore: credentialStore(), logger: makeLogger(), fetchImpl: botOkFetch })
  assert.deepEqual(await botOkApi.getBotMe(), { id: 'bot-1', username: '小Q' })
})

test('uploadMedia：base64 请求体、file_info 归一化、5MB 上限', async () => {
  const buffer = Buffer.from('fake-image-bytes')
  const fetchImpl = makeFetch((url) => {
    if (isTokenUrl(url)) return tokenOk('tok-6')
    return makeResponse({ body: { file_info: 'file-info-1', file_uuid: 'uuid-1', ttl: 3600, url: 'https://multimedia.example/img' } })
  })
  const api = createQQApi({ configStore: credentialStore(), logger: makeLogger(), fetchImpl })

  const uploaded = await api.uploadMedia({ kind: 'group', targetId: 'g-1', buffer, fileName: 'a.png' })
  assert.equal(uploaded.fileInfo, 'file-info-1')
  assert.equal(uploaded.fileUuid, 'uuid-1')
  assert.equal(uploaded.ttl, 3600)
  assert.equal(uploaded.rawUrl, 'https://multimedia.example/img')

  const filesCall = fetchImpl.calls.find((call) => call.url.includes('/v2/groups/g-1/files'))
  assert.ok(filesCall, '应请求群文件上传路径')
  const body = JSON.parse(filesCall.init.body)
  assert.equal(body.file_type, 1)
  assert.equal(body.file_name, 'a.png')
  assert.equal(body.file_data, buffer.toString('base64'))

  const hugeApi = createQQApi({
    configStore: credentialStore(),
    logger: makeLogger(),
    fetchImpl: makeFetch(() => {
      throw new Error('超限时不应发请求')
    })
  })
  await assert.rejects(hugeApi.uploadMedia({ kind: 'c2c', targetId: 'u-1', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) }), (error) => {
    assert.ok(error instanceof QQApiError)
    assert.equal(error.code, 'MEDIA_TOO_LARGE')
    return true
  })
})

test('sendText / sendImage 请求体符合 QQ v2 消息协议', async () => {
  const fetchImpl = makeFetch((url) => {
    if (isTokenUrl(url)) return tokenOk('tok-7')
    return makeResponse({ body: { id: 'message-id-1', timestamp: '2026-11-09T10:00:00+08:00' } })
  })
  const api = createQQApi({ configStore: credentialStore(), logger: makeLogger(), fetchImpl })

  const textResponse = await api.sendText({ kind: 'c2c', targetId: 'u-1', content: '你好' })
  assert.equal(textResponse.id, 'message-id-1')
  let call = fetchImpl.calls.find((item) => item.url.includes('/v2/users/u-1/messages'))
  let body = JSON.parse(call.init.body)
  assert.deepEqual(body, { msg_type: 0, content: '你好' })

  await api.sendText({ kind: 'group', targetId: 'g-1', content: '被动回复', msgId: 'm-0', msgSeq: 3, eventId: 'evt-1' })
  call = fetchImpl.calls.find((item) => item.url.includes('/v2/groups/g-1/messages'))
  body = JSON.parse(call.init.body)
  assert.deepEqual(body, { msg_type: 0, content: '被动回复', msg_id: 'm-0', msg_seq: 3, event_id: 'evt-1' })

  await api.sendImage({ kind: 'c2c', targetId: 'u-1', fileInfo: 'file-info-9', msgId: 'm-1', msgSeq: 1 })
  call = fetchImpl.calls.filter((item) => item.url.includes('/v2/users/u-1/messages')).at(-1)
  body = JSON.parse(call.init.body)
  assert.deepEqual(body, { msg_type: 7, media: { file_info: 'file-info-9' }, msg_id: 'm-1', msg_seq: 1 })

  await assert.rejects(api.sendImage({ kind: 'c2c', targetId: 'u-1' }), (error) => error.code === 'BAD_REQUEST')
})

test('204 空响应返回 {}，query 参数正确拼接', async () => {
  const fetchImpl = makeFetch((url) => {
    if (isTokenUrl(url)) return tokenOk('tok-8')
    if (url.includes('/empty')) return makeResponse({ status: 204 })
    return makeResponse({ body: { ok: true } })
  })
  const api = createQQApi({ configStore: credentialStore(), logger: makeLogger(), fetchImpl })
  assert.deepEqual(await api.request({ path: '/empty' }), {})
  await api.request({ method: 'GET', path: '/search', query: { keyword: '猫', limit: 2 } })
  const searchCall = fetchImpl.calls.find((call) => call.url.includes('/search'))
  assert.ok(searchCall.url.includes('keyword=%E7%8C%AB'))
  assert.ok(searchCall.url.includes('limit=2'))
})
