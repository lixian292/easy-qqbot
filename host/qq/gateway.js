/**
 * QQ official bot WebSocket gateway: Hello/Identify/Resume handshake,
 * heartbeat, dispatch forwarding and exponential-backoff reconnects.
 *
 * The socket constructor is injectable (`WebSocketImpl`) so the whole state
 * machine can be tested offline with a fake socket. Every socket callback and
 * timer is guarded: nothing is allowed to throw into the process.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 41250

/** Close codes that must not be retried (bad credentials / bot removed). */
const FATAL_CLOSE_CODES = new Set([4004, 4914, 4915])
/** Close codes that mean the session is gone and Identify is required. */
const SESSION_LOST_CLOSE_CODES = new Set([4006, 4007, 4009, 4010, 4012, 4013])

const STATUS_LABELS = Object.freeze({
  idle: '空闲',
  connecting: '连接中',
  online: '在线',
  reconnecting: '重连中',
  offline: '离线'
})

/** Build the op 2 Identify payload. The token is prefixed as QQ expects. */
export function buildIdentifyPayload({ accessToken, intents = 0, shard = [0, 1] } = {}) {
  const normalizedShard = Array.isArray(shard) && shard.length === 2 ? shard.map((value) => (Number.isFinite(Number(value)) ? Number(value) : 0)) : [0, 1]
  return {
    op: 2,
    d: {
      token: `QQBot ${accessToken ?? ''}`,
      intents: Number(intents) || 0,
      shard: normalizedShard,
      properties: { $os: process.platform, $browser: 'easy-qqbot', $device: 'dsh' }
    }
  }
}

/** Build the op 6 Resume payload. */
export function buildResumePayload({ accessToken, sessionId, seq } = {}) {
  const sequence = Number(seq)
  return {
    op: 6,
    d: {
      token: `QQBot ${accessToken ?? ''}`,
      session_id: sessionId ?? '',
      seq: Number.isFinite(sequence) ? sequence : 0
    }
  }
}

/** Build the op 1 heartbeat payload (`d` is the last dispatch sequence or null). */
export function buildHeartbeatPayload(seq) {
  const value = seq === null || seq === undefined || seq === '' ? null : Number(seq)
  return { op: 1, d: Number.isFinite(value) ? value : null }
}

/** Deterministic exponential backoff: base * 2^(attempt-1), capped at max. */
export function nextBackoffMs(attempt, { baseDelayMs = 1000, maxDelayMs = 60000 } = {}) {
  const base = Math.max(1, Number(baseDelayMs) || 1000)
  const max = Math.max(base, Number(maxDelayMs) || 60000)
  const step = Math.max(1, Math.floor(Number(attempt) || 1))
  return Math.min(max, base * 2 ** (step - 1))
}

/**
 * Whether the previous session may be resumed after this close code.
 * Auth/session/expiry codes require a fresh Identify; transient network or
 * throttling closes keep the session and send Resume.
 */
export function isResumableCloseCode(code) {
  const value = Number(code)
  if (!Number.isFinite(value)) return false
  if (FATAL_CLOSE_CODES.has(value)) return false
  if (SESSION_LOST_CLOSE_CODES.has(value)) return false
  return true
}

