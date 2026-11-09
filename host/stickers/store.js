/**
 * Sticker index store.
 *
 * Owns `data/stickers/index.json` plus every per-layer image file
 * (`data/stickers/<layer>/<id>.<ext>`). All mutations run through a single
 * promise queue and the index is replaced atomically, so the chat engine and
 * the admin page can safely share one store instance.
 *
 * Layers:
 *   library   - ready to be sent in chat
 *   candidate - captured automatically / waiting for review
 *   negative  - rejected, never sent
 *   trash     - removed, can be restored
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  ensureDir,
  moveFile,
  pathExists,
  readJson,
  removeFile,
  sha256Buffer,
  writeJsonAtomic
} from '../util/fsx.js'
import { mergeTags, normalizeTags } from '../util/text.js'

/** Layer names, in the order the admin UI usually shows them. */
export const STICKER_LAYERS = Object.freeze(['library', 'candidate', 'negative', 'trash'])

const INDEX_VERSION = 1
const ID_LENGTH = 12
const MAX_DESC_LENGTH = 2000
const MAX_SOURCE_VALUE = 1024
const LAYER_SET = new Set(STICKER_LAYERS)
/** Accepted extension aliases; the stored form is normalised to jpg when possible. */
const EXT_ALIAS = new Map([
  ['jpg', 'jpg'],
  ['jpeg', 'jpg'],
  ['png', 'png'],
  ['gif', 'gif'],
  ['webp', 'webp'],
  ['bmp', 'bmp']
])
const SOURCE_KEYS = ['chatId', 'userId', 'userName', 'msgId', 'path', 'url']

const clone = (value) => structuredClone(value)

function assertLayer(layer) {
  const value = String(layer ?? '')
  if (!LAYER_SET.has(value)) throw new Error(`invalid sticker layer: ${layer}`)
  return value
}

function normalizeSupportedExt(ext) {
  const raw = String(ext ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '')
  const mapped = EXT_ALIAS.get(raw)
  if (mapped === undefined) throw new Error(`unsupported sticker format: ${ext ?? ''}`)
  return mapped
}

function normalizeDesc(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DESC_LENGTH)
}

