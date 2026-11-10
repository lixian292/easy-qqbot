/**
 * Composition root: builds every qqbot service from the shared config and
 * returns a disposable application object. `host/index.js` calls this from the
 * Cordis `apply(ctx)` hook.
 */
import { createPaths } from './paths.js'
import { loadConfig, normalizeConfig, patchConfig, publicConfig, saveConfig } from './config.js'
import { createLogger } from './util/log.js'
import { createBudgetStore } from './budget/store.js'
import { createPersonaStore } from './persona/store.js'
import { createMemoryStore } from './memory/store.js'
import { createMemoryExtractor } from './memory/extract.js'
import { createCompressor } from './memory/compress.js'
import { createLlmClient } from './brain/llm.js'
import { createMultimodalClient } from './multimodal/client.js'
import { downloadMediaBuffer } from './multimodal/download.js'
import { attachmentAsrText, classifyAttachment, mediaDownloadUrl } from './util/media.js'
import { createStickerStore } from './stickers/store.js'
import { createStickerImporter } from './stickers/importer.js'
import { createStickerSelector } from './stickers/selector.js'
import { createCommandHandler } from './brain/commands.js'
import { createChatEngine } from './brain/chat.js'
import { createQQClient } from './qq/index.js'
import { registerAdminRoutes } from './admin/routes.js'

export const PLUGIN_VERSION = '0.2.0'

/**
 * In-memory config controller: `loadConfig` at startup, atomic `saveConfig` for
 * the admin page, and an `onChange` fan-out so long-lived services can restart.
 */
