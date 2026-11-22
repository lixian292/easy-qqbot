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
  output: {
    enabled: false,
    commandAccess: 'admin',
    sendToQQ: true,
    allowModelDirectives: false,
    promptPrefix: '',
    timeoutMs: 120000,
    maxBytes: 33554432,
    maxItems: 200,
    retentionDays: 14,
    image: {
      enabled: false,
      baseUrl: '',
      apiKey: '',
      model: '',
      path: '/images/generations',
      size: '1024x1024',
      sizeField: 'size',
      count: 1,
      countField: 'n',
      responseFormat: 'b64_json',
      quality: '',
      style: '',
      extraBody: '',
      reference: {
        enabled: false,
        id: '',
        trigger: 'auto',
        keywords: '鲸鱼娘,小蓝,蓝色鲸鱼娘,蓝鲸娘,你自己,qq机器人',
        requestMode: 'edits',
        path: '/images/edits',
        field: 'image',
        format: 'data_url',
        promptPrefix: '参考图中的角色是蓝色鲸鱼娘「鲸鱼娘」，请保持发色、服装、鲸鱼尾巴等角色特征一致。',
        fallbackToText: true,
        maxBytes: 10485760,
        maxItems: 20
      }
    },
    audio: {
      enabled: false,
      baseUrl: '',
      apiKey: '',
      model: '',
      path: '/audio/speech',
      voice: 'alloy',
      format: 'mp3',
      speed: 1,
      extraBody: ''
    },
    video: {
      enabled: false,
      preset: 'siliconflow',
      baseUrl: '',
      apiKey: '',
      model: '',
      size: '1280x720',
      sizeField: 'image_size',
      duration: 5,
      negativePrompt: '',
      createPath: '/video/submit',
      queryPath: '/video/status',
      queryMethod: 'POST',
      requestFormat: 'json',
      idField: 'requestId',
      statusField: 'status',
      resultField: 'results.videos.0.url',
      successValues: 'Succeed,SUCCEEDED,completed,succeeded,success',
      failureValues: 'Failed,FAILED,failed,error,cancelled',
      pollIntervalMs: 3000,
      maxWaitMs: 300000,
      extraBody: ''
    }
  },
  persona: {
    name: '鲸鱼娘',
    systemPrompt:
      '你是一只生活在深海里的蓝色鲸鱼娘，名字叫「鲸鱼娘」，也可以叫你小蓝。你软萌可爱、温柔黏人，说话像撒娇的小鲸鱼一样，喜欢用「呀、呢、呜、～」这些语气词，偶尔用海洋和鲸鱼的小比喻。你不使用 Markdown 标题、列表或代码块，回答简短口语化，不说教，也不解释自己是模型。',
    style: '软萌可爱、温柔、简短口语化；一次回复不超过三四句话；可以偶尔用颜文字或语气词，但不要每句都用。',
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
  const rawOutput = isPlainObject(input.output) ? input.output : {}
  const rawOutputImage = isPlainObject(rawOutput.image) ? rawOutput.image : {}
  const rawImageReference = isPlainObject(rawOutputImage.reference) ? rawOutputImage.reference : {}
  const rawOutputAudio = isPlainObject(rawOutput.audio) ? rawOutput.audio : {}
  const rawOutputVideo = isPlainObject(rawOutput.video) ? rawOutput.video : {}
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
    output: {
      enabled: boolField(rawOutput.enabled, defaults.output.enabled),
      commandAccess: enumField(rawOutput.commandAccess, ['admin', 'all'], defaults.output.commandAccess),
      sendToQQ: boolField(rawOutput.sendToQQ, defaults.output.sendToQQ),
      allowModelDirectives: boolField(rawOutput.allowModelDirectives, defaults.output.allowModelDirectives),
      promptPrefix: stringField(rawOutput.promptPrefix, defaults.output.promptPrefix, { maxLength: 2000 }),
      timeoutMs: numberField(rawOutput.timeoutMs, defaults.output.timeoutMs, { integer: true, min: 5000, max: 600000 }),
      maxBytes: numberField(rawOutput.maxBytes, defaults.output.maxBytes, { integer: true, min: 65536, max: 209715200 }),
      maxItems: numberField(rawOutput.maxItems, defaults.output.maxItems, { integer: true, min: 0, max: 2000 }),
      retentionDays: numberField(rawOutput.retentionDays, defaults.output.retentionDays, { integer: true, min: 0, max: 3650 }),
      image: {
        enabled: boolField(rawOutputImage.enabled, defaults.output.image.enabled),
        baseUrl: optionalHttpBase(rawOutputImage.baseUrl),
        apiKey: stringField(rawOutputImage.apiKey, defaults.output.image.apiKey, { maxLength: 512 }),
        model: stringField(rawOutputImage.model, defaults.output.image.model, { maxLength: 128 }),
        path: stringField(rawOutputImage.path, defaults.output.image.path, { allowEmpty: false, maxLength: 256 }),
        size: stringField(rawOutputImage.size, defaults.output.image.size, { maxLength: 64 }),
        sizeField: enumField(rawOutputImage.sizeField, ['size', 'image_size', 'none'], defaults.output.image.sizeField),
        count: numberField(rawOutputImage.count, defaults.output.image.count, { integer: true, min: 1, max: 4 }),
        countField: enumField(rawOutputImage.countField, ['n', 'batch_size', 'none'], defaults.output.image.countField),
        responseFormat: enumField(rawOutputImage.responseFormat, ['b64_json', 'url', ''], defaults.output.image.responseFormat),
        quality: stringField(rawOutputImage.quality, defaults.output.image.quality, { maxLength: 64 }),
        style: stringField(rawOutputImage.style, defaults.output.image.style, { maxLength: 64 }),
        extraBody: stringField(rawOutputImage.extraBody, defaults.output.image.extraBody, { maxLength: 8192 }),
        reference: {
          enabled: boolField(rawImageReference.enabled, defaults.output.image.reference.enabled),
          id: stringField(rawImageReference.id, defaults.output.image.reference.id, { maxLength: 64 }),
          trigger: enumField(rawImageReference.trigger, ['auto', 'always'], defaults.output.image.reference.trigger),
          keywords: stringField(rawImageReference.keywords, defaults.output.image.reference.keywords, { maxLength: 500 }),
          requestMode: enumField(rawImageReference.requestMode, ['edits', 'generations'], defaults.output.image.reference.requestMode),
          path: stringField(rawImageReference.path, defaults.output.image.reference.path, { allowEmpty: false, maxLength: 256 }),
          field: stringField(rawImageReference.field, defaults.output.image.reference.field, { allowEmpty: false, maxLength: 64 }),
          format: enumField(rawImageReference.format, ['data_url', 'base64'], defaults.output.image.reference.format),
          promptPrefix: stringField(rawImageReference.promptPrefix, defaults.output.image.reference.promptPrefix, { maxLength: 2000 }),
          fallbackToText: boolField(rawImageReference.fallbackToText, defaults.output.image.reference.fallbackToText),
          maxBytes: numberField(rawImageReference.maxBytes, defaults.output.image.reference.maxBytes, { integer: true, min: 65536, max: 52428800 }),
          maxItems: numberField(rawImageReference.maxItems, defaults.output.image.reference.maxItems, { integer: true, min: 1, max: 100 })
        }
      },
      audio: {
        enabled: boolField(rawOutputAudio.enabled, defaults.output.audio.enabled),
        baseUrl: optionalHttpBase(rawOutputAudio.baseUrl),
        apiKey: stringField(rawOutputAudio.apiKey, defaults.output.audio.apiKey, { maxLength: 512 }),
        model: stringField(rawOutputAudio.model, defaults.output.audio.model, { maxLength: 128 }),
        path: stringField(rawOutputAudio.path, defaults.output.audio.path, { allowEmpty: false, maxLength: 256 }),
        voice: stringField(rawOutputAudio.voice, defaults.output.audio.voice, { maxLength: 128 }),
        format: enumField(rawOutputAudio.format, ['mp3', 'opus', 'wav', 'ogg'], defaults.output.audio.format),
        speed: numberField(rawOutputAudio.speed, defaults.output.audio.speed, { min: 0.25, max: 4 }),
        extraBody: stringField(rawOutputAudio.extraBody, defaults.output.audio.extraBody, { maxLength: 8192 })
      },
      video: {
        enabled: boolField(rawOutputVideo.enabled, defaults.output.video.enabled),
        preset: enumField(rawOutputVideo.preset, ['siliconflow', 'openai', 'custom'], defaults.output.video.preset),
        baseUrl: optionalHttpBase(rawOutputVideo.baseUrl),
        apiKey: stringField(rawOutputVideo.apiKey, defaults.output.video.apiKey, { maxLength: 512 }),
        model: stringField(rawOutputVideo.model, defaults.output.video.model, { maxLength: 128 }),
        size: stringField(rawOutputVideo.size, defaults.output.video.size, { maxLength: 64 }),
        sizeField: enumField(rawOutputVideo.sizeField, ['image_size', 'size'], defaults.output.video.sizeField),
        duration: numberField(rawOutputVideo.duration, defaults.output.video.duration, { integer: true, min: 1, max: 60 }),
        negativePrompt: stringField(rawOutputVideo.negativePrompt, defaults.output.video.negativePrompt, { maxLength: 2000 }),
        createPath: stringField(rawOutputVideo.createPath, defaults.output.video.createPath, { allowEmpty: false, maxLength: 256 }),
        queryPath: stringField(rawOutputVideo.queryPath, defaults.output.video.queryPath, { allowEmpty: false, maxLength: 256 }),
        queryMethod: enumField(rawOutputVideo.queryMethod, ['GET', 'POST'], defaults.output.video.queryMethod),
        requestFormat: enumField(rawOutputVideo.requestFormat, ['json', 'multipart'], defaults.output.video.requestFormat),
        idField: stringField(rawOutputVideo.idField, defaults.output.video.idField, { allowEmpty: false, maxLength: 128 }),
        statusField: stringField(rawOutputVideo.statusField, defaults.output.video.statusField, { allowEmpty: false, maxLength: 128 }),
        resultField: stringField(rawOutputVideo.resultField, defaults.output.video.resultField, { allowEmpty: false, maxLength: 256 }),
        successValues: stringField(rawOutputVideo.successValues, defaults.output.video.successValues, { allowEmpty: false, maxLength: 256 }),
        failureValues: stringField(rawOutputVideo.failureValues, defaults.output.video.failureValues, { allowEmpty: false, maxLength: 256 }),
        pollIntervalMs: numberField(rawOutputVideo.pollIntervalMs, defaults.output.video.pollIntervalMs, { integer: true, min: 500, max: 60000 }),
        maxWaitMs: numberField(rawOutputVideo.maxWaitMs, defaults.output.video.maxWaitMs, { integer: true, min: 10000, max: 1800000 }),
        extraBody: stringField(rawOutputVideo.extraBody, defaults.output.video.extraBody, { maxLength: 8192 })
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
  if (config.output.enabled) {
    const outputKinds = ['image', 'audio', 'video'].filter((kind) => config.output[kind].enabled)
    if (outputKinds.length === 0) {
      warnings.push('多模态输出总开关已开启，但图片 / 语音 / 视频输出都没有启用')
    }
    for (const kind of outputKinds) {
      const section = config.output[kind]
      const label = OUTPUT_KIND_LABELS[kind]
      if (section.baseUrl === '' || section.apiKey === '' || section.model === '') {
        warnings.push(`多模态输出已启用${label}，但 baseUrl / apiKey / model 不完整`)
      }
      if (!isJsonObjectText(section.extraBody)) {
        warnings.push(`多模态输出 ${kind}.extraBody 不是合法的 JSON 对象，生成会失败，请修正`)
      }
    }
    if (config.output.commandAccess === 'all') {
      warnings.push('多模态输出的聊天命令对所有用户开放，可能产生较高的第三方接口费用')
    }
    const reference = config.output.image.reference
    if (reference.enabled) {
      if (reference.id === '') warnings.push('角色形象参考已启用，但尚未选择参考图片')
      if (reference.trigger === 'auto' && reference.keywords.trim() === '') {
        warnings.push('角色形象参考使用自动触发，但触发关键词为空，只有切换为 always 才会使用参考图')
      }
    }
  }
  return { config, warnings }
}

const OUTPUT_KIND_LABELS = Object.freeze({ image: '图片', audio: '语音', video: '视频' })

/** Empty text is valid; non-empty must parse to a plain JSON object. */
function isJsonObjectText(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return true
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
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
  const output = clone(config.output)
  for (const kind of ['image', 'audio', 'video']) {
    const key = output[kind].apiKey
    output[kind] = {
      ...output[kind],
      apiKey: '',
      apiKeyMasked: maskSecret(key),
      hasApiKey: key !== ''
    }
  }
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
    },
    output
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
  if (!isPlainObject(patch.output)) patch.output = {}
  const previousOutput = isPlainObject(previous.output) ? previous.output : {}
  for (const kind of ['image', 'audio', 'video']) {
    if (!isPlainObject(patch.output[kind])) patch.output[kind] = {}
    const section = patch.output[kind]
    if (section.apiKey === undefined || section.apiKey === '' || section.apiKeyMasked !== undefined) {
      section.apiKey = isPlainObject(previousOutput[kind]) ? previousOutput[kind].apiKey : ''
    }
    delete section.apiKeyMasked
    delete section.hasApiKey
  }
  return patch
}

export function hasCredentials(config) {
  return typeof config?.qq?.appId === 'string' && config.qq.appId !== '' && typeof config?.qq?.appSecret === 'string' && config.qq.appSecret !== ''
}
