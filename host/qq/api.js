/**
 * QQ official bot REST client.
 *
 * Zero dependencies: HTTP goes through the injected `fetchImpl` (defaults to
 * the global `fetch` of Node 24). The access token is cached in memory and
 * considered stale 60 seconds before the server-provided expiry. Secrets and
 * tokens are never written to the log and never included in error messages.
 */
const DEFAULT_API_BASE = 'https://api.bot.qq.com'
const DEFAULT_TOKEN_PATH = '/app/getAppAccessToken'
const DEFAULT_GATEWAY_PATH = '/gateway'
const DEFAULT_TIMEOUT_MS = 15000
const TOKEN_EXPIRY_MARGIN_MS = 60000
const MAX_MEDIA_BYTES = 5 * 1024 * 1024

/** Error thrown by every QQ API call; `code` is stable and safe to switch on. */
export class QQApiError extends Error {
  code
  status
  errCode
  traceId

  constructor(message, { code = 'QQ_API_ERROR', status = 0, errCode, traceId, cause } = {}) {
    super(String(message ?? 'QQ 接口错误'), cause === undefined ? undefined : { cause })
    this.name = 'QQApiError'
    this.code = code
    this.status = Number(status) || 0
    this.errCode = errCode
    this.traceId = traceId
  }
}

const KIND_SEGMENTS = Object.freeze({ group: 'groups', c2c: 'users' })

function kindSegment(kind) {
  const segment = KIND_SEGMENTS[kind]
  if (segment === undefined) throw new QQApiError(`无效的消息类型：${String(kind)}`, { code: 'BAD_REQUEST' })
  return segment
}

function errorCodeOf(value) {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : value
}

