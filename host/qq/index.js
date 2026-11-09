/**
 * QQ client facade: glues the REST api, outbound sender and WebSocket gateway
 * together and exposes the surface used by `host/app.js` and the admin page.
 *
 * When the plugin is disabled or credentials are missing the client stays in
 * `standby` instead of throwing: the plugin must always be able to boot.
 */
import { hasCredentials } from '../config.js'
import { createQQApi } from './api.js'
import { createEventDedupe, normalizeDispatch } from './inbound.js'
import { createSender } from './outbound.js'
import { createGateway } from './gateway.js'

const MESSAGE_EVENT_TYPES = new Set(['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'])

function emptyGatewayStatus() {
  return {
    state: 'idle',
    connectedAt: null,
    lastHeartbeatAt: null,
    lastEventAt: null,
    sessionId: null,
    seq: null,
    bot: null,
    lastError: null,
    attempts: 0,
    reconnects: 0
  }
}

/**
 * @param {object} options
 * @param {object} [options.ctx] DSH plugin context (unused today, kept for parity)
 * @param {{ get(): object, onChange?(fn: Function): Function }} options.configStore
 * @param {object} [options.logger]
 * @param {(event: object) => void} [options.onInbound] called with normalized events
 * @param {typeof fetch} [options.fetchImpl] test seam
 * @param {Function} [options.WebSocketImpl] test seam / custom WebSocket
 */