export function createConfigManager({ paths, logger, initial, warnings = [] }) {
  let current = initial
  let lastWarnings = [...warnings]
  const listeners = new Set()

  function notify() {
    for (const listener of listeners) {
      try {
        listener(current)
      } catch (error) {
        logger?.warn?.('配置变更监听器失败', error)
      }
    }
  }

  return {
    get: () => current,
    public: () => publicConfig(current),
    warnings: () => [...lastWarnings],
    async save(patchOrFull) {
      const patch = sanitizeConfigPatch(patchOrFull)
      const { config: merged } = patchConfig(current, patch)
      const result = await saveConfig(paths, merged)
      current = result.config
      lastWarnings = result.warnings
      notify()
      return result
    },
    async reload() {
      const result = await loadConfig(paths, logger)
      current = result.config
      lastWarnings = result.warnings
      notify()
      return result
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

/** Never let an empty/masked secret field overwrite the stored secret. */
function sanitizeConfigPatch(patch) {
  if (patch === null || typeof patch !== 'object') return {}
  const out = { ...patch }
  if (out.qq !== null && typeof out.qq === 'object') {
    const qq = { ...out.qq }
    const secretMissing = qq.appSecret === undefined || qq.appSecret === ''
    delete qq.appSecretMasked
    delete qq.hasSecret
    if (secretMissing) delete qq.appSecret
    out.qq = qq
  }
  if (out.multimodal !== null && typeof out.multimodal === 'object') {
    const multimodal = { ...out.multimodal }
    const keyMissing = multimodal.apiKey === undefined || multimodal.apiKey === ''
    delete multimodal.apiKeyMasked
    delete multimodal.hasApiKey
    if (keyMissing) delete multimodal.apiKey
    out.multimodal = multimodal
  }
  return out
}

/** Serialize tasks per key (one chat at a time, but different chats run concurrently). */
export function createSerialQueue({ logger } = {}) {
  const chains = new Map()
  return {
    push(key, task) {
      const previous = chains.get(key) ?? Promise.resolve()
      const run = previous
        .then(() => task())
        .catch((error) => {
          logger?.error?.('串行任务失败', error)
        })
      chains.set(key, run)
      run.then(() => {
        if (chains.get(key) === run) chains.delete(key)
      })
      return run
    },
    async idle() {
      await Promise.allSettled([...chains.values()])
    }
  }
}

async function loadBootstrapConfig(paths, loggerHolder) {
  try {
    return await loadConfig(paths)
  } catch (error) {
    // A corrupt config must not take the whole plugin down: back it up, rebuild defaults.
    loggerHolder.warn = error
    const { config, warnings } = normalizeConfig({})
    try {
      await saveConfig(paths, { ...config, __error: undefined })
    } catch {
      // best effort
    }
    return { config, warnings: [`读取配置失败，已使用默认配置：${error instanceof Error ? error.message : String(error)}`], created: true }
  }
}

/** Resolve a Cordis service defensively: `ctx.get(name)` first, then the property. */
function resolveService(ctx, name) {
  try {
    const viaGet = ctx?.get?.(name)
    if (viaGet !== undefined && viaGet !== null) return viaGet
  } catch {
    // fall through to the property lookup
  }
  try {
    return ctx?.[name]
  } catch {
    // Cordis contexts throw on unknown properties without an inject declaration.
    return undefined
  }
}

/**
 * Build the whole plugin.
 * @param {{ctx?: object, version?: string}} options
 * @returns {Promise<object>} app with a `dispose()` method
 */
export async function createApp({ ctx, version = PLUGIN_VERSION } = {}) {
  const paths = createPaths().ensure()
  const bootstrapLogger = { warn: undefined }
  const bootstrap = await loadBootstrapConfig(paths, bootstrapLogger)

  const logger = createLogger({
    file: paths.logFile,
    ctxLogger: ctx?.logger,
    maxLines: bootstrap.config.logging.maxLines,
    debug: bootstrap.config.logging.debug,
    label: 'qqbot'
  })
  if (bootstrapLogger.warn !== undefined) logger.warn('配置读取异常', bootstrapLogger.warn)
  for (const warning of bootstrap.warnings) logger.warn(`配置警告：${warning}`)

  const configStore = createConfigManager({
    paths,
    logger,
    initial: bootstrap.config,
    warnings: bootstrap.warnings
  })

  const budgetStore = createBudgetStore({ paths, configStore, logger })
  const personaStore = createPersonaStore({ paths, configStore, logger })
  const memoryStore = createMemoryStore({ paths, configStore, logger })
  const llmService = resolveService(ctx, 'llm')
  const llmClient = createLlmClient({ ctx: { llm: llmService }, configStore, logger })
  const multimodalClient = createMultimodalClient({ configStore, logger })
  const stickerStore = createStickerStore({ paths, configStore, logger })
  const importer = createStickerImporter({ paths, configStore, stickerStore, logger })
  const stickerSelector = createStickerSelector({ stickerStore, configStore, logger })
  const compressor = createCompressor({ configStore, llmClient, memoryStore, logger })
  const extractor = createMemoryExtractor({ configStore, llmClient, memoryStore, logger })

  await Promise.allSettled([personaStore.init?.(), memoryStore.init?.(), stickerStore.init?.()])

  const chatQueue = createSerialQueue({ logger })
  const contextInfo = {
    get botName() {
      return configStore.get().persona.name
    }
  }

  const commandHandler = createCommandHandler({
    configStore,
    budgetStore,
    memoryStore,
    stickerStore,
    stickerSelector,
    logger,
    context: contextInfo
  })

  /**
   * Describe one inbound media attachment (image / audio / video) through the
   * optional multimodal recognizer. Never throws: a failure simply degrades to
   * the plain marker in the chat history. QQ voice messages may already carry
   * an ASR text, which is used as a free fallback for audio.
   */
  const describeIncomingMedia = async (attachment, inbound) => {
    const kind = classifyAttachment(attachment)
    const asrFallback = kind === 'audio' ? attachmentAsrText(attachment) : ''
    const config = configStore.get()
    const multimodal = config.multimodal
    if (multimodal?.enabled !== true) return asrFallback
    if (kind !== 'image' && kind !== 'audio' && kind !== 'video') return ''
    if (multimodal[kind]?.enabled !== true) return asrFallback
    const url = mediaDownloadUrl(attachment)
    if (url === '') return asrFallback
    try {
      let result
      if (kind === 'video' && multimodal.video?.mode === 'url') {
        // URL mode hands the signed QQ video URL to the provider, so a local
        // download is unnecessary (and may fail on short-lived URLs).
        result = await multimodalClient.describe({
          kind,
          url,
          fileName: attachment.filename,
          contentType: attachment.contentType
        })
      } else {
        const downloaded = await downloadMediaBuffer({
          url,
          contentType: attachment.contentType,
          maxBytes: Number(multimodal.maxBytes) || 16777216
        })
        result = await multimodalClient.describe({
          kind,
          buffer: downloaded.buffer,
          contentType: downloaded.contentType,
          fileName: attachment.filename,
          url
        })
      }
      return result.text !== '' ? result.text : asrFallback
    } catch (error) {
      logger.warn('入站媒体识别失败，已降级为文字占位', {
        chatId: inbound?.chatId,
        kind,
        code: error?.code,
        error: error?.message
      })
      return asrFallback
    }
  }

  let chatEngine
  const qqClient = createQQClient({
    ctx,
    configStore,
    logger,
    onInbound: (event) => {
      if (event === null || event === undefined) return
      if (event.kind === 'system') {
        logger.info(`QQ 系统事件：${event.type}`, { userId: event.data?.author?.member_openid ?? event.data?.author?.user_openid })
        return
      }
      chatQueue.push(event.chatId, () => chatEngine.handleInbound(event))
    }
  })

  chatEngine = createChatEngine({
    configStore,
    personaStore,
    memoryStore,
    budgetStore,
    llmClient,
    compressor,
    extractor,
    stickerStore,
    stickerSelector,
    commandHandler,
    qqClient,
    logger,
    describeIncomingMedia,
    captureIncomingImage: async (attachment, inbound) => {
      if (attachment === null || typeof attachment?.url !== 'string' || attachment.url === '') return undefined
      return importer.captureFromUrl({
        url: attachment.url,
        contentType: attachment.contentType,
        source: {
          chatId: inbound.chatId,
          userId: inbound.userId,
          userName: inbound.userName,
          msgId: inbound.msgId
        }
      })
    }
  })

  const app = {
    version,
    paths,
    logger,
    configStore,
    budgetStore,
    personaStore,
    memoryStore,
    llmClient,
    multimodalClient,
    stickerStore,
    importer,
    stickerSelector,
    compressor,
    extractor,
    commandHandler,
    chatEngine,
    chatQueue,
    qqClient
  }

  app.disposeAdmin = registerAdminRoutes({ ctx, app })
  app.disposeConfigWatch = configStore.onChange(() => {
    // Credentials / enable flags may have changed: reconnect with the new config.
    Promise.resolve()
      .then(() => qqClient.restart())
      .catch((error) => logger.warn('按新配置重启 QQ 连接失败', error))
  })

  // Start the QQ connection only when fully configured; otherwise wait in standby.
  try {
    await qqClient.start()
  } catch (error) {
    logger.error('QQ 连接启动失败', error)
  }

  let disposed = false
  app.dispose = async () => {
    if (disposed) return
    disposed = true
    try {
      app.disposeConfigWatch?.()
    } catch {}
    try {
      app.disposeAdmin?.()
    } catch {}
    try {
      await qqClient.stop()
    } catch (error) {
      logger.warn('停止 QQ 连接失败', error)
    }
    try {
      await Promise.allSettled([budgetStore.flush?.(), memoryStore.flush?.(), personaStore.flush?.(), stickerStore.flush?.()])
    } catch {}
    await logger.flush?.()
  }

  const adminPath = configStore.get().admin.path
  logger.info(`qqbot 已加载（版本 ${version}）`, {
    dataDir: paths.data,
    admin: configStore.get().admin.enabled ? `${adminPath}` : 'disabled',
    enabled: configStore.get().enabled,
    hasCredentials: configStore.get().qq.appId !== '' && configStore.get().qq.appSecret !== ''
  })

  return app
}