function positiveNumberOrUndefined(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function configOf(configStore) {
  try {
    return configStore?.get?.() ?? {}
  } catch {
    return {}
  }
}

function apiBaseOf(config) {
  const base = String(config?.qq?.apiBase || DEFAULT_API_BASE)
  return base.replace(/\/+$/, '')
}

function buildUrl(base, requestPath, query) {
  const suffix = String(requestPath ?? '')
  const normalized = suffix.startsWith('/') ? suffix : `/${suffix}`
  const url = new URL(`${base}${normalized}`)
  if (query !== null && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis)
  return null
}

function traceIdOf(response, data) {
  const headers = response?.headers
  if (headers !== null && typeof headers === 'object' && typeof headers.get === 'function') {
    try {
      const headerTrace = headers.get('x-trace-id')
      if (typeof headerTrace === 'string' && headerTrace !== '') return headerTrace
    } catch {
      // ignore malformed header collections
    }
  }
  for (const key of ['trace_id', 'traceId', 'x-trace-id']) {
    const value = data?.[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function isResponseOk(response) {
  if (typeof response?.ok === 'boolean') return response.ok
  const status = Number(response?.status)
  return Number.isFinite(status) ? status >= 200 && status < 300 : true
}

async function readResponseBody(response) {
  if (Number(response?.status) === 204) return {}
  try {
    if (typeof response?.text === 'function') {
      const raw = await response.text()
      if (typeof raw !== 'string' || raw.trim() === '') return {}
      return JSON.parse(raw)
    }
    if (typeof response?.json === 'function') {
      const parsed = await response.json()
      return parsed === undefined || parsed === null ? {} : parsed
    }
  } catch {
    return {}
  }
  return {}
}

/**
 * @param {object} options
 * @param {{ get(): object }} options.configStore current plugin config (read on every call)
 * @param {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} [options.logger]
 * @param {typeof fetch} [options.fetchImpl] injected fetch for tests
 */
export function createQQApi({ configStore, logger, fetchImpl } = {}) {
  const log = logger ?? { debug() {}, info() {}, warn() {}, error() {} }
  const httpFetch = resolveFetch(fetchImpl)

  /** @type {{accessToken: string, expiresIn: number, fetchedAt: number, expiresAt: number} | null} */
  let tokenCache = null
  /** @type {Promise<object> | null} */
  let tokenPromise = null

  function publicToken(cache) {
    return { accessToken: cache.accessToken, expiresIn: cache.expiresIn, fetchedAt: cache.fetchedAt }
  }

  async function doFetch(url, init, timeoutMs) {
    if (httpFetch === null) throw new QQApiError('当前运行环境不支持 fetch，无法访问 QQ 接口', { code: 'NETWORK' })
    const waitMs = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    let timer = null
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        try {
          controller?.abort()
        } catch {
          // ignore abort failures
        }
        reject(new QQApiError('请求 QQ 接口超时', { code: 'TIMEOUT' }))
      }, waitMs)
      timer.unref?.()
    })
    try {
      const requestInit = controller === null ? init : { ...init, signal: controller.signal }
      return await Promise.race([httpFetch(url, requestInit), timeout])
    } catch (error) {
      if (error instanceof QQApiError) throw error
      throw new QQApiError(`请求 QQ 接口失败：${error?.message ?? String(error)}`, { code: 'NETWORK', cause: error })
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  async function loadToken() {
    const now = Date.now()
    const config = configOf(configStore)
    const appId = typeof config?.qq?.appId === 'string' ? config.qq.appId.trim() : ''
    const appSecret = typeof config?.qq?.appSecret === 'string' ? config.qq.appSecret.trim() : ''
    if (appId === '' || appSecret === '') {
      throw new QQApiError('尚未配置 QQ 机器人的 AppID / AppSecret', { code: 'NO_CREDENTIALS' })
    }
    const tokenPath = typeof config?.qq?.tokenPath === 'string' && config.qq.tokenPath !== '' ? config.qq.tokenPath : DEFAULT_TOKEN_PATH
    const url = buildUrl(apiBaseOf(config), tokenPath)
    const response = await doFetch(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret: appSecret })
      },
      DEFAULT_TIMEOUT_MS
    )
    const data = await readResponseBody(response)
    const traceId = traceIdOf(response, data)
    const accessToken = typeof data?.access_token === 'string' ? data.access_token : ''
    const expiresIn = positiveNumberOrUndefined(data?.expires_in) ?? 0
    if (!isResponseOk(response) || accessToken === '') {
      const statusValue = Number(response?.status) || 0
      const errCode = errorCodeOf(data?.err_code ?? data?.code)
      const reason = data?.message ?? data?.msg ?? (isResponseOk(response) ? '响应缺少 access_token' : `HTTP ${statusValue}`)
      const code = isResponseOk(response) ? 'TOKEN_FAILED' : `HTTP_${statusValue}`
      throw new QQApiError(`获取 QQ access_token 失败：${reason}`, { code, status: statusValue, errCode, traceId })
    }
    const ttlMs = expiresIn > 0 ? expiresIn * 1000 : TOKEN_EXPIRY_MARGIN_MS * 2
    const expiresAt = now + Math.max(1000, ttlMs - TOKEN_EXPIRY_MARGIN_MS)
    tokenCache = { accessToken, expiresIn, fetchedAt: now, expiresAt }
    log.debug?.('已获取 QQ access_token', { expiresIn })
    return tokenCache
  }

  /** Fetch (and cache) the app access token. */
  async function getToken({ force = false } = {}) {
    const now = Date.now()
    if (force !== true && tokenCache !== null && tokenCache.expiresAt > now) return publicToken(tokenCache)
    if (force !== true && tokenPromise !== null) return publicToken(await tokenPromise)
    const promise = loadToken()
    if (tokenPromise === null || force === true) tokenPromise = promise
    promise.then(
      () => {
        if (tokenPromise === promise) tokenPromise = null
      },
      () => {
        if (tokenPromise === promise) tokenPromise = null
      }
    )
    return publicToken(await promise)
  }

  function invalidateToken() {
    tokenCache = null
  }

  function messagePath(kind, targetId) {
    const id = String(targetId ?? '').trim()
    if (id === '') throw new QQApiError('缺少发送目标 openid', { code: 'BAD_REQUEST' })
    return `/v2/${kindSegment(kind)}/${encodeURIComponent(id)}/messages`
  }

  /** Unified authenticated request helper. Returns the parsed JSON body. */
  async function request({ method = 'GET', path: requestPath = '', query, body, auth = true, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof requestPath !== 'string' || requestPath === '') {
      throw new QQApiError('QQ 请求路径为空', { code: 'BAD_REQUEST' })
    }
    const config = configOf(configStore)
    const url = buildUrl(apiBaseOf(config), requestPath, query)
    const headers = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (auth === true) {
      const token = await getToken()
      headers.Authorization = `QQBot ${token.accessToken}`
    }
    const init = { method: String(method || 'GET').toUpperCase(), headers }
    if (body !== undefined) init.body = JSON.stringify(body)
    log.debug?.(`QQ API ${init.method} ${requestPath}`)
    const response = await doFetch(url, init, timeoutMs)
    const data = await readResponseBody(response)
    const statusValue = Number(response?.status) || 0
    const traceId = traceIdOf(response, data)
    if (!isResponseOk(response)) {
      const errCode = errorCodeOf(data?.err_code ?? data?.code)
      const reason = data?.message ?? data?.msg ?? `HTTP ${statusValue}`
      throw new QQApiError(`QQ 接口请求失败：${reason}`, { code: `HTTP_${statusValue}`, status: statusValue, errCode, traceId })
    }
    if (data !== null && typeof data === 'object' && data.err_code !== undefined && Number(data.err_code) !== 0) {
      const errCode = errorCodeOf(data.err_code)
      const reason = data.message ?? data.msg ?? '未知错误'
      const code = errCode === undefined ? 'API_ERROR' : `API_${errCode}`
      throw new QQApiError(`QQ 接口返回错误：${reason}`, { code, status: statusValue, errCode, traceId })
    }
    return data ?? {}
  }

  /** Resolve the WebSocket gateway url. */
  async function getGatewayUrl() {
    const config = configOf(configStore)
    const gatewayPath = typeof config?.qq?.gatewayPath === 'string' && config.qq.gatewayPath !== '' ? config.qq.gatewayPath : DEFAULT_GATEWAY_PATH
    const data = await request({ path: gatewayPath })
    const url = typeof data?.url === 'string' && data.url !== '' ? data.url : typeof data?.gateway_url === 'string' ? data.gateway_url : ''
    if (url === '') throw new QQApiError('QQ 网关地址缺失', { code: 'BAD_RESPONSE' })
    return url
  }

  /** Upload an image to QQ's media store and return its `file_info`. */
  async function uploadMedia({ kind, targetId, buffer, fileName, fileType = 1 } = {}) {
    kindSegment(kind) // validate kind before touching the buffer
    const id = String(targetId ?? '').trim()
    if (id === '') throw new QQApiError('缺少上传目标 openid', { code: 'BAD_REQUEST' })
    let data
    if (Buffer.isBuffer(buffer)) data = buffer
    else if (buffer instanceof Uint8Array) data = Buffer.from(buffer)
    else throw new QQApiError('图片内容必须是 Buffer', { code: 'BAD_REQUEST' })
    if (data.length === 0) throw new QQApiError('图片内容为空', { code: 'BAD_MEDIA' })
    if (data.length > MAX_MEDIA_BYTES) throw new QQApiError('图片超过 5MB 限制，无法发送', { code: 'MEDIA_TOO_LARGE' })
    const name = typeof fileName === 'string' && fileName.trim() !== '' ? fileName.trim() : 'image.jpg'
    const response = await request({
      method: 'POST',
      path: `/v2/${kindSegment(kind)}/${encodeURIComponent(id)}/files`,
      body: { file_type: fileType, file_name: name, file_data: data.toString('base64') }
    })
    const fileInfo = typeof response?.file_info === 'string' ? response.file_info : typeof response?.fileInfo === 'string' ? response.fileInfo : ''
    if (fileInfo === '') throw new QQApiError('上传图片失败：QQ 接口未返回 file_info', { code: 'BAD_RESPONSE' })
    return {
      fileInfo,
      fileUuid: typeof response?.file_uuid === 'string' ? response.file_uuid : typeof response?.fileUuid === 'string' ? response.fileUuid : undefined,
      ttl: positiveNumberOrUndefined(response?.ttl) ?? 0,
      rawUrl: typeof response?.url === 'string' ? response.url : typeof response?.file_url === 'string' ? response.file_url : undefined
    }
  }

  /** Send a plain text message (passive reply when msgId is provided). */
  async function sendText({ kind, targetId, content, msgId, msgSeq, eventId } = {}) {
    const body = { msg_type: 0, content: String(content ?? '') }
    if (typeof msgId === 'string' && msgId !== '') {
      body.msg_id = msgId
      body.msg_seq = positiveNumberOrUndefined(msgSeq) ?? 1
    }
    if (typeof eventId === 'string' && eventId !== '') body.event_id = eventId
    return request({ method: 'POST', path: messagePath(kind, targetId), body })
  }

  /** Send an image by `file_info` returned from `uploadMedia` (msg_type 7). */
  async function sendImage({ kind, targetId, fileInfo, msgId, msgSeq, eventId } = {}) {
    if (typeof fileInfo !== 'string' || fileInfo === '') {
      throw new QQApiError('缺少 file_info，无法发送图片', { code: 'BAD_REQUEST' })
    }
    const body = { msg_type: 7, media: { file_info: fileInfo } }
    if (typeof msgId === 'string' && msgId !== '') {
      body.msg_id = msgId
      body.msg_seq = positiveNumberOrUndefined(msgSeq) ?? 1
    }
    if (typeof eventId === 'string' && eventId !== '') body.event_id = eventId
    return request({ method: 'POST', path: messagePath(kind, targetId), body })
  }

  /** Bot profile. Never throws: returns null so callers can gate optional UI. */
  async function getBotMe() {
    try {
      return await request({ path: '/users/@me' })
    } catch (error) {
      log.warn?.('获取 QQ 机器人信息失败', { code: error?.code, error: error?.message })
      return null
    }
  }

  return { getToken, request, getGatewayUrl, uploadMedia, sendText, sendImage, getBotMe, invalidateToken }
}
