/**
 * Sticker selector.
 *
 * Turns the sticker store into the three operations the chat flow needs:
 *   - pickForReply(tags)        explicit `[[sticker: 标签]]` directives
 *   - catalogText()             compact tag catalogue for the system prompt
 *   - maybeStickerFromText(txt) probabilistic sticker when the reply mentions a tag
 */
import { normalizeTags } from '../util/text.js'

/** Text form of the catalog: `无语(3)、敷衍(2)`. */
function formatCatalog(tags) {
  return tags.map((entry) => `${entry.tag}(${entry.count})`).join('、')
}

function containsTag(text, tag) {
  const needle = String(tag ?? '').trim()
  if (needle === '') return false
  return text.toLowerCase().includes(needle.toLowerCase())
}

/**
 * @param {{ stickerStore: object, configStore: { get(): object }, logger?: object }} deps
 */
export function createStickerSelector({ stickerStore, configStore, logger } = {}) {
  if (!stickerStore || typeof stickerStore.pick !== 'function') throw new Error('createStickerSelector 需要 stickerStore')

  function config() {
    return configStore?.get?.() ?? {}
  }

  function enabled() {
    return config()?.stickers?.enabled !== false
  }

  /**
   * Resolve explicit reply tags. Tries the full tag set first, then relaxes to
   * every single tag in turn (first hit wins). No tags means "pick anything".
   * @param {string[]|string} tags
   * @returns {Promise<object|null>} StickerItem or null
   */
  async function pickForReply(tags) {
    if (!enabled()) return null
    const wanted = normalizeTags(tags)
    if (wanted.length === 0) {
      const any = await stickerStore.pick({ tags: [] })
      return any ?? null
    }
    const strict = await stickerStore.pick({ tags: wanted })
    if (strict !== null && strict !== undefined) return strict
    for (const tag of wanted) {
      const relaxed = await stickerStore.pick({ tags: [tag] })
      if (relaxed !== null && relaxed !== undefined) return relaxed
    }
    return null
  }

  /**
   * Prompt catalogue built from `library` only. Returns `''` for an empty or
   * disabled sticker library.
   * @returns {Promise<string>}
   */
  async function catalogText() {
    if (!enabled()) return ''
    let catalog
    try {
      catalog = await stickerStore.catalog({ layer: 'library' })
    } catch (error) {
      logger?.warn?.('生成表情包目录失败', { error: error?.message })
      return ''
    }
    const tags = Array.isArray(catalog?.tags) ? catalog.tags : []
    if (tags.length === 0) return ''
    const configuredMax = Number(config()?.stickers?.maxCatalogTags)
    const limited = Number.isFinite(configuredMax) && configuredMax > 0 ? tags.slice(0, Math.floor(configuredMax)) : tags
    if (limited.length === 0) return ''
    return formatCatalog(limited)
  }

  /**
   * With probability `config.persona.stickerChance` (fallback
   * `config.stickers.replyChance`), return a random library sticker whose tag
   * appears in `text`; otherwise `null`.
   * @param {string} text
   * @param {() => number} [rng]
   * @returns {Promise<object|null>}
   */
  async function maybeStickerFromText(text, rng = Math.random) {
    if (!enabled()) return null
    const content = String(text ?? '')
    if (content.trim() === '') return null
    const chanceRaw = config()?.persona?.stickerChance ?? config()?.stickers?.replyChance ?? 0
    const chance = Number(chanceRaw)
    if (!Number.isFinite(chance) || chance <= 0) return null
    const random = typeof rng === 'function' ? rng : Math.random
    let roll
    try {
      roll = Number(random())
    } catch {
      roll = 1
    }
    if (!(roll < chance)) return null

    let listing
    try {
      listing = await stickerStore.list({ layer: 'library', limit: 0 })
    } catch (error) {
      logger?.warn?.('读取表情包库失败', { error: error?.message })
      return null
    }
    const matched = []
    for (const item of Array.isArray(listing?.items) ? listing.items : []) {
      const tags = Array.isArray(item.tags) ? item.tags : []
      if (tags.some((tag) => containsTag(content, tag))) matched.push(item)
    }
    if (matched.length === 0) return null
    const pickRoll = Number(random())
    const normalized = Number.isFinite(pickRoll) ? Math.min(0.999999999, Math.max(0, pickRoll)) : 0
    return matched[Math.floor(normalized * matched.length)]
  }

  return { pickForReply, catalogText, maybeStickerFromText }
}
