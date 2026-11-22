/**
 * Local library for generated images / speech / videos.
 *
 * One JSON index (`data/outputs/index.json`) plus one file per asset
 * (`data/outputs/<id>.<ext>`). The index is written atomically and every
 * mutation is serialized through a promise queue, so concurrent admin previews
 * and chat generations cannot corrupt it.
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { readJson, removeFile, writeJsonAtomic } from '../util/fsx.js'
import { extensionForMime } from './media.js'

const OUTPUT_KINDS = new Set(['image', 'audio', 'video'])
const INDEX_VERSION = 1
const DEFAULT_MAX_ITEMS = 200
const DEFAULT_RETENTION_DAYS = 14
const MAX_PROMPT_CHARS = 2000

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function safeExt(value, fallback) {
  const ext = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '')
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : fallback
}

function validRecord(value) {
  if (!isPlainObject(value)) return false
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9]{6,64}$/.test(value.id)) return false
  if (!OUTPUT_KINDS.has(value.kind)) return false
  if (typeof value.ext !== 'string' || !/^[a-z0-9]{1,8}$/.test(value.ext)) return false
  return true
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * @param {{ paths: { outputs: string, outputIndex: string }, configStore?: { get(): object }, logger?: object }} deps
 */
export function createOutputStore({ paths, configStore, logger } = {}) {
  if (paths === null || typeof paths !== 'object' || typeof paths.outputs !== 'string') {
    throw new Error('createOutputStore 需要 paths.outputs')
  }
  if (typeof paths.outputIndex !== 'string') throw new Error('createOutputStore 需要 paths.outputIndex')
  const log = logger ?? { warn() {}, info() {}, debug() {} }

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

  function enqueue(task) {
    const run = writeChain.then(task, task)
    writeChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  function filePathOf(record) {
    return path.join(paths.outputs, `${record.id}.${record.ext}`)
  }

  async function persist() {
    await writeJsonAtomic(paths.outputIndex, { version: INDEX_VERSION, items })
  }

  async function pruneInternal() {
    const output = isPlainObject(config().output) ? config().output : {}
    const maxItems = Number.isFinite(Number(output.maxItems)) ? Math.max(0, Math.floor(Number(output.maxItems))) : DEFAULT_MAX_ITEMS
    const retentionDays = Number.isFinite(Number(output.retentionDays))
      ? Math.max(0, Math.floor(Number(output.retentionDays)))
      : DEFAULT_RETENTION_DAYS
    const now = Date.now()
    const keep = []
    const dropped = []
    for (const record of items) {
      const createdAt = Number(record.createdAt)
      const expired = retentionDays > 0 && Number.isFinite(createdAt) && now - createdAt > retentionDays * 86400000
      if (expired) dropped.push(record)
      else keep.push(record)
    }
    if (maxItems > 0 && keep.length > maxItems) {
      dropped.push(...keep.slice(maxItems))
      keep.length = maxItems
    }
    if (dropped.length === 0) return []
    items = keep
    for (const record of dropped) {
      try {
        await removeFile(filePathOf(record))
      } catch (error) {
        log.warn?.('删除过期多模态输出文件失败', { id: record.id, error: error?.message })
      }
    }
    log.debug?.('多模态输出库已清理', { removed: dropped.length })
    return dropped
  }

  async function load() {
    try {
      const raw = await fsp.readFile(paths.outputIndex, 'utf8')
      if (raw.trim() === '') {
        items = []
      } else {
        const parsed = JSON.parse(raw)
        items = (Array.isArray(parsed?.items) ? parsed.items : []).filter(validRecord).map(clone)
      }
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        items = []
      } else {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const backup = `${paths.outputIndex}.corrupt-${stamp}`
        try {
          await fsp.rename(paths.outputIndex, backup)
        } catch {
          // best effort
        }
        items = []
        log.warn?.('多模态输出索引损坏，已重建为空库', { error: error?.message, backup })
      }
    }
    items.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
  }

  async function ensureLoaded() {
    if (ready) return
    if (initPromise === null) {
      initPromise = (async () => {
        await fsp.mkdir(paths.outputs, { recursive: true })
        await load()
        ready = true
      })()
    }
    await initPromise
  }

  async function init() {
    await ensureLoaded()
    return stats()
  }

  async function add(input = {}) {
    await ensureLoaded()
    const kind = String(input.kind ?? '').trim().toLowerCase()
    if (!OUTPUT_KINDS.has(kind)) throw new Error(`不支持的输出类型：${kind === '' ? '(空)' : kind}`)
    const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.alloc(0)
    if (buffer.length === 0) throw new Error('生成内容为空，无法入库')
    const mime = String(input.mime ?? '').toLowerCase().slice(0, 128)
    const ext = safeExt(input.ext, extensionForMime(mime))
    const record = {
      id: crypto.randomBytes(8).toString('hex'),
      kind,
      ext,
      mime,
      size: buffer.length,
      prompt: String(input.prompt ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_PROMPT_CHARS),
      provider: String(input.provider ?? '').trim().slice(0, 64),
      model: String(input.model ?? '').trim().slice(0, 128),
      durationMs: Math.max(0, Math.round(Number(input.durationMs) || 0)),
      createdAt: Number.isFinite(Number(input.createdAt)) ? Number(input.createdAt) : Date.now(),
      source: isPlainObject(input.source) ? clone(input.source) : { kind: 'admin' },
      ...(typeof input.referenceId === 'string' && input.referenceId !== ''
        ? { referenceId: input.referenceId.slice(0, 64) }
        : {})
    }
    const filePath = filePathOf(record)
    return enqueue(async () => {
      await fsp.mkdir(paths.outputs, { recursive: true })
      await fsp.writeFile(filePath, buffer)
      items.unshift(record)
      await pruneInternal()
      await persist()
      return { ...clone(record), filePath: filePathOf(record) }
    })
  }

  async function list({ kind, limit = 30, offset = 0 } = {}) {
    await ensureLoaded()
    const filterKind = String(kind ?? '').trim().toLowerCase()
    const source = filterKind === '' || !OUTPUT_KINDS.has(filterKind) ? items : items.filter((item) => item.kind === filterKind)
    const size = Math.min(200, Math.max(1, Math.floor(Number(limit) || 30)))
    const skip = Math.max(0, Math.floor(Number(offset) || 0))
    return {
      total: source.length,
      items: source.slice(skip, skip + size).map(clone)
    }
  }

  async function get(id) {
    await ensureLoaded()
    const target = String(id ?? '')
    return clone(items.find((item) => item.id === target))
  }

  function filePath(recordOrId) {
    if (isPlainObject(recordOrId) && typeof recordOrId.id === 'string') {
      return filePathOf(recordOrId)
    }
    const target = String(recordOrId ?? '')
    const record = items.find((item) => item.id === target)
    return record === undefined ? path.join(paths.outputs, `${target}.bin`) : filePathOf(record)
  }

  async function remove(id) {
    await ensureLoaded()
    const target = String(id ?? '')
    return enqueue(async () => {
      const index = items.findIndex((item) => item.id === target)
      if (index < 0) throw new Error('找不到该生成结果')
      const [record] = items.splice(index, 1)
      await removeFile(filePathOf(record))
      await persist()
      return clone(record)
    })
  }

  async function clear({ kind } = {}) {
    await ensureLoaded()
    const filterKind = String(kind ?? '').trim().toLowerCase()
    return enqueue(async () => {
      const keep = []
      const dropped = []
      for (const record of items) {
        if (filterKind === '' || record.kind === filterKind) dropped.push(record)
        else keep.push(record)
      }
      items = keep
      for (const record of dropped) {
        try {
          await removeFile(filePathOf(record))
        } catch (error) {
          log.warn?.('删除多模态输出文件失败', { id: record.id, error: error?.message })
        }
      }
      if (dropped.length > 0) await persist()
      return { removed: dropped.length }
    })
  }

  function stats() {
    const byKind = { image: 0, audio: 0, video: 0 }
    let bytes = 0
    let latestAt = 0
    for (const record of items) {
      if (byKind[record.kind] !== undefined) byKind[record.kind] += 1
      bytes += Math.max(0, Number(record.size) || 0)
      latestAt = Math.max(latestAt, Number(record.createdAt) || 0)
    }
    return { total: items.length, byKind, bytes, latestAt }
  }

  async function flush() {
    await ensureLoaded()
    await writeChain
  }

  return { init, add, list, get, filePath, remove, clear, stats, flush }
}

/** Read a JSON index without creating one (used by scripts / tests). */
export async function readOutputIndex(file) {
  const value = await readJson(file, { version: INDEX_VERSION, items: [] })
  return value
}
