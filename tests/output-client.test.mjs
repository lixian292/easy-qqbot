/** Tests for host/output/client.js — all HTTP is injected, no network. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createOutputClient, resolveApiUrl } from '../host/output/client.js'
import { makeConfigStore, makeLogger } from './helpers.mjs'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')
const MP3 = Buffer.from('494433040000000000004c616d65000000000000fffb9064', 'hex')
const MP4 = Buffer.concat([Buffer.from('00000018667479706d70343200000000', 'hex'), Buffer.alloc(64, 1)])

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function binaryResponse(buffer, contentType) {
  return new Response(buffer, { status: 200, headers: { 'content-type': contentType } })
}

function makeStore() {
  const additions = []
  return {
    additions,
    async add(input) {
      additions.push(input)
      const id = String(additions.length).padStart(6, 'a')
      return {
        id,
        kind: input.kind,
        ext: input.ext,
        mime: input.mime,
        size: input.buffer.length,
        prompt: input.prompt,
        provider: input.provider,
        model: input.model,
        durationMs: input.durationMs,
        createdAt: Date.now(),
        source: input.source,
        ...(input.referenceId ? { referenceId: input.referenceId } : {}),
        filePath: `D:\\tmp\\outputs\\${id}.${input.ext}`
      }
    }
  }
}

async function makeReferenceStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-ref-'))
  const file = path.join(dir, 'ref.png')
  await fs.writeFile(file, PNG)
  const record = {
    id: 'ref123456',
    ext: 'png',
    mime: 'image/png',
    size: PNG.length,
    originalName: 'blue-whale-girl.png',
    createdAt: Date.now()
  }
  return {
    record,
    async get(id) {
      return id === record.id ? record : undefined
    },
    filePath() {
      return file
    },
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
}

function setup({ output = {}, fetchImpl = null, referenceStore = null } = {}) {
  const configStore = makeConfigStore({ output: { enabled: true, ...output } })
  const store = makeStore()
  const logger = makeLogger()
  const client = createOutputClient({ configStore, store, referenceStore, logger, fetchImpl })
  return { client, configStore, store, logger }
}

const IMAGE_CONFIG = {
  image: {
    enabled: true,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-image',
    model: 'img-model',
    size: '768x1024',
    sizeField: 'image_size',
    count: 2,
    countField: 'batch_size',
    responseFormat: 'b64_json'
  }
}

test('status reports per-modality readiness without leaking API keys', () => {
  const { client } = setup({ output: IMAGE_CONFIG })
  const status = client.status()
  assert.equal(status.enabled, true)
  assert.equal(status.image.enabled, true)
  assert.equal(status.image.configured, true)
  assert.equal(status.image.model, 'img-model')
  assert.equal(status.audio.enabled, false)
  assert.equal(JSON.stringify(status).includes('sk-image'), false)
})

test('image generation posts mapped body and stores b64 results', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({
      data: [
        { b64_json: PNG.toString('base64') },
        { b64_json: PNG.toString('base64') }
      ]
    })
  }
  const { client, store } = setup({ output: IMAGE_CONFIG, fetchImpl })
  const result = await client.generate({ kind: 'image', prompt: '一只猫', source: { kind: 'admin' } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.example.com/v1/images/generations')
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-image')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'img-model')
  assert.equal(body.prompt, '一只猫')
  assert.equal(body.image_size, '768x1024')
  assert.equal(body.batch_size, 2)
  assert.equal(body.response_format, 'b64_json')
  assert.equal(result.records.length, 2)
  assert.equal(result.record.mime, 'image/png')
  assert.equal(store.additions.length, 2)
  assert.equal(store.additions[0].ext, 'png')
})

test('single-image requests omit n / batch_size; batch requests include it', async () => {
  let body
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body)
    return jsonResponse({ data: [{ b64_json: PNG.toString('base64') }] })
  }
  const single = setup({
    output: {
      image: {
        enabled: true,
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
        count: 1,
        countField: 'n'
      }
    },
    fetchImpl
  })
  await single.client.generate({ kind: 'image', prompt: '一只猫' })
  assert.equal('n' in body, false, 'single image must not send n')
  assert.equal('batch_size' in body, false)

  const batch = setup({
    output: {
      image: {
        enabled: true,
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
        count: 3,
        countField: 'batch_size'
      }
    },
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body)
      return jsonResponse({ data: [{ b64_json: PNG.toString('base64') }] })
    }
  })
  await batch.client.generate({ kind: 'image', prompt: '一只猫' })
  assert.equal(body.batch_size, 3)
})

test('image URL results are downloaded and unknown providers are tolerated', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url === 'https://api.example.com/v1/images/generations') {
      return jsonResponse({ images: [{ url: 'https://cdn.example.com/a.png' }] })
    }
    return binaryResponse(PNG, 'image/png')
  }
  const { client } = setup({
    output: { image: { ...IMAGE_CONFIG.image, count: 1, countField: 'none' } },
    fetchImpl
  })
  const result = await client.generate({ kind: 'image', prompt: '海边' })
  assert.deepEqual(calls, ['https://api.example.com/v1/images/generations', 'https://cdn.example.com/a.png'])
  assert.equal(result.record.mime, 'image/png')
})

test('speech generation accepts binary audio and sends OpenAI-compatible body', async () => {
  let request
  const fetchImpl = async (url, init) => {
    request = { url, init }
    return binaryResponse(MP3, 'audio/mpeg')
  }
  const { client } = setup({
    output: {
      audio: {
        enabled: true,
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-audio',
        model: 'tts-model',
        voice: 'female-1',
        format: 'mp3',
        speed: 1.2
      }
    },
    fetchImpl
  })
  const result = await client.generate({ kind: 'audio', prompt: '你好呀' })
  assert.equal(request.url, 'https://api.example.com/v1/audio/speech')
  const body = JSON.parse(request.init.body)
  assert.deepEqual(body, { model: 'tts-model', input: '你好呀', voice: 'female-1', response_format: 'mp3', speed: 1.2 })
  assert.equal(result.record.mime, 'audio/mpeg')
  assert.equal(result.record.size, MP3.length)
})

test('speech JSON responses with base64 are decoded', async () => {
  const fetchImpl = async () => jsonResponse({ data: MP3.toString('base64') })
  const { client } = setup({
    output: {
      audio: { enabled: true, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm' }
    },
    fetchImpl
  })
  const result = await client.generate({ kind: 'audio', prompt: '晚安' })
  assert.equal(result.record.mime, 'audio/mpeg')
})

test('SiliconFlow video protocol: submit, poll, download', async () => {
  let polls = 0
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(url)
    if (url.endsWith('/video/submit')) return jsonResponse({ requestId: 'task-1' })
    if (url.endsWith('/video/status')) {
      polls += 1
      if (polls < 2) return jsonResponse({ status: 'InProgress' })
      return jsonResponse({ status: 'Succeed', results: { videos: [{ url: 'https://cdn.example.com/v.mp4' }] } })
    }
    if (url === 'https://cdn.example.com/v.mp4') return binaryResponse(MP4, 'video/mp4')
    throw new Error(`unexpected url ${url}`)
  }
  const { client } = setup({
    output: {
      video: {
        enabled: true,
        preset: 'siliconflow',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-video',
        model: 'Wan-AI/Wan2.2-T2V-A14B',
        size: '1280x720',
        negativePrompt: '低清',
        pollIntervalMs: 500,
        maxWaitMs: 10000
      }
    },
    fetchImpl
  })
  const result = await client.generate({ kind: 'video', prompt: '海边日落' })
  assert.deepEqual(calls.slice(0, 3), [
    'https://api.example.com/v1/video/submit',
    'https://api.example.com/v1/video/status',
    'https://api.example.com/v1/video/status'
  ])
  assert.equal(result.record.mime, 'video/mp4')
})

test('video task failure surfaces a typed TASK_FAILED error', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/video/submit')) return jsonResponse({ requestId: 'task-2' })
    return jsonResponse({ status: 'Failed', reason: 'content filtered' })
  }
  const { client } = setup({
    output: {
      video: {
        enabled: true,
        preset: 'siliconflow',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
        pollIntervalMs: 500
      }
    },
    fetchImpl
  })
  await assert.rejects(
    () => client.generate({ kind: 'video', prompt: 'x' }),
    (error) => error.code === 'TASK_FAILED' && /content filtered/.test(error.message)
  )
})

test('OpenAI Videos protocol downloads /content', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    if (url.endsWith('/videos') && init?.method === 'POST') return jsonResponse({ id: 'task-3', status: 'queued' })
    if (url.endsWith('/videos/task-3') && (init?.method ?? 'GET') === 'GET') return jsonResponse({ status: 'completed' })
    if (url.endsWith('/videos/task-3/content')) return binaryResponse(MP4, 'video/mp4')
    throw new Error(`unexpected url ${url}`)
  }
  const { client } = setup({
    output: {
      video: {
        enabled: true,
        preset: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'sora-2',
        size: '1280x720',
        duration: 8,
        pollIntervalMs: 500
      }
    },
    fetchImpl
  })
  const result = await client.generate({ kind: 'video', prompt: '海边' })
  assert.equal(result.record.mime, 'video/mp4')
  assert.equal(calls.some((call) => call.url.endsWith('/videos/task-3/content')), true)
})

test('custom video protocol reads configured JSON paths and GET polling', async () => {
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/custom/submit')) return jsonResponse({ data: { task: { id: 't-9' } } })
    if (url.endsWith('/custom/status/t-9')) {
      assert.equal(init?.method ?? 'GET', 'GET')
      return jsonResponse({ data: { state: 'done', file: { link: 'https://cdn.example.com/custom.mp4' } } })
    }
    if (url === 'https://cdn.example.com/custom.mp4') return binaryResponse(MP4, 'video/mp4')
    throw new Error(`unexpected url ${url}`)
  }
  const { client } = setup({
    output: {
      video: {
        enabled: true,
        preset: 'custom',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
        createPath: '/custom/submit',
        queryPath: '/custom/status/{id}',
        queryMethod: 'GET',
        idField: 'data.task.id',
        statusField: 'data.state',
        resultField: 'data.file.link',
        successValues: 'done',
        failureValues: 'error',
        pollIntervalMs: 500
      }
    },
    fetchImpl
  })
  const result = await client.generate({ kind: 'video', prompt: 'city' })
  assert.equal(result.record.mime, 'video/mp4')
})

test('generate validates enable flags, configuration, prompt and extraBody', async () => {
  const disabled = setup({ output: { enabled: false } }).client
  await assert.rejects(() => disabled.generate({ kind: 'image', prompt: 'x' }), (error) => error.code === 'OUTPUT_NOT_ENABLED')

  const incomplete = setup({
    output: { image: { enabled: true, baseUrl: 'https://api.example.com/v1', apiKey: '', model: 'm' } }
  }).client
  await assert.rejects(() => incomplete.generate({ kind: 'image', prompt: 'x' }), (error) => error.code === 'OUTPUT_NOT_CONFIGURED')

  const noPrompt = setup({ output: IMAGE_CONFIG }).client
  await assert.rejects(() => noPrompt.generate({ kind: 'image', prompt: '   ' }), (error) => error.code === 'INVALID_PROMPT')

  const badJson = setup({
    output: { image: { ...IMAGE_CONFIG.image, extraBody: '{bad' } },
    fetchImpl: async () => jsonResponse({ data: [{ b64_json: PNG.toString('base64') }] })
  }).client
  await assert.rejects(() => badJson.generate({ kind: 'image', prompt: 'x' }), (error) => error.code === 'INVALID_EXTRA_BODY')
})

test('HTTP errors include status and a safe provider message', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401, headers: { 'content-type': 'application/json' } })
  const { client, logger } = setup({ output: IMAGE_CONFIG, fetchImpl })
  await assert.rejects(
    () => client.generate({ kind: 'image', prompt: 'x' }),
    (error) => error.code === 'HTTP_401' && /invalid key/.test(error.message) && /API Key/.test(error.message)
  )
  assert.equal(logger.entries.some((entry) => String(entry.detail).includes('sk-image')), false)
})

test('resolveApiUrl inserts /v1 for path-less OpenAI bases and avoids duplicate /v1', () => {
  assert.equal(resolveApiUrl('https://api.example.com', '/images/generations'), 'https://api.example.com/v1/images/generations')
  assert.equal(resolveApiUrl('https://api.example.com/', '/audio/speech'), 'https://api.example.com/v1/audio/speech')
  assert.equal(resolveApiUrl('https://api.example.com/v1', '/images/generations'), 'https://api.example.com/v1/images/generations')
  assert.equal(resolveApiUrl('https://api.example.com/v1/', '/v1/images/generations'), 'https://api.example.com/v1/images/generations')
  assert.equal(resolveApiUrl('https://api.example.com/openai/v1', '/images/generations'), 'https://api.example.com/openai/v1/images/generations')
  assert.equal(resolveApiUrl('https://api.example.com/custom', '/images/generations'), 'https://api.example.com/custom/images/generations')
  assert.equal(resolveApiUrl('https://api.example.com', 'https://other.example.com/v1/images/generations'), 'https://other.example.com/v1/images/generations')
  assert.equal(resolveApiUrl('', '/images/generations'), '')
})

test('status exposes the actual request URL and auto-adds /v1', () => {
  const { client } = setup({
    output: {
      image: {
        enabled: true,
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        model: 'm'
      }
    }
  })
  const status = client.status()
  assert.equal(status.image.requestUrl, 'https://api.example.com/v1/images/generations')
  assert.equal(status.image.modelsUrl, 'https://api.example.com/v1/models')
})

test('test() uses /v1/models for a path-less base and suggests the versioned base URL', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return jsonResponse({ data: [{ id: 'm' }] })
  }
  const { client } = setup({
    output: { image: { enabled: true, baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' } },
    fetchImpl
  })
  const result = await client.test({ kind: 'image' })
  assert.deepEqual(calls, ['https://api.example.com/v1/models'])
  assert.equal(result.url, 'https://api.example.com/v1/models')
  assert.equal(result.requestUrl, 'https://api.example.com/v1/images/generations')
  assert.equal(result.suggestedBaseUrl, 'https://api.example.com/v1')
  assert.equal(result.modelFound, true)
})

test('test() rejects an HTML web page instead of reporting a healthy API', async () => {
  const { client } = setup({
    output: { image: { enabled: true, baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' } },
    fetchImpl: async () => new Response('<!DOCTYPE html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
  })
  await assert.rejects(() => client.test({ kind: 'image' }), (error) => error.code === 'HTML_RESPONSE' && /\/v1/.test(error.message))
})

test('404 from /models now includes the actual URL in the soft-pass warning', async () => {
  const { client } = setup({
    output: { image: { enabled: true, baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' } },
    fetchImpl: async () => new Response('not found', { status: 404 })
  })
  const result = await client.test({ kind: 'image' })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'config-only')
  assert.ok(result.warning.includes('https://api.example.com/v1/models'))
})

test('character reference auto-triggers on prompt keywords and sends multipart /images/edits', async () => {
  const refStore = await makeReferenceStore()
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({ data: [{ b64_json: PNG.toString('base64') }] })
  }
  try {
    const { client, store } = setup({
      output: {
        image: {
          enabled: true,
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'k',
          model: 'img-model',
          reference: {
            enabled: true,
            id: refStore.record.id,
            trigger: 'auto',
            keywords: '小蓝,鲸鱼娘',
            requestMode: 'edits',
            path: '/images/edits',
            field: 'image',
            promptPrefix: '保持蓝色鲸鱼娘形象一致'
          }
        }
      },
      fetchImpl,
      referenceStore: refStore
    })
    const result = await client.generate({ kind: 'image', prompt: '画一只小蓝在海边' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.example.com/v1/images/edits')
    assert.equal(calls[0].init.body instanceof FormData, true)
    const form = calls[0].init.body
    assert.equal(form.get('model'), 'img-model')
    assert.equal(form.get('image').name, 'blue-whale-girl.png')
    assert.equal(form.get('image').type, 'image/png')
    assert.ok(form.get('prompt').includes('保持蓝色鲸鱼娘形象一致'))
    assert.ok(form.get('prompt').includes('画一只小蓝在海边'))
    assert.equal(store.additions[0].referenceId, refStore.record.id)
    assert.equal(result.record.referenceId, refStore.record.id)
  } finally {
    await refStore.cleanup()
  }
})

test('reference auto-trigger matches pronoun 你 used by #画 selfie commands', async () => {
  const refStore = await makeReferenceStore()
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({ data: [{ b64_json: PNG.toString('base64') }] })
  }
  try {
    const { client, store } = setup({
      output: {
        image: {
          enabled: true,
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'k',
          model: 'img-model',
          reference: {
            enabled: true,
            id: refStore.record.id,
            trigger: 'auto',
            keywords: '小蓝,你',
            requestMode: 'edits',
            path: '/images/edits',
            field: 'image'
          }
        }
      },
      fetchImpl,
      referenceStore: refStore
    })
    const result = await client.generate({ kind: 'image', prompt: '一张你的自拍照' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.example.com/v1/images/edits')
    assert.equal(store.additions[0].referenceId, refStore.record.id)
    assert.equal(result.record.referenceId, refStore.record.id)
  } finally {
    await refStore.cleanup()
  }
})

test('reference JSON mode embeds a data URL and skips reference when prompt has no trigger', async () => {
  const refStore = await makeReferenceStore()
  let calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({ data: [{ b64_json: PNG.toString('base64') }] })
  }
  try {
    const { client } = setup({
      output: {
        image: {
          enabled: true,
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'k',
          model: 'img-model',
          reference: {
            enabled: true,
            id: refStore.record.id,
            trigger: 'auto',
            keywords: '小蓝',
            requestMode: 'generations',
            field: 'image',
            format: 'data_url'
          }
        }
      },
      fetchImpl,
      referenceStore: refStore
    })
    await client.generate({ kind: 'image', prompt: '小蓝在月亮上' })
    const body = JSON.parse(calls[0].init.body)
    assert.equal(calls[0].url, 'https://api.example.com/v1/images/generations')
    assert.ok(String(body.image).startsWith('data:image/png;base64,'))

    calls = []
    await client.generate({ kind: 'image', prompt: '画一只普通的小猫' })
    const normalBody = JSON.parse(calls[0].init.body)
    assert.equal('image' in normalBody, false)
    assert.equal(calls[0].url, 'https://api.example.com/v1/images/generations')
  } finally {
    await refStore.cleanup()
  }
})

test('reference enabled but no active image fails with a helpful error', async () => {
  const fetchImpl = async () => {
    throw new Error('should not fetch')
  }
  const { client } = setup({
    output: {
      image: {
        enabled: true,
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'img-model',
        reference: { enabled: true, id: '', trigger: 'auto', keywords: '小蓝' }
      }
    },
    fetchImpl
  })
  await assert.rejects(
    () => client.generate({ kind: 'image', prompt: '画小蓝' }),
    (error) => error.code === 'REFERENCE_MISSING' && /还没有选择参考图片/.test(error.message)
  )
})

test('reference request failure falls back to text-to-image when enabled', async () => {
  const refStore = await makeReferenceStore()
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/images/edits')) {
      return new Response(JSON.stringify({ error: { message: 'edits unsupported' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      })
    }
    return jsonResponse({ data: [{ b64_json: PNG.toString('base64') }] })
  }
  try {
    const { client, store } = setup({
      output: {
        image: {
          enabled: true,
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'k',
          model: 'img-model',
          reference: {
            enabled: true,
            id: refStore.record.id,
            trigger: 'auto',
            keywords: '小蓝',
            requestMode: 'edits',
            promptPrefix: 'REFERENCE-HINT',
            fallbackToText: true
          }
        }
      },
      fetchImpl,
      referenceStore: refStore
    })
    const result = await client.generate({ kind: 'image', prompt: '画小蓝' })
    assert.equal(calls.length, 2)
    assert.equal(calls[1].url, 'https://api.example.com/v1/images/generations')
    assert.equal(store.additions[0].prompt.includes('REFERENCE-HINT'), false)
    assert.equal(store.additions[0].referenceId, undefined)
    assert.equal(result.record.referenceId, undefined)
  } finally {
    await refStore.cleanup()
  }
})

test('test() probes /models and soft-passes when the endpoint is absent', async () => {
  const ok = setup({
    output: IMAGE_CONFIG,
    fetchImpl: async () => jsonResponse({ data: [{ id: 'img-model' }, { id: 'other' }] })
  }).client
  const probed = await ok.test({ kind: 'image' })
  assert.equal(probed.ok, true)
  assert.equal(probed.mode, 'models')
  assert.equal(probed.modelFound, true)

  const missing = setup({ output: IMAGE_CONFIG, fetchImpl: async () => new Response('not found', { status: 404 }) }).client
  const soft = await missing.test({ kind: 'image' })
  assert.equal(soft.ok, true)
  assert.equal(soft.mode, 'config-only')
  assert.ok(soft.warning.includes('/models'))

  const unauthorized = setup({ output: IMAGE_CONFIG, fetchImpl: async () => new Response('no', { status: 401 }) }).client
  await assert.rejects(() => unauthorized.test({ kind: 'image' }), (error) => error.code === 'HTTP_401')
})
