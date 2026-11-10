/**
 * Plugin configuration.
 *
 * The config lives in qqbot/data/config.json so that the plugin package is the
 * single place that holds both code and data. It can be edited through the
 * admin page (http://127.0.0.1:<port>/qqbot). Unknown keys are dropped and
 * invalid values fall back to the defaults, with warnings reported to the
 * admin page.
 */
import { readJson, writeJsonAtomic } from './util/fsx.js'
import { maskSecret } from './util/text.js'

export const CONFIG_VERSION = 1

export const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  enabled: true,
  qq: {
    appId: '',
    appSecret: '',
    apiBase: 'https://api.bot.qq.com',
    tokenPath: '/app/getAppAccessToken',
    gatewayPath: '/gateway',
    intents: 33554432, // GROUP_AND_C2C_EVENT (1 << 25)
    shard: [0, 1],
    textChunkSize: 800,
    reconnect: {
      baseDelayMs: 1000,
      maxDelayMs: 60000,
      maxAttempts: 0
    },
    reply: {
      c2cWindowMs: 3600000,
      groupWindowMs: 300000,
      c2cMaxReplies: 4,
      groupMaxReplies: 5
    }
  },
  llm: {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    temperature: 0.8,
    maxTokens: 800,
    timeoutMs: 120000
  },
  multimodal: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    prompt: '请用中文简短描述这张图片/这段音视频的内容（1-2 句，最多 80 字）；如果是表情包/梗图，请说明画面、文字和表达的情绪。',
    timeoutMs: 60000,
    maxBytes: 16777216,
    ffmpegPath: 'ffmpeg',
    image: { enabled: true, model: '' },
    audio: { enabled: false, model: '', mode: 'transcribe' },
    video: { enabled: false, model: '', mode: 'frames', frameCount: 4, frameIntervalSec: 1 }
  },
  persona: {
    name: '小Q',
    systemPrompt:
      '你是 QQ 上的聊天机器人「小Q」。你友好、自然、有分寸，像群里的一个普通朋友一样聊天。你不使用 Markdown 标题、列表或代码块，回答简洁口语化，避免说教和长篇大论。',
    style: '自然、简短、口语化；一次回复不超过三四句话；除非对方明确要求，否则不要罗列要点。',
    replyMaxChars: 800,
    stickerChance: 0.35,
    memoryEnabled: true,
    compressEnabled: true,
    maxHistoryMessages: 40
  },
  budget: {
    enabled: true,
    dailyTokens: 200000,
    monthlyTokens: 3000000,
    perChatDailyTokens: 50000,
    dailyCalls: 1000,
    priceInPerMillion: 0,
    priceOutPerMillion: 0,
    currency: 'CNY',
    blockMessage: '今天的聊天额度已经用完啦，明天再来找我吧～',
    blockCooldownMs: 3600000
  },
  memory: {
    maxFacts: 12,
    extractEveryUserMessages: 8,
    historyLimit: 40,
    compressTriggerTokens: 8000,
    keepRecentMessages: 12,
    summaryMaxChars: 1200
  },
  stickers: {
    enabled: true,
    libraryOnly: true,
    captureIncoming: true,
    maxImageBytes: 5242880,
    replyChance: 0.35,
    maxCatalogTags: 40
  },
  commands: {
    enabled: true,
    prefix: '#',
    adminOpenids: [],
    allowGroupOwner: true
  },
  admin: {
    enabled: true,
    path: '/qqbot',
    pageSize: 60
  },
  logging: {
    maxLines: 500,
    debug: false
  }
})

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return clone(base)
  const out = clone(base)
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value)
    else if (Array.isArray(value)) out[key] = value.map((item) => (isPlainObject(item) ? clone(item) : item))
    else out[key] = value
  }
  return out
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = clone(item)
    return out
  }
  return value
}

function stringField(raw, fallback, { allowEmpty = true, maxLength = 8192 } = {}) {
  if (typeof raw !== 'string') return fallback
  const value = raw.trim().slice(0, maxLength)
  if (!allowEmpty && value === '') return fallback
  return value
}

function numberField(raw, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return fallback
  const clamped = Math.min(max, Math.max(min, integer ? Math.round(value) : value))
  return clamped
}

