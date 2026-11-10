/** Lead-owned unit tests: config normalization, shared text helpers and paths. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_CONFIG, normalizeConfig, patchConfig, publicConfig, hasCredentials } from '../host/config.js'
import { createPaths } from '../host/paths.js'
import {
  chunkText,
  cleanQqText,
  describeImageMarker,
  estimateTokens,
  maskSecret,
  normalizeTags,
  parseCommand,
  parseStickerDirectives,
  stripMarkdown
} from '../host/util/text.js'
import { readJson, writeJsonAtomic } from '../host/util/fsx.js'

test('normalizeConfig fills defaults and keeps valid overrides', () => {
  const { config, warnings } = normalizeConfig({ qq: { appId: '123', appSecret: 'secret' }, budget: { dailyTokens: 5000 } })
  assert.equal(config.qq.appId, '123')
  assert.equal(config.budget.dailyTokens, 5000)
  assert.equal(config.persona.name, DEFAULT_CONFIG.persona.name)
  assert.equal(warnings.length, 0)
  assert.equal(hasCredentials(config), true)
})

test('normalizeConfig clamps invalid numbers and rejects bad urls', () => {
  const { config } = normalizeConfig({
    qq: { apiBase: 'javascript:alert(1)', textChunkSize: 999999, intents: -3 },
    llm: { temperature: 9, maxTokens: 1 },
    stickers: { replyChance: 3 }
  })
  assert.equal(config.qq.apiBase, DEFAULT_CONFIG.qq.apiBase)
  assert.equal(config.qq.textChunkSize, 4000)
  assert.equal(config.qq.intents, 0)
  assert.equal(config.llm.temperature, 2)
  assert.equal(config.llm.maxTokens, 64)
  assert.equal(config.stickers.replyChance, 1)
})

test('normalizeConfig warns when credentials are missing', () => {
  const { config, warnings } = normalizeConfig({})
  assert.equal(hasCredentials(config), false)
  assert.ok(warnings.some((warning) => warning.includes('appId')))
})

test('patchConfig deep-merges without dropping sibling fields', () => {
  const { config } = patchConfig({}, { qq: { appId: '42' }, admin: { path: '/ctl' } })
  assert.equal(config.qq.appId, '42')
  assert.equal(config.qq.appSecret, '')
  assert.equal(config.admin.path, '/ctl')
  assert.notEqual(config.qq.apiBase, undefined)
})

test('publicConfig masks the secret and never returns it', () => {
  const { config } = normalizeConfig({ qq: { appId: 'abc', appSecret: 'super-secret-value' } })
  const pub = publicConfig(config)
  assert.equal(pub.qq.appSecret, '')
  assert.equal(pub.qq.hasSecret, true)
  assert.equal(pub.qq.appSecretMasked.includes('super-secret-value'), false)
  assert.equal(maskSecret('super-secret-value').includes('secret'), false)
})

test('parseStickerDirectives extracts tags and cleans the reply text', () => {
  const result = parseStickerDirectives('好家伙 [[sticker: 无语, 敷衍]] 真有你的 [[表情：疑惑]]')
  assert.equal(result.text, '好家伙  真有你的')
  assert.deepEqual(result.requests, [['无语', '敷衍'], ['疑惑']])
})

test('parseStickerDirectives ignores malformed directives', () => {
  assert.deepEqual(parseStickerDirectives('[[sticker]]').requests, [])
  assert.deepEqual(parseStickerDirectives('普通文本').requests, [])
})

test('normalizeTags dedupes and trims delimited input', () => {
  assert.deepEqual(normalizeTags('开心, 开心、难过 | 无语'), ['开心', '难过', '无语'])
  assert.deepEqual(normalizeTags(['#tag', ' tag ', '']), ['tag'])
})

test('chunkText splits long replies under the limit', () => {
  const text = '第一句话。'.repeat(200)
  const chunks = chunkText(text, 120)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(chunk.length <= 120, `chunk too long: ${chunk.length}`)
  assert.equal(chunks.join('').length >= text.length - chunks.length, true)
})

test('estimateTokens counts CJK higher than latin', () => {
  assert.ok(estimateTokens('你好世界') > estimateTokens('hello'))
  assert.equal(estimateTokens(''), 0)
})

test('stripMarkdown removes common markdown noise', () => {
  const clean = stripMarkdown('# 标题\n**加粗** 和 `代码`\n> 引用')
  assert.equal(clean.includes('#'), false)
  assert.equal(clean.includes('**'), false)
  assert.equal(clean.includes('`'), false)
  assert.equal(clean.includes('>'), false)
})

test('parseCommand recognizes prefixes', () => {
  assert.deepEqual(parseCommand('#表情 无语'), { name: '表情', args: '无语', raw: '#表情 无语' })
  assert.deepEqual(parseCommand('/help'), { name: 'help', args: '', raw: '/help' })
  assert.equal(parseCommand('普通消息'), undefined)
  assert.equal(parseCommand('#'), undefined)
})

test('cleanQqText turns QQ face markup into readable markers', () => {
  const cleaned = cleanQqText('<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0="> [图片]')
  assert.equal(cleaned, '[QQ表情 0] [图片]')
  assert.equal(cleanQqText('<faceType=6,faceId="0"> hi'), '[QQ表情 0] hi')
})

test('cleanQqText strips unknown tags and decodes entities', () => {
  assert.equal(cleanQqText('<at id="1">小明</at> 你好 &amp; 再见'), '小明 你好 & 再见')
  assert.equal(cleanQqText('<rps type="1"/> 石头剪刀布'), '[QQ表情] 石头剪刀布')
  assert.equal(cleanQqText('  多  空格 \n\n\n 文本  '), '多 空格\n\n文本')
  assert.equal(cleanQqText('https://example.com/a?x=1&y=2'), 'https://example.com/a?x=1&y=2')
})

test('describeImageMarker adds size and media type for the text model', () => {
  assert.equal(describeImageMarker({ width: 800, height: 600, contentType: 'image/jpeg' }), '[图片 800×600 image/jpeg]')
  assert.equal(describeImageMarker({ filename: 'sticker.gif' }), '[图片 gif]')
  assert.equal(describeImageMarker({}), '[图片]')
})

test('multimodal config migrates legacy vision settings and masks the API key', () => {
  const { config, warnings } = normalizeConfig({
    qq: { appId: '1', appSecret: 's' },
    vision: { enabled: true, baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-secret', model: 'vl', maxImageBytes: 1048576 }
  })
  assert.equal(config.vision, undefined, 'legacy vision key must not survive normalization')
  assert.equal(config.multimodal.enabled, true)
  assert.equal(config.multimodal.baseUrl, 'https://api.example.com/v1')
  assert.equal(config.multimodal.apiKey, 'sk-secret')
  assert.equal(config.multimodal.maxBytes, 1048576)
  assert.equal(config.multimodal.image.model, 'vl')
  assert.equal(config.multimodal.image.enabled, true)
  assert.equal(config.multimodal.audio.enabled, false)
  assert.equal(config.multimodal.video.mode, 'frames')
  assert.equal(warnings.length, 0)

  const pub = publicConfig(config)
  assert.equal(pub.multimodal.apiKey, '')
  assert.equal(pub.multimodal.hasApiKey, true)
  assert.equal(pub.multimodal.apiKeyMasked.includes('sk-secret'), false)

  const incomplete = normalizeConfig({ multimodal: { enabled: true } })
  assert.ok(incomplete.warnings.some((warning) => warning.includes('multimodal.enabled')))

  const modes = normalizeConfig({ multimodal: { audio: { mode: 'bad' }, video: { mode: 'bad', frameCount: 99 } } }).config.multimodal
  assert.equal(modes.audio.mode, 'transcribe')
  assert.equal(modes.video.mode, 'frames')
  assert.equal(modes.video.frameCount, 16)
})

test('createPaths keeps data inside the package by default and maps layers', () => {
  const paths = createPaths({ packageRoot: 'D:\\tmp\\pkg' })
  assert.equal(paths.data, path.join('D:\\tmp\\pkg', 'data'))
  assert.equal(paths.stickerLayerDir('library'), paths.stickerLibrary)
  assert.equal(paths.stickerLayerDir('nope'), undefined)
  assert.ok(paths.chatDir('group_123').includes('group_123'))
})

test('writeJsonAtomic and readJson round-trip and tolerate missing files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-lead-'))
  try {
    const file = path.join(dir, 'nested', 'value.json')
    await writeJsonAtomic(file, { ok: true })
    assert.deepEqual(await readJson(file), { ok: true })
    assert.deepEqual(await readJson(path.join(dir, 'missing.json'), { fallback: true }), { fallback: true })
    await fs.writeFile(path.join(dir, 'bad.json'), '{not json')
    await assert.rejects(() => readJson(path.join(dir, 'bad.json'), {}))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