export function createQQClient({ ctx, configStore, logger, onInbound, fetchImpl, WebSocketImpl } = {}) {
  if (configStore === null || typeof configStore !== 'object' || typeof configStore.get !== 'function') {
    throw new Error('createQQClient 需要 configStore')
  }
  const log = logger ?? { debug() {}, info() {}, warn() {}, error() {}, recent: () => [] }
  // Optional test seams. Never probe arbitrary properties on the Cordis context:
  // without an `inject` declaration such property reads throw.
  const injectedFetch = typeof fetchImpl === 'function' ? fetchImpl : undefined
  const injectedWebSocket = typeof WebSocketImpl === 'function' ? WebSocketImpl : globalThis.WebSocket

  let api = null
  let sender = null
  let gateway = null
  let dedupe = createEventDedupe({ maxSize: 1000 })
  let sent = 0
  let received = 0
  let lastInboundAt = null

  function config() {
    try {
      return configStore.get() ?? {}
    } catch {
      return {}
    }
  }

  function evaluate() {
    const current = config()
    return { enabled: current?.enabled !== false, hasCredentials: hasCredentials(current) }
  }

  function status() {
    const { enabled, hasCredentials: credentialsPresent } = evaluate()
    const gatewayStatus = gateway !== null && typeof gateway.status === 'function' ? gateway.status() : emptyGatewayStatus()
    const standby = !enabled || !credentialsPresent
    return {
      ...gatewayStatus,
      state: standby ? 'standby' : gatewayStatus.state,
      enabled,
      hasCredentials: credentialsPresent,
      sent,
      received,
      lastInboundAt,
      bot: gatewayStatus.bot ?? null
    }
  }

  function notifyInbound(normalized) {
    received += 1
    lastInboundAt = Date.now()
    if (typeof onInbound !== 'function') return
    try {
      const result = onInbound(normalized)
      if (result !== null && typeof result?.then === 'function') {
        result.catch((error) => log.error?.('处理入站 QQ 事件失败', { error: error?.message ?? String(error) }))
      }
    } catch (error) {
      log.error?.('处理入站 QQ 事件失败', { error: error?.message ?? String(error) })
    }
  }

  function handleDispatch(dispatch) {
    try {
      const type = String(dispatch?.t ?? '')
      if (type === '') return
      const data = dispatch?.d
      if (MESSAGE_EVENT_TYPES.has(type) && data !== null && typeof data === 'object') {
        const eventKey = typeof dispatch.id === 'string' && dispatch.id !== '' ? `event:${type}:${dispatch.id}` : ''
        const msgId = typeof data.id === 'string' && data.id !== '' ? data.id : ''
        let duplicate = false
        if (eventKey !== '' && dedupe.seen(eventKey)) duplicate = true
        if (!duplicate && msgId !== '' && dedupe.seen(`msg:${type}:${msgId}`)) duplicate = true
        if (duplicate) {
          log.debug?.('忽略重复的 QQ 事件', { type, id: msgId !== '' ? msgId : dispatch.id })
          return
        }
      }
      const normalized = normalizeDispatch(type, data, { id: dispatch?.id, s: dispatch?.s })
      if (normalized === null) return
      notifyInbound(normalized)
    } catch (error) {
      log.error?.('处理 QQ 网关事件失败', { error: error?.message ?? String(error) })
    }
  }

  function ensureRuntime() {
    if (api === null) api = createQQApi({ configStore, logger: log, fetchImpl: injectedFetch })
    if (sender === null) sender = createSender({ api, configStore, logger: log })
    if (gateway === null) {
      gateway = createGateway({
        api,
        configStore,
        logger: log,
        onDispatch: handleDispatch,
        onStatusChange: (next) => log.debug?.('QQ 网关状态变化', { state: next?.state }),
        WebSocketImpl: injectedWebSocket
      })
    }
  }

  async function start() {
    const { enabled, hasCredentials: credentialsPresent } = evaluate()
    if (!enabled) {
      log.info?.('QQ 接入未启用（config.enabled=false），保持待命状态')
      return status()
    }
    if (!credentialsPresent) {
      log.warn?.('QQ AppID / AppSecret 尚未配置，QQ 接入保持待命状态')
      return status()
    }
    if (gateway === null) ensureRuntime()
    try {
      await gateway.start()
    } catch (error) {
      log.error?.('QQ 网关启动失败', { error: error?.message ?? String(error), code: error?.code })
    }
    log.info?.('QQ 接入已启动')
    return status()
  }

  async function stop() {
    if (gateway !== null) {
      try {
        await gateway.stop({ clearSession: true })
      } catch (error) {
        log.warn?.('停止 QQ 网关失败', { error: error?.message ?? String(error) })
      }
    }
    if (sender !== null) {
      try {
        sender.clearCache?.()
      } catch (error) {
        log.warn?.('清理 QQ 发送缓存失败', { error: error?.message ?? String(error) })
      }
    }
    log.info?.('QQ 接入已停止')
    return status()
  }

  async function restart() {
    log.info?.('QQ 接入重启中')
    await stop()
    api = null
    sender = null
    gateway = null
    dedupe = createEventDedupe({ maxSize: 1000 })
    return start()
  }

  function connectedSender() {
    if (gateway === null || sender === null) throw new Error('QQ bot is not connected')
    if (gateway.status().state !== 'online') throw new Error('QQ bot is not connected')
    return sender
  }

  async function sendText(chat, text, options = {}) {
    const activeSender = connectedSender()
    const result = await activeSender.sendText(chat, text, options)
    sent += Array.isArray(result?.ids) ? result.ids.length : 0
    return result
  }

  async function sendImage(chat, media, options = {}) {
    const activeSender = connectedSender()
    const result = await activeSender.sendImage(chat, media, options)
    sent += 1
    return result
  }

  async function sendSticker(chat, sticker, options = {}) {
    const activeSender = connectedSender()
    const result = await activeSender.sendSticker(chat, sticker, options)
    sent += 1
    return result
  }

  async function sendTyping(chat) {
    if (gateway === null || sender === null || gateway.status().state !== 'online') return { ok: false, skipped: true }
    return sender.sendTyping(chat)
  }

  /** Credential self-check for the admin page. Never returns the token itself. */
  async function testAuth() {
    const { hasCredentials: credentialsPresent } = evaluate()
    if (!credentialsPresent) return { ok: false, error: '尚未配置 QQ AppID / AppSecret' }
    const probeApi = api ?? createQQApi({ configStore, logger: log, fetchImpl: injectedFetch })
    try {
      const token = await probeApi.getToken({ force: true })
      const gatewayUrl = await probeApi.getGatewayUrl()
      const bot = await probeApi.getBotMe()
      const result = { ok: true, tokenExpiresIn: Number(token?.expiresIn) || 0, gatewayUrl }
      if (bot !== null && bot !== undefined) result.bot = bot
      return result
    } catch (error) {
      log.warn?.('QQ 鉴权自检失败', { code: error?.code, error: error?.message })
      return { ok: false, error: error?.message ?? '未知错误', code: error?.code }
    }
  }

  return { start, stop, restart, status, sendText, sendImage, sendSticker, sendTyping, testAuth }
}