function boolField(raw, fallback) {
  return typeof raw === 'boolean' ? raw : fallback
}

function enumField(raw, allowed, fallback) {
  return typeof raw === 'string' && allowed.includes(raw) ? raw : fallback
}

function stringArray(raw, fallback, { maxItems = 50, maxLength = 64 } = {}) {
  if (!Array.isArray(raw)) return clone(fallback)
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = item.trim().slice(0, maxLength)
    if (value !== '' && !out.includes(value)) out.push(value)
    if (out.length >= maxItems) break
  }
  return out
}

function validHttpBase(raw, fallback) {
  const value = stringField(raw, fallback, { allowEmpty: false, maxLength: 256 })
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback
    return value.replace(/\/+$/, '')
  } catch {
    return fallback
  }
}

/** Optional HTTP base URL: empty means "not configured", invalid values are dropped. */
function optionalHttpBase(raw) {
  const value = stringField(raw, '', { maxLength: 256 })
  if (value === '') return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    return value.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

/**
 * Normalize arbitrary persisted config into a complete, typed config object.
 * @returns {{ config: object, warnings: string[] }}
 */
export function normalizeConfig(raw) {
  const warnings = []
  const input = isPlainObject(raw) ? raw : {}
  if (!isPlainObject(raw)) warnings.push('config 不是 JSON 对象，已使用默认配置')

  const defaults = DEFAULT_CONFIG
  const qq = isPlainObject(input.qq) ? input.qq : {}
  const llm = isPlainObject(input.llm) ? input.llm : {}
  const vision = isPlainObject(input.vision) ? input.vision : {}
  const rawMultimodal = isPlainObject(input.multimodal) ? input.multimodal : {}
  const rawImage = isPlainObject(rawMultimodal.image) ? rawMultimodal.image : {}
  const rawAudio = isPlainObject(rawMultimodal.audio) ? rawMultimodal.audio : {}
  const rawVideo = isPlainObject(rawMultimodal.video) ? rawMultimodal.video : {}
  const hasLegacyVision = isPlainObject(input.vision)
  const pick = (key, fallback) => (rawMultimodal[key] !== undefined ? rawMultimodal[key] : hasLegacyVision ? vision[key] : fallback)
  const persona = isPlainObject(input.persona) ? input.persona : {}
  const budget = isPlainObject(input.budget) ? input.budget : {}
  const memory = isPlainObject(input.memory) ? input.memory : {}
  const stickers = isPlainObject(input.stickers) ? input.stickers : {}
  const commands = isPlainObject(input.commands) ? input.commands : {}
  const admin = isPlainObject(input.admin) ? input.admin : {}
  const logging = isPlainObject(input.logging) ? input.logging : {}
  const reconnect = isPlainObject(qq.reconnect) ? qq.reconnect : {}
  const reply = isPlainObject(qq.reply) ? qq.reply : {}

  const shard = Array.isArray(qq.shard) && qq.shard.length === 2 ? qq.shard.map((item) => numberField(item, 0, { integer: true, min: 0, max: 1024 })) : clone(defaults.qq.shard)
  if (shard[1] < 1) shard[1] = 1
  if (shard[0] >= shard[1]) shard[0] = 0

  const config = {
    version: CONFIG_VERSION,
    enabled: boolField(input.enabled, defaults.enabled),
    qq: {
      appId: stringField(qq.appId, defaults.qq.appId, { maxLength: 64 }),
      appSecret: stringField(qq.appSecret, defaults.qq.appSecret, { maxLength: 256 }),
      apiBase: validHttpBase(qq.apiBase, defaults.qq.apiBase),
      tokenPath: stringField(qq.tokenPath, defaults.qq.tokenPath, { allowEmpty: false, maxLength: 128 }),
      gatewayPath: stringField(qq.gatewayPath, defaults.qq.gatewayPath, { allowEmpty: false, maxLength: 128 }),
      intents: numberField(qq.intents, defaults.qq.intents, { integer: true, min: 0, max: 2 ** 31 - 1 }),
      shard,
      textChunkSize: numberField(qq.textChunkSize, defaults.qq.textChunkSize, { integer: true, min: 100, max: 4000 }),
      reconnect: {
        baseDelayMs: numberField(reconnect.baseDelayMs, defaults.qq.reconnect.baseDelayMs, { integer: true, min: 200, max: 60000 }),
        maxDelayMs: numberField(reconnect.maxDelayMs, defaults.qq.reconnect.maxDelayMs, { integer: true, min: 1000, max: 600000 }),
        maxAttempts: numberField(reconnect.maxAttempts, defaults.qq.reconnect.maxAttempts, { integer: true, min: 0, max: 1000 })
      },
      reply: {
        c2cWindowMs: numberField(reply.c2cWindowMs, defaults.qq.reply.c2cWindowMs, { integer: true, min: 1000, max: 86400000 }),
        groupWindowMs: numberField(reply.groupWindowMs, defaults.qq.reply.groupWindowMs, { integer: true, min: 1000, max: 86400000 }),
        c2cMaxReplies: numberField(reply.c2cMaxReplies, defaults.qq.reply.c2cMaxReplies, { integer: true, min: 1, max: 100 }),
        groupMaxReplies: numberField(reply.groupMaxReplies, defaults.qq.reply.groupMaxReplies, { integer: true, min: 1, max: 100 })
      }
    },
    llm: {
      provider: stringField(llm.provider, defaults.llm.provider, { allowEmpty: false, maxLength: 128 }),
      model: stringField(llm.model, defaults.llm.model, { allowEmpty: false, maxLength: 128 }),
      temperature: numberField(llm.temperature, defaults.llm.temperature, { min: 0, max: 2 }),
      maxTokens: numberField(llm.maxTokens, defaults.llm.maxTokens, { integer: true, min: 64, max: 32768 }),
      timeoutMs: numberField(llm.timeoutMs, defaults.llm.timeoutMs, { integer: true, min: 5000, max: 600000 })
    },
    multimodal: {
      enabled: boolField(pick('enabled'), defaults.multimodal.enabled),
      baseUrl: optionalHttpBase(pick('baseUrl')),
      apiKey: stringField(pick('apiKey'), defaults.multimodal.apiKey, { maxLength: 512 }),
      prompt: stringField(pick('prompt'), defaults.multimodal.prompt, { allowEmpty: false, maxLength: 2000 }),
      timeoutMs: numberField(pick('timeoutMs'), defaults.multimodal.timeoutMs, { integer: true, min: 5000, max: 300000 }),
      maxBytes: numberField(
        rawMultimodal.maxBytes !== undefined ? rawMultimodal.maxBytes : vision.maxImageBytes,
        defaults.multimodal.maxBytes,
        { integer: true, min: 65536, max: 20971520 }
      ),
      ffmpegPath: stringField(rawMultimodal.ffmpegPath, defaults.multimodal.ffmpegPath, { allowEmpty: false, maxLength: 512 }),
      image: {
        enabled: boolField(rawImage.enabled, defaults.multimodal.image.enabled),
        model: stringField(rawImage.model !== undefined ? rawImage.model : vision.model, defaults.multimodal.image.model, { maxLength: 128 })
      },
      audio: {
        enabled: boolField(rawAudio.enabled, defaults.multimodal.audio.enabled),
        model: stringField(rawAudio.model, defaults.multimodal.audio.model, { maxLength: 128 }),
        mode: enumField(rawAudio.mode, ['transcribe', 'chat'], defaults.multimodal.audio.mode)
      },
      video: {
        enabled: boolField(rawVideo.enabled, defaults.multimodal.video.enabled),
        model: stringField(rawVideo.model, defaults.multimodal.video.model, { maxLength: 128 }),
        mode: enumField(rawVideo.mode, ['frames', 'url'], defaults.multimodal.video.mode),
        frameCount: numberField(rawVideo.frameCount, defaults.multimodal.video.frameCount, { integer: true, min: 1, max: 16 }),
        frameIntervalSec: numberField(rawVideo.frameIntervalSec, defaults.multimodal.video.frameIntervalSec, { min: 0.1, max: 60 })
      }
    },
    persona: {
      name: stringField(persona.name, defaults.persona.name, { allowEmpty: false, maxLength: 32 }),
      systemPrompt: stringField(persona.systemPrompt, defaults.persona.systemPrompt, { allowEmpty: false, maxLength: 8192 }),
      style: stringField(persona.style, defaults.persona.style, { maxLength: 4096 }),
      replyMaxChars: numberField(persona.replyMaxChars, defaults.persona.replyMaxChars, { integer: true, min: 100, max: 4000 }),
      stickerChance: numberField(persona.stickerChance, defaults.persona.stickerChance, { min: 0, max: 1 }),
      memoryEnabled: boolField(persona.memoryEnabled, defaults.persona.memoryEnabled),
      compressEnabled: boolField(persona.compressEnabled, defaults.persona.compressEnabled),
      maxHistoryMessages: numberField(persona.maxHistoryMessages, defaults.persona.maxHistoryMessages, { integer: true, min: 2, max: 200 })
    },
    budget: {
      enabled: boolField(budget.enabled, defaults.budget.enabled),
      dailyTokens: numberField(budget.dailyTokens, defaults.budget.dailyTokens, { integer: true, min: 0, max: 1e12 }),
      monthlyTokens: numberField(budget.monthlyTokens, defaults.budget.monthlyTokens, { integer: true, min: 0, max: 1e13 }),
      perChatDailyTokens: numberField(budget.perChatDailyTokens, defaults.budget.perChatDailyTokens, { integer: true, min: 0, max: 1e12 }),
      dailyCalls: numberField(budget.dailyCalls, defaults.budget.dailyCalls, { integer: true, min: 0, max: 1e9 }),
      priceInPerMillion: numberField(budget.priceInPerMillion, defaults.budget.priceInPerMillion, { min: 0, max: 1e9 }),
      priceOutPerMillion: numberField(budget.priceOutPerMillion, defaults.budget.priceOutPerMillion, { min: 0, max: 1e9 }),
      currency: stringField(budget.currency, defaults.budget.currency, { allowEmpty: false, maxLength: 8 }),
      blockMessage: stringField(budget.blockMessage, defaults.budget.blockMessage, { maxLength: 500 }),
      blockCooldownMs: numberField(budget.blockCooldownMs, defaults.budget.blockCooldownMs, { integer: true, min: 1000, max: 86400000 })
    },
    memory: {
      maxFacts: numberField(memory.maxFacts, defaults.memory.maxFacts, { integer: true, min: 0, max: 200 }),
      extractEveryUserMessages: numberField(memory.extractEveryUserMessages, defaults.memory.extractEveryUserMessages, { integer: true, min: 1, max: 1000 }),
      historyLimit: numberField(memory.historyLimit, defaults.memory.historyLimit, { integer: true, min: 2, max: 500 }),
      compressTriggerTokens: numberField(memory.compressTriggerTokens, defaults.memory.compressTriggerTokens, { integer: true, min: 500, max: 200000 }),
      keepRecentMessages: numberField(memory.keepRecentMessages, defaults.memory.keepRecentMessages, { integer: true, min: 2, max: 200 }),
      summaryMaxChars: numberField(memory.summaryMaxChars, defaults.memory.summaryMaxChars, { integer: true, min: 200, max: 8000 })
    },
    stickers: {
      enabled: boolField(stickers.enabled, defaults.stickers.enabled),
      libraryOnly: boolField(stickers.libraryOnly, defaults.stickers.libraryOnly),
      captureIncoming: boolField(stickers.captureIncoming, defaults.stickers.captureIncoming),
      maxImageBytes: numberField(stickers.maxImageBytes, defaults.stickers.maxImageBytes, { integer: true, min: 65536, max: 20971520 }),
      replyChance: numberField(stickers.replyChance, defaults.stickers.replyChance, { min: 0, max: 1 }),
      maxCatalogTags: numberField(stickers.maxCatalogTags, defaults.stickers.maxCatalogTags, { integer: true, min: 4, max: 200 })
    },
    commands: {
      enabled: boolField(commands.enabled, defaults.commands.enabled),
      prefix: stringField(commands.prefix, defaults.commands.prefix, { allowEmpty: false, maxLength: 8 }),
      adminOpenids: stringArray(commands.adminOpenids, defaults.commands.adminOpenids, { maxItems: 50, maxLength: 128 }),
      allowGroupOwner: boolField(commands.allowGroupOwner, defaults.commands.allowGroupOwner)
    },
    admin: {
      enabled: boolField(admin.enabled, defaults.admin.enabled),
      path: normalizeAdminPath(admin.path, defaults.admin.path),
      pageSize: numberField(admin.pageSize, defaults.admin.pageSize, { integer: true, min: 10, max: 500 })
    },
    logging: {
      maxLines: numberField(logging.maxLines, defaults.logging.maxLines, { integer: true, min: 50, max: 5000 }),
      debug: boolField(logging.debug, defaults.logging.debug)
    }
  }

  if (config.qq.appId === '' || config.qq.appSecret === '') {
    warnings.push('qq.appId / qq.appSecret 尚未填写，插件会以「待配置」状态启动，不会连接 QQ')
  }
  if (config.multimodal.enabled) {
    if (config.multimodal.baseUrl === '' || config.multimodal.apiKey === '') {
      warnings.push('multimodal.enabled 已开启，但 baseUrl / apiKey 不完整；多模态识别会被跳过')
    }
    if (config.multimodal.image.enabled && config.multimodal.image.model === '') {
      warnings.push('多模态识别已启用图片，但 image.model 为空')
    }
    if (config.multimodal.audio.enabled && config.multimodal.audio.model === '') {
      warnings.push('多模态识别已启用音频，但 audio.model 为空')
    }
    if (config.multimodal.video.enabled && config.multimodal.video.model === '') {
      warnings.push('多模态识别已启用视频，但 video.model 为空')
    }
  }
  return { config, warnings }
}

function normalizeAdminPath(raw, fallback) {
  const value = stringField(raw, fallback, { allowEmpty: false, maxLength: 64 })
  if (!value.startsWith('/')) return fallback
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(value)) return fallback
  return value.replace(/\/+$/, '') || fallback
}

