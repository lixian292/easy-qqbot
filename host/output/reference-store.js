/**
 * Character reference images for image generation.
 *
 * Unlike generated outputs, these are user-supplied inputs kept in
 * `data/references/` so they can be re-used as image-to-image tokens without
 * polluting the generated-work gallery.
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { readJson, removeFile, writeJsonAtomic } from '../util/fsx.js'
import { extensionForMime, sniffGeneratedMime } from './media.js'

const INDEX_VERSION = 1
const DEFAULT_MAX_ITEMS = 20
const DEFAULT_MAX_BYTES = 10485760
const MAX_ORIGINAL_NAME = 120

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function validRecord(value) {
  return (
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    /^[a-zA-Z0-9]{6,64}$/.test(value.id) &&
    typeof value.ext === 'string' &&
    /^[a-z0-9]{1,8}$/.test(value.ext)
  )
}

function cleanName(value) {
  const name = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, MAX_ORIGINAL_NAME)
  return name === '' ? 'reference' : name
}

/**
 * @param {{ paths: { references: string, referenceIndex: string }, configStore?: { get(): object }, logger?: object }} deps
 */
export function createReferenceStore({ paths, configStore, logger } = {}) {
  if (paths === null || typeof paths !== 'object' || typeof paths.references !== 'string') {
    throw new Error('createReferenceStore 需要 paths.references')
  }
  if (typeof paths.referenceIndex !== 'string') throw new Error('createReferenceStore 需要 paths.referenceIndex')
  const log = logger ?? { debug() {}, warn() {} }

  let items = []
  let ready = false
  let initPromise = null
  let writeChain = Promise.resolve()

  function config() {
    try {
      return configStore?.get?.() ?? {}
    } catch {
      return {}
    }
  }

  function settings() {
    const image = isPlainObject(config().output?.image) ? config().output.image : {}
    const reference = isPlainObject(image.reference) ? image.reference : {}
    return {
      maxItems: Number.isFinite(Number(reference.maxItems)) ? Math.max(1, Math.floor(Number(reference.maxItems))) : DEFAULT_MAX_ITEMS,
      maxBytes: Number.isFinite(Number(reference.maxBytes)) ? Math.max(65536, Math.floor(Number(reference.maxBytes))) : DEFAULT_MAX_BYTES
    }
  }

  function filePathOf(record) {
    return path.join(paths.references, `${record.id}.${record.ext}`)
  }

  function enqueue(task) {
    const run = writeChain.then(task, task)
    writeChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async function persist() {
    await writeJsonAtomic(paths.referenceIndex, { version: INDEX_VERSION, items })
  }

  async function load() {
    try {
      const raw = await fsp.readFile(paths.referenceIndex, 'utf8')
      if (raw.trim() === '') items = []
      else {
        const parsed = JSON.parse(raw)
        items = (Array.isArray(parsed?.items) ? parsed.items : []).filter(validRecord).map(clone)
      }
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        items = []
      } else {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const backup = `${paths.referenceIndex}.corrupt-${stamp}`
        try {
          await fsp.rename(paths.referenceIndex, backup)
        } catch {
          // best effort
        }
        items = []
        log.warn?.('角色参考图索引损坏，已重建为空库', { error: error?.message, backup })
      }
    }
    items.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
  }

  async function ensureLoaded() {
    if (ready) return
    if (initPromise === null) {
      initPromise = (async () => {
        await fsp.mkdir(paths.references, { recursive: true })
        await load()
        ready = true
      })()
    }
    await initPromise
  }

  async function init() {
    await ensureLoaded()
    return { items: items.map(clone) }
  }

  async function add({ buffer, mime, originalName } = {}) {
    await ensureLoaded()
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0)
    if (data.length === 0) throw new Error('参考图片内容为空')
    const { maxBytes, maxItems } = settings()
    if (data.length > maxBytes) throw new Error(`参考图片过大（${data.length} > ${maxBytes} 字节）`)
    const detected = sniffGeneratedMime(data, 'image', mime || '')
    if (detected === '' || !detected.startsWith('image/')) {
      throw new Error('参考图片不是可识别的图片格式（支持 png / jpg / webp / gif / bmp）')
    }
    const ext = extensionForMime(detected, 'png')
    const record = {
      id: crypto.randomBytes(8).toString('hex'),
      ext,
      mime: detected,
      size: data.length,
      originalName: cleanName(originalName),
      createdAt: Date.now()
    }
    return enqueue(async () => {
      await fsp.mkdir(paths.references, { recursive: true })
      await fsp.writeFile(filePathOf(record), data)
      items.unshift(record)
      const removed = items.splice(maxItems)
      for (const item of removed) {
        try {
          await removeFile(filePathOf(item))
        } catch (error) {
          log.warn?.('删除旧参考图失败', { id: item.id, error: error?.message })
        }
      }
      await persist()
      return { ...clone(record), filePath: filePathOf(record) }
    })
  }

  async function list() {
    await ensureLoaded()
    return { items: items.map(clone) }
  }

  async function get(id) {
    await ensureLoaded()
    const target = String(id ?? '')
    return clone(items.find((item) => item.id === target))
  }

  function filePath(recordOrId) {
    if (isPlainObject(recordOrId) && typeof recordOrId.id === 'string') return filePathOf(recordOrId)
    const target = String(recordOrId ?? '')
    const record = items.find((item) => item.id === target)
    return record === undefined ? path.join(paths.references, `${target}.bin`) : filePathOf(record)
  }

  async function remove(id) {
    await ensureLoaded()
    const target = String(id ?? '')
    return enqueue(async () => {
      const index = items.findIndex((item) => item.id === target)
      if (index < 0) throw new Error('找不到该参考图片')
      const [record] = items.splice(index, 1)
      await removeFile(filePathOf(record))
      await persist()
      return clone(record)
    })
  }

  async function flush() {
    await ensureLoaded()
    await writeChain
  }

  return { init, add, list, get, filePath, remove, flush }
}

/** Read the raw reference index without creating it (tests / tooling). */
export async function readReferenceIndex(file) {
  return readJson(file, { version: INDEX_VERSION, items: [] })
}