function normalizeSource(source) {
  if (source === null || source === undefined || typeof source !== 'object') return undefined
  const out = {}
  for (const key of SOURCE_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim().slice(0, MAX_SOURCE_VALUE)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeEpoch(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.floor(number)
}

function sameTag(tag, other) {
  return tag.toLowerCase() === other.toLowerCase()
}

function matchesAllTags(itemTags, wantedTags) {
  return wantedTags.every((wanted) => itemTags.some((tag) => sameTag(tag, wanted)))
}

/**
 * @param {{ paths: object, configStore: { get(): object }, logger?: object }} deps
 */
export function createStickerStore({ paths, configStore, logger } = {}) {
  if (!paths || typeof paths.stickerIndex !== 'string' || typeof paths.stickerLayerDir !== 'function') {
    throw new Error('createStickerStore 需要 host/paths.js 的 paths 对象')
  }

  let items = []
  let byId = new Map()
  let byHash = new Map()
  let initPromise = null
  let queue = Promise.resolve()

  function rebuildMaps() {
    byId = new Map()
    byHash = new Map()
    for (const item of items) {
      byId.set(item.id, item)
      if (item.hash !== '') byHash.set(item.hash, item)
    }
  }

  function filePathOf(item) {
    const dir = paths.stickerLayerDir(item.layer)
    if (!dir) throw new Error(`invalid sticker layer: ${item.layer}`)
    return path.join(dir, `${item.id}.${item.ext}`)
  }

  async function persistIndex(nextItems) {
    await writeJsonAtomic(paths.stickerIndex, { version: INDEX_VERSION, items: nextItems })
  }

  function commit(nextItems) {
    items = nextItems
    rebuildMaps()
  }

  async function backupCorruptIndex(reason) {
    const backup = `${paths.stickerIndex}.corrupt-${Date.now()}`
    try {
      if (await pathExists(paths.stickerIndex)) await moveFile(paths.stickerIndex, backup)
      logger?.warn?.('表情包索引损坏，已备份并重建', { file: paths.stickerIndex, backup, reason })
    } catch (error) {
      logger?.warn?.('表情包索引损坏，备份失败，将直接重建', { file: paths.stickerIndex, reason, error: error?.message })
    }
  }

  function normalizeLoadedItem(raw, now = Date.now()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id === '') return undefined
    const extRaw = String(raw.ext ?? '')
      .trim()
      .toLowerCase()
      .replace(/^\./, '')
    const ext = EXT_ALIAS.get(extRaw)
    if (ext === undefined) return undefined
    const layer = LAYER_SET.has(raw.layer) ? raw.layer : 'candidate'
    const createdAt = normalizeEpoch(raw.createdAt, now)
    const item = {
      id,
      hash: typeof raw.hash === 'string' ? raw.hash : '',
      ext,
      size: Number.isFinite(Number(raw.size)) && Number(raw.size) >= 0 ? Math.floor(Number(raw.size)) : 0,
      layer,
      tags: normalizeTags(raw.tags),
      desc: normalizeDesc(raw.desc),
      useCount: Number.isFinite(Number(raw.useCount)) && Number(raw.useCount) > 0 ? Math.floor(Number(raw.useCount)) : 0,
      createdAt,
      updatedAt: normalizeEpoch(raw.updatedAt, createdAt)
    }
    if (Number.isFinite(Number(raw.lastUsedAt)) && Number(raw.lastUsedAt) > 0) {
      item.lastUsedAt = Math.floor(Number(raw.lastUsedAt))
    }
    const source = normalizeSource(raw.source)
    if (source !== undefined) item.source = source
    return item
  }

  async function loadIndex() {
    await ensureDir(paths.stickers)
    for (const layer of STICKER_LAYERS) {
      const dir = paths.stickerLayerDir(layer)
      if (typeof dir === 'string') await ensureDir(dir)
    }

    let raw
    try {
      raw = await readJson(paths.stickerIndex, undefined)
    } catch (error) {
      await backupCorruptIndex(error?.message ?? String(error))
      raw = undefined
    }

    if (raw === undefined) {
      commit([])
      await persistIndex(items)
      return
    }

    const rawItems = Array.isArray(raw) ? raw : raw?.items
    if (!Array.isArray(rawItems)) {
      await backupCorruptIndex('index.json 缺少 items 数组')
      commit([])
      await persistIndex(items)
      return
    }

    const now = Date.now()
    const loaded = []
    let dropped = 0
    for (const entry of rawItems) {
      const item = normalizeLoadedItem(entry, now)
      if (item === undefined) {
        dropped += 1
        continue
      }
      loaded.push(item)
    }
    if (dropped > 0) logger?.warn?.('表情包索引中有条目无效，已忽略', { dropped })

    // Merge duplicated hashes defensively: keep the first entry, fold tags in.
    const seen = new Map()
    const deduped = []
    let mergedCount = 0
    for (const item of loaded) {
      if (item.hash === '') {
        deduped.push(item)
        continue
      }
      const first = seen.get(item.hash)
      if (first === undefined) {
        seen.set(item.hash, item)
        deduped.push(item)
        continue
      }
      first.tags = mergeTags(first.tags, item.tags)
      if (first.desc === '' && item.desc !== '') first.desc = item.desc
      if (item.useCount > first.useCount) first.useCount = item.useCount
      mergedCount += 1
    }
    if (mergedCount > 0) logger?.warn?.('表情包索引存在重复内容，已合并', { merged: mergedCount })
    commit(deduped)
  }

  function ensureReady() {
    if (initPromise === null) initPromise = loadIndex()
    return initPromise
  }

  /** Serialize one mutation; resolves/rejects with the task result. */
  function mutate(task) {
    const run = queue.then(task)
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async function writeBufferFile(file, buffer) {
    await ensureDir(path.dirname(file))
    await fsp.writeFile(file, buffer)
  }

  function itemIndex(target) {
    return items.findIndex((item) => item.id === target.id)
  }

  async function commitUpdated(current, patch) {
    const next = { ...current }
    let dirty = false

    if (patch?.tags !== undefined) {
      next.tags = normalizeTags(patch.tags)
      dirty = true
    }
    if (patch?.desc !== undefined) {
      next.desc = normalizeDesc(patch.desc)
      dirty = true
    }
    if (patch?.layer !== undefined) {
      const layer = assertLayer(patch.layer)
      if (layer !== current.layer) {
        const from = filePathOf(current)
        const to = filePathOf({ ...current, layer })
        if (await pathExists(from)) {
          await moveFile(from, to)
        } else if (!(await pathExists(to))) {
          logger?.warn?.('表情包文件缺失，仅更新索引图层', { id: current.id, from })
        }
        next.layer = layer
        dirty = true
      }
    }
    // Optional metadata fields (used by the one-off migration tool; harmless for admin edits).
    if (patch?.useCount !== undefined) {
      const value = Number(patch.useCount)
      if (Number.isFinite(value) && value >= 0) {
        next.useCount = Math.floor(value)
        dirty = true
      }
    }
    if (patch?.createdAt !== undefined) {
      const value = normalizeEpoch(patch.createdAt, current.createdAt)
      if (value !== current.createdAt) {
        next.createdAt = value
        dirty = true
      }
    }
    if (patch?.lastUsedAt !== undefined) {
      if (patch.lastUsedAt === null) {
        delete next.lastUsedAt
        dirty = true
      } else {
        const value = normalizeEpoch(patch.lastUsedAt, 0)
        if (value > 0 && value !== current.lastUsedAt) {
          next.lastUsedAt = value
          dirty = true
        }
      }
    }
    if (patch?.source !== undefined) {
      const source = normalizeSource(patch.source)
      if (source === undefined) delete next.source
      else next.source = source
      dirty = true
    }

    if (!dirty) return clone(current)

    next.updatedAt = Date.now()
    const nextItems = items.slice()
    nextItems[itemIndex(current)] = next
    await persistIndex(nextItems)
    commit(nextItems)
    return clone(next)
  }

  const api = {
    /** Load the index from disk (creates an empty one when missing/corrupt). */
    async init() {
      await ensureReady()
      await queue
    },

    /**
     * List items (newest `updatedAt` first).
     * @param {{ layer?: string, tags?: string[]|string, query?: string, limit?: number, offset?: number }} [filter]
     * @returns {Promise<{ total: number, items: object[] }>}
     */
    async list({ layer, tags, query, limit = 60, offset = 0 } = {}) {
      await ensureReady()
      const wantedTags = normalizeTags(tags)
      const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
      let filtered = items
      if (layer !== undefined) filtered = filtered.filter((item) => item.layer === layer)
      if (wantedTags.length > 0) filtered = filtered.filter((item) => matchesAllTags(item.tags, wantedTags))
      if (needle !== '') {
        filtered = filtered.filter(
          (item) =>
            item.id.toLowerCase().includes(needle) ||
            item.desc.toLowerCase().includes(needle) ||
            item.tags.some((tag) => tag.toLowerCase().includes(needle))
        )
      }
      const sorted = filtered.slice().sort((a, b) => {
        if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
        if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
      const start = Math.max(0, Math.floor(Number(offset) || 0))
      const size = Number(limit)
      const page = Number.isFinite(size) && size > 0 ? sorted.slice(start, start + Math.floor(size)) : sorted.slice(start)
      return { total: sorted.length, items: page.map(clone) }
    },

    /** @returns {Promise<object|undefined>} */
    async get(id) {
      await ensureReady()
      const item = byId.get(String(id))
      return item === undefined ? undefined : clone(item)
    },

    /**
     * Add one image. `sha256` dedupe: an existing item with the same bytes has
     * its tags/desc merged instead of a second copy being written.
     * @param {{ buffer: Buffer|Uint8Array, ext: string, tags?: string[]|string, desc?: string, layer?: string, source?: object }} input
     * @returns {Promise<{ item: object, duplicate: boolean }>}
     */
    async addItem({ buffer, ext, tags, desc = '', layer = 'candidate', source } = {}) {
      return mutate(async () => {
        await ensureReady()
        const bytes = Buffer.isBuffer(buffer) ? buffer : buffer instanceof Uint8Array ? Buffer.from(buffer) : undefined
        if (bytes === undefined || bytes.length === 0) throw new Error('sticker buffer must be a non-empty Buffer')
        const targetLayer = assertLayer(layer)
        const targetExt = normalizeSupportedExt(ext)

        const hash = sha256Buffer(bytes)
        const id = hash.slice(0, ID_LENGTH)
        const now = Date.now()

        const existing = byHash.get(hash)
        if (existing !== undefined) {
          const nextTags = mergeTags(existing.tags, normalizeTags(tags))
          const wantedDesc = normalizeDesc(desc)
          const nextDesc = wantedDesc === '' ? existing.desc : wantedDesc
          const updated = { ...existing, tags: nextTags, desc: nextDesc, updatedAt: now }
          const nextItems = items.slice()
          nextItems[itemIndex(existing)] = updated
          await persistIndex(nextItems)
          commit(nextItems)
          return { item: clone(updated), duplicate: true }
        }

        if (byId.has(id)) throw new Error(`sticker id collision: ${id}`)

        const item = {
          id,
          hash,
          ext: targetExt,
          size: bytes.length,
          layer: targetLayer,
          tags: normalizeTags(tags),
          desc: normalizeDesc(desc),
          useCount: 0,
          createdAt: now,
          updatedAt: now
        }
        const normalizedSource = normalizeSource(source)
        if (normalizedSource !== undefined) item.source = normalizedSource

        const file = filePathOf(item)
        await writeBufferFile(file, bytes)
        const nextItems = items.concat([item])
        try {
          await persistIndex(nextItems)
        } catch (error) {
          await removeFile(file).catch(() => {})
          throw error
        }
        commit(nextItems)
        return { item: clone(item), duplicate: false }
      })
    },

    /**
     * Update tags / desc / layer. Moving to another layer moves the file.
     * Optional `useCount`/`createdAt`/`lastUsedAt`/`source` are accepted for
     * tooling (migration) and are ignored by the admin page.
     * @returns {Promise<object>} updated item
     */
    async update(id, patch = {}) {
      return mutate(async () => {
        await ensureReady()
        const current = byId.get(String(id))
        if (current === undefined) throw new Error(`sticker not found: ${id}`)
        return commitUpdated(current, patch ?? {})
      })
    },

    /** Increment useCount and remember when the sticker was last sent. */
    async recordUse(id) {
      return mutate(async () => {
        await ensureReady()
        const current = byId.get(String(id))
        if (current === undefined) throw new Error(`sticker not found: ${id}`)
        const updated = {
          ...current,
          useCount: (Number.isFinite(Number(current.useCount)) ? Math.floor(Number(current.useCount)) : 0) + 1,
          lastUsedAt: Date.now()
        }
        const nextItems = items.slice()
        nextItems[itemIndex(current)] = updated
        await persistIndex(nextItems)
        commit(nextItems)
        return clone(updated)
      })
    },

    /**
     * Pick a sticker matching `tags`. Full tag matches win, then the largest
     * number of matched tags; ties are resolved randomly with `rng`.
     * Only `library` is used unless `config.stickers.libraryOnly === false`
     * (then `candidate` is included too). Returns `null` when nothing matches.
     * @param {{ tags?: string[]|string, rng?: () => number }} [input]
     */
    async pick({ tags, rng = Math.random } = {}) {
      await ensureReady()
      const config = configStore?.get?.() ?? {}
      const libraryOnly = config?.stickers?.libraryOnly !== false
      const layers = libraryOnly ? new Set(['library']) : new Set(['library', 'candidate'])
      const pool = items.filter((item) => layers.has(item.layer))
      if (pool.length === 0) return null
      const random = typeof rng === 'function' ? rng : Math.random
      const choose = (list) => {
        const roll = Number(random())
        const normalized = Number.isFinite(roll) ? Math.min(0.999999999, Math.max(0, roll)) : 0
        return clone(list[Math.floor(normalized * list.length)])
      }
      const wanted = normalizeTags(tags)
      if (wanted.length === 0) return choose(pool)

      const fullMatches = []
      let bestMatches = []
      let bestCount = 0
      for (const item of pool) {
        let matched = 0
        for (const wantedTag of wanted) {
          if (item.tags.some((tag) => sameTag(tag, wantedTag))) matched += 1
        }
        if (matched === 0) continue
        if (matched === wanted.length) fullMatches.push(item)
        if (matched > bestCount) {
          bestCount = matched
          bestMatches = [item]
        } else if (matched === bestCount) {
          bestMatches.push(item)
        }
      }
      if (fullMatches.length > 0) return choose(fullMatches)
      if (bestMatches.length > 0) return choose(bestMatches)
      return null
    },

    /**
     * Tag catalogue for the admin page / prompt. `layer` is an extension used
     * by the selector to restrict counts to `library`.
     * @param {{ maxTags?: number, layer?: string|string[] }} [options]
     */
    async catalog({ maxTags, layer } = {}) {
      await ensureReady()
      const scoped =
        layer === undefined
          ? items
          : items.filter((item) => (Array.isArray(layer) ? layer.includes(item.layer) : item.layer === layer))
      const counts = new Map()
      for (const item of scoped) {
        for (const tag of item.tags) {
          const key = tag.toLowerCase()
          const entry = counts.get(key)
          if (entry === undefined) counts.set(key, { tag, count: 1 })
          else entry.count += 1
        }
      }
      const configuredMax = configStore?.get?.()?.stickers?.maxCatalogTags
      const effectiveMax = maxTags === undefined ? Number(configuredMax) : Number(maxTags)
      let tagList = Array.from(counts.values()).sort((a, b) => b.count - a.count)
      if (Number.isFinite(effectiveMax) && effectiveMax > 0) tagList = tagList.slice(0, Math.floor(effectiveMax))
      return {
        total: scoped.length,
        tags: tagList,
        tagTotal: counts.size,
        byLayer: layerCounts()
      }
    },

    /** @returns {Promise<{ total: number, byLayer: object, tags: number }>} */
    async stats() {
      await ensureReady()
      const distinct = new Set()
      for (const item of items) {
        for (const tag of item.tags) distinct.add(tag.toLowerCase())
      }
      return { total: items.length, byLayer: layerCounts(), tags: distinct.size }
    },

    /**
     * Absolute path of the image file for an item (or item id).
     * The file itself may not exist (broken/migrated data), the path is still returned.
     */
    filePath(item) {
      const target = typeof item === 'string' ? byId.get(item) : item
      if (target === null || target === undefined || typeof target !== 'object') {
        throw new Error(`sticker not found: ${typeof item === 'string' ? item : ''}`)
      }
      return filePathOf(target)
    },

    /** Move a sticker to `trash` (restorable). @returns {Promise<object>} */
    async remove(id) {
      return mutate(async () => {
        await ensureReady()
        const current = byId.get(String(id))
        if (current === undefined) throw new Error(`sticker not found: ${id}`)
        if (current.layer === 'trash') return clone(current)
        return commitUpdated(current, { layer: 'trash' })
      })
    },

    /** Move a trashed sticker back to `candidate`. @returns {Promise<object>} */
    async restore(id) {
      return mutate(async () => {
        await ensureReady()
        const current = byId.get(String(id))
        if (current === undefined) throw new Error(`sticker not found: ${id}`)
        if (current.layer !== 'trash') return clone(current)
        return commitUpdated(current, { layer: 'candidate' })
      })
    },

    /** Delete a sticker from disk and index forever. @returns {Promise<{ id: string, removed: boolean }>} */
    async purge(id) {
      return mutate(async () => {
        await ensureReady()
        const current = byId.get(String(id))
        if (current === undefined) return { id: String(id), removed: false }
        const file = filePathOf(current)
        const nextItems = items.filter((item) => item !== current)
        await persistIndex(nextItems)
        commit(nextItems)
        await removeFile(file).catch((error) => {
          logger?.warn?.('表情包文件删除失败', { id: current.id, file, error: error?.message })
        })
        return { id: current.id, removed: true }
      })
    },

    /** Wait until every queued mutation has been persisted. */
    async flush() {
      await ensureReady()
      await queue
    }
  }

  function layerCounts() {
    const byLayer = { library: 0, candidate: 0, negative: 0, trash: 0 }
    for (const item of items) {
      if (byLayer[item.layer] !== undefined) byLayer[item.layer] += 1
    }
    return byLayer
  }

  return api
}