/** Merge a partial patch into an existing config and normalize it. */
export function patchConfig(current, patch) {
  const merged = deepMerge(isPlainObject(current) ? current : DEFAULT_CONFIG, isPlainObject(patch) ? patch : {})
  return normalizeConfig(merged)
}

/** Load the config file; create it from defaults when missing. */
export async function loadConfig(paths, logger) {
  const raw = await readJson(paths.configFile, undefined)
  if (raw === undefined) {
    const { config, warnings } = normalizeConfig({})
    await writeJsonAtomic(paths.configFile, config)
    logger?.info?.('config.json 不存在，已写入默认配置', { file: paths.configFile })
    return { config, warnings, created: true }
  }
  const { config, warnings } = normalizeConfig(raw)
  for (const warning of warnings) logger?.warn?.(`配置警告：${warning}`)
  return { config, warnings, created: false }
}

/** Persist a complete config (normalized first) and return what was written. */
export async function saveConfig(paths, rawConfig) {
  const { config, warnings } = normalizeConfig(rawConfig)
  await writeJsonAtomic(paths.configFile, config)
  return { config, warnings }
}

/** Config shape that is safe to ship to the admin page. */
export function publicConfig(config) {
  return {
    ...clone(config),
    qq: {
      ...clone(config.qq),
      appSecret: '',
      appSecretMasked: maskSecret(config.qq.appSecret),
      hasSecret: config.qq.appSecret !== ''
    },
    multimodal: {
      ...clone(config.multimodal),
      apiKey: '',
      apiKeyMasked: maskSecret(config.multimodal.apiKey),
      hasApiKey: config.multimodal.apiKey !== ''
    }
  }
}

/** Apply a masked/blank secret from the admin page without wiping the stored one. */
export function preserveSecret(next, previous) {
  const patch = clone(next)
  if (!isPlainObject(patch.qq)) patch.qq = {}
  if (patch.qq.appSecret === '' || patch.qq.appSecretMasked !== undefined) {
    patch.qq.appSecret = previous.qq.appSecret
  }
  delete patch.qq.appSecretMasked
  delete patch.qq.hasSecret
  return patch
}

export function hasCredentials(config) {
  return typeof config?.qq?.appId === 'string' && config.qq.appId !== '' && typeof config?.qq?.appSecret === 'string' && config.qq.appSecret !== ''
}