export function createGateway({ api, configStore, logger, onDispatch, onStatusChange, WebSocketImpl = globalThis.WebSocket } = {}) {
  const log = logger ?? { debug() {}, info() {}, warn() {}, error() {} }

  function config() {
    try {
      return configStore?.get?.() ?? {}
    } catch {
      return {}
    }
  }

  function reconnectSettings() {
    const raw = config()?.qq?.reconnect ?? {}
    return {
      baseDelayMs: Number(raw.baseDelayMs) > 0 ? Number(raw.baseDelayMs) : 1000,
      maxDelayMs: Number(raw.maxDelayMs) > 0 ? Number(raw.maxDelayMs) : 60000,
      maxAttempts: Math.max(0, Math.floor(Number(raw.maxAttempts)) || 0)
    }
  }

  let socket = null
  let heartbeatTimer = null
  let reconnectTimer = null
  let running = false
  let stopped = false
  let state = 'idle'
  let connectedAt = null
  let lastHeartbeatAt = null
  let lastEventAt = null
  let sessionId = null
  let seq = null
  let bot = null
  let lastError = null
  let attempts = 0

  function status() {
    // `attempts` is the contract name; `reconnects` is the alias the admin UI
    // reads today, so both are exposed.
    return { state, connectedAt, lastHeartbeatAt, lastEventAt, sessionId, seq, bot, lastError, attempts, reconnects: attempts }
  }

  function publishStatus() {
    if (typeof onStatusChange !== 'function') return
    try {
      onStatusChange(status())
    } catch (error) {
      log.warn?.('onStatusChange 回调异常', { error: error?.message ?? String(error) })
    }
  }

  function transition(next, errorMessage) {
    if (errorMessage !== undefined) lastError = errorMessage
    const changed = state !== next
    state = next
    if (changed) {
      log.info?.(`QQ 网关状态：${STATUS_LABELS[next] ?? next}`, errorMessage === undefined ? undefined : { error: errorMessage })
    }
    publishStatus()
  }

  function clearHeartbeat() {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  function clearReconnect() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function sendPayload(payload, targetSocket = socket) {
    if (!targetSocket) return false
    try {
      targetSocket.send(JSON.stringify(payload))
      return true
    } catch (error) {
      log.warn?.('QQ 网关发送消息失败', { error: error?.message ?? String(error) })
      return false
    }
  }

  function startHeartbeat(intervalMs) {
    clearHeartbeat()
    const interval = Number(intervalMs)
    const heartbeatEveryMs = Number.isFinite(interval) && interval >= 50 ? interval : DEFAULT_HEARTBEAT_INTERVAL_MS
    heartbeatTimer = setInterval(() => {
      try {
        if (!socket) return
        if (sendPayload(buildHeartbeatPayload(seq))) lastHeartbeatAt = Date.now()
      } catch (error) {
        log.warn?.('QQ 网关心跳异常', { error: error?.message ?? String(error) })
      }
    }, heartbeatEveryMs)
    heartbeatTimer.unref?.()
  }

  async function accessToken() {
    if (api === null || typeof api?.getToken !== 'function') throw new Error('QQ API 客户端不可用')
    const token = await api.getToken()
    const value = token?.accessToken ?? token?.access_token ?? ''
    if (typeof value !== 'string' || value === '') throw new Error('QQ access_token 无效')
    return value
  }

  async function sendIdentify() {
    const token = await accessToken()
    const qq = config()?.qq ?? {}
    sendPayload(
      buildIdentifyPayload({
        accessToken: token,
        intents: qq.intents ?? 0,
        shard: Array.isArray(qq.shard) ? qq.shard : [0, 1]
      })
    )
    log.debug?.('已发送 QQ 网关 Identify')
  }

  async function sendResume() {
    const token = await accessToken()
    sendPayload(buildResumePayload({ accessToken: token, sessionId, seq }))
    log.debug?.('已发送 QQ 网关 Resume')
  }

  async function handleHello(payload) {
    const interval = Number(payload?.d?.heartbeat_interval)
    startHeartbeat(Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_HEARTBEAT_INTERVAL_MS)
    lastHeartbeatAt = Date.now()
    if (sessionId !== null && seq !== null) await sendResume()
    else await sendIdentify()
  }

  function handleDispatchPayload(payload) {
    lastEventAt = Date.now()
    const sequence = Number(payload?.s)
    if (Number.isFinite(sequence)) seq = sequence
    const t = String(payload?.t ?? '')
    const d = payload?.d ?? {}

    if (t === 'READY') {
      if (typeof d?.session_id === 'string' && d.session_id !== '') sessionId = d.session_id
      if (d?.user !== undefined) bot = d.user
      else if (d?.bot !== undefined) bot = d.bot
      connectedAt = Date.now()
      attempts = 0
      lastError = null
      transition('online')
    } else if (t === 'RESUMED') {
      if (connectedAt === null) connectedAt = Date.now()
      attempts = 0
      lastError = null
      transition('online')
    }

    const dispatch = { t, d, s: payload?.s, id: payload?.id }
    try {
      const result = typeof onDispatch === 'function' ? onDispatch(dispatch) : undefined
      if (result !== null && typeof result?.then === 'function') {
        result.catch((error) => log.error?.('onDispatch 异步回调异常', { error: error?.message ?? String(error) }))
      }
    } catch (error) {
      log.error?.('onDispatch 回调异常', { error: error?.message ?? String(error) })
    }
  }

  /** Forget the current socket without triggering its close handler. */
  function dropSocket() {
    const current = socket
    socket = null
    if (!current) return
    try {
      current.close?.(1000, 'reconnect')
    } catch {
      // ignore close failures
    }
  }

  function beginReconnect({ clearSession = false, immediate = false } = {}) {
    if (stopped || !running) return
    clearHeartbeat()
    clearReconnect()
    if (clearSession) {
      sessionId = null
      seq = null
    }
    connectedAt = null
    attempts += 1
    const settings = reconnectSettings()
    if (settings.maxAttempts > 0 && attempts > settings.maxAttempts) {
      running = false
      transition('offline', lastError ?? `重连次数超过上限（${settings.maxAttempts}）`)
      return
    }
    transition('reconnecting', lastError ?? undefined)
    const delay = immediate ? 0 : nextBackoffMs(attempts, settings)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (stopped || !running) return
      connectOnce().catch((error) => log.error?.('QQ 网关重连异常', { error: error?.message ?? String(error) }))
    }, Math.max(0, delay))
    reconnectTimer.unref?.()
  }

  function handleConnectFailure(error) {
    lastError = `QQ 网关连接失败：${error?.message ?? String(error)}`
    log.warn?.('QQ 网关连接失败', { error: error?.message ?? String(error), code: error?.code })
    if (stopped || !running) return
    beginReconnect({})
  }

  async function connectOnce() {
    if (stopped || !running) return
    clearReconnect()
    transition('connecting')
    let url
    try {
      url = await api.getGatewayUrl()
    } catch (error) {
      handleConnectFailure(error)
      return
    }
    if (stopped || !running) return
    if (typeof url !== 'string' || url === '') {
      handleConnectFailure(new Error('QQ 网关地址为空'))
      return
    }
    if (typeof WebSocketImpl !== 'function') {
      handleConnectFailure(new Error('当前运行环境不支持 WebSocket'))
      return
    }
    let nextSocket = null
    try {
      nextSocket = new WebSocketImpl(url)
    } catch (error) {
      handleConnectFailure(error)
      return
    }
    if (stopped || !running) {
      try {
        nextSocket.close?.()
      } catch {
        // ignore
      }
      return
    }
    socket = nextSocket
    attachSocket(nextSocket)
  }

  function attachSocket(targetSocket) {
    const guarded = (handler) => (event) => {
      try {
        if (socket !== targetSocket) return
        const result = handler(event)
        if (result !== null && typeof result?.then === 'function') {
          result.catch((error) => log.error?.('QQ 网关事件处理异常', { error: error?.message ?? String(error) }))
        }
      } catch (error) {
        log.error?.('QQ 网关事件处理异常', { error: error?.message ?? String(error) })
      }
    }
    const register = (type, handler) => {
      const listener = guarded(handler)
      try {
        if (typeof targetSocket.addEventListener === 'function') targetSocket.addEventListener(type, listener)
        else if (typeof targetSocket.on === 'function') targetSocket.on(type, listener)
        else targetSocket[`on${type}`] = listener
      } catch (error) {
        log.warn?.('QQ 网关事件注册失败', { type, error: error?.message ?? String(error) })
      }
    }
    register('open', () => log.debug?.('QQ 网关 WebSocket 已打开，等待 Hello'))
    register('message', (event) => handleSocketMessage(event))
    register('close', (event) => handleSocketClose(event))
    register('error', (event) => handleSocketError(event))
  }

  function parsePayload(raw) {
    if (typeof raw === 'string') return JSON.parse(raw)
    if (raw instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(raw))
    if (ArrayBuffer.isView(raw)) return JSON.parse(new TextDecoder().decode(raw))
    if (raw !== null && typeof raw === 'object') return raw
    return JSON.parse(String(raw))
  }

  async function handleSocketMessage(event) {
    const raw = event !== null && typeof event === 'object' && 'data' in event ? event.data : event
    let payload
    try {
      payload = parsePayload(raw)
    } catch (error) {
      log.warn?.('QQ 网关消息解析失败', { error: error?.message ?? String(error) })
      return
    }
    if (payload === null || typeof payload !== 'object') return
    const op = Number(payload.op)
    try {
      switch (op) {
        case 10:
          await handleHello(payload)
          break
        case 11:
          lastHeartbeatAt = Date.now()
          break
        case 1:
          if (sendPayload(buildHeartbeatPayload(seq))) lastHeartbeatAt = Date.now()
          break
        case 7:
          log.info?.('QQ 网关要求立即重连')
          dropSocket()
          beginReconnect({ immediate: true })
          break
        case 9:
          log.info?.('QQ 网关会话失效，将重新鉴权连接')
          dropSocket()
          beginReconnect({ clearSession: true, immediate: true })
          break
        case 0:
          handleDispatchPayload(payload)
          break
        default:
          log.debug?.(`忽略 QQ 网关未知 op：${payload.op}`)
      }
    } catch (error) {
      log.error?.('QQ 网关消息处理失败', { error: error?.message ?? String(error), code: error?.code })
      if (socket !== null) {
        dropSocket()
        beginReconnect({})
      }
    }
  }

  function handleSocketClose(event) {
    if (socket === null) return
    socket = null
    clearHeartbeat()
    if (stopped || !running) return
    const rawCode = Number(event?.code)
    const code = Number.isFinite(rawCode) ? rawCode : undefined
    const reason = typeof event?.reason === 'string' && event.reason !== '' ? event.reason.slice(0, 200) : undefined
    lastError = `QQ 网关连接关闭${code === undefined ? '' : `（code=${code}${reason === undefined ? '' : `, ${reason}`}）`}`
    log.warn?.('QQ 网关连接关闭', { code, reason })
    if (code !== undefined && FATAL_CLOSE_CODES.has(code)) {
      running = false
      connectedAt = null
      transition('offline', lastError)
      return
    }
    beginReconnect({ clearSession: !isResumableCloseCode(code) })
  }

  function handleSocketError(event) {
    if (socket === null) return
    const message = typeof event?.message === 'string' && event.message !== '' ? event.message : event?.error?.message ?? 'WebSocket 错误'
    lastError = `QQ 网关连接错误：${String(message).slice(0, 200)}`
    log.warn?.('QQ 网关 WebSocket 错误', { error: String(message).slice(0, 200) })
    if (stopped || !running) return
    const current = socket
    socket = null
    clearHeartbeat()
    try {
      current.close?.()
    } catch {
      // ignore
    }
    beginReconnect({})
  }

  /** Connect the gateway. Idempotent while already running; never throws. */
  async function start() {
    if (running) return status()
    running = true
    stopped = false
    log.info?.('QQ 网关启动')
    try {
      await connectOnce()
    } catch (error) {
      handleConnectFailure(error)
    }
    return status()
  }

  /** Close the socket and timers. `clearSession` forces a fresh Identify. */
  async function stop({ clearSession = false } = {}) {
    stopped = true
    running = false
    clearHeartbeat()
    clearReconnect()
    const current = socket
    socket = null
    if (current) {
      try {
        current.close?.(1000, 'client stop')
      } catch {
        // ignore
      }
    }
    if (clearSession) {
      sessionId = null
      seq = null
    }
    connectedAt = null
    transition('idle')
    log.info?.('QQ 网关已停止', clearSession ? { clearSession: true } : undefined)
    return status()
  }

  /** Manual reconnect that keeps the session (used after transient failures). */
  async function reconnect() {
    log.info?.('QQ 网关手动重连')
    await stop({ clearSession: false })
    return start()
  }

  return { start, stop, reconnect, status }
}
