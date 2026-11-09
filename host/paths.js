/**
 * Filesystem layout for the qqbot plugin.
 *
 * Everything the plugin owns lives under this package directory by default:
 *   <package>/data/...   runtime data (config, chats, memory, stickers, budget, logs)
 *   <package>/import/    drop zone for batch sticker import
 *
 * The two directories can be redirected with QQBOT_DATA_DIR / QQBOT_IMPORT_DIR
 * for tests or for users who insist on keeping data elsewhere.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

function resolveFromEnv(envName, fallback) {
  const value = process.env[envName]
  return typeof value === 'string' && value.trim() !== '' ? path.resolve(value) : fallback
}

/**
 * Build the path table used by every module. The returned object is a plain
 * frozen value; call `ensure()` once at startup to create the directories.
 */
export function createPaths({ packageRoot = PACKAGE_ROOT } = {}) {
  const base = path.resolve(packageRoot)
  const data = resolveFromEnv('QQBOT_DATA_DIR', path.join(base, 'data'))
  const importDir = resolveFromEnv('QQBOT_IMPORT_DIR', path.join(base, 'import'))
  const stickers = path.join(data, 'stickers')

  const paths = {
    packageRoot: base,
    base,
    data,
    configFile: path.join(data, 'config.json'),
    importDir,
    budget: path.join(data, 'budget'),
    budgetUsage: path.join(data, 'budget', 'usage.json'),
    budgetEvents: path.join(data, 'budget', 'events.jsonl'),
    chats: path.join(data, 'chats'),
    people: path.join(data, 'people'),
    peopleImport: path.join(data, 'people-import'),
    personas: path.join(data, 'personas.json'),
    stickers,
    stickerIndex: path.join(data, 'stickers', 'index.json'),
    stickerLibrary: path.join(data, 'stickers', 'library'),
    stickerCandidate: path.join(data, 'stickers', 'candidate'),
    stickerNegative: path.join(data, 'stickers', 'negative'),
    stickerTrash: path.join(data, 'stickers', 'trash'),
    logs: path.join(data, 'logs'),
    logFile: path.join(data, 'logs', 'qqbot.log'),
    stats: path.join(data, 'stats.json')
  }

  /** Directories that must exist before the plugin starts. */
  paths.requiredDirs = [
    paths.data,
    paths.importDir,
    paths.budget,
    paths.chats,
    paths.people,
    paths.stickers,
    paths.stickerLibrary,
    paths.stickerCandidate,
    paths.stickerNegative,
    paths.stickerTrash,
    paths.logs
  ]

  /** Map a sticker layer to its directory. */
  paths.stickerLayerDir = (layer) => {
    switch (layer) {
      case 'library':
        return paths.stickerLibrary
      case 'candidate':
        return paths.stickerCandidate
      case 'negative':
        return paths.stickerNegative
      case 'trash':
        return paths.stickerTrash
      default:
        return undefined
    }
  }

  /** Directory that stores one chat's history/summary/memory files. */
  paths.chatDir = (chatId) => path.join(paths.chats, encodeURIComponent(String(chatId)))

  paths.ensure = () => {
    for (const dir of paths.requiredDirs) fs.mkdirSync(dir, { recursive: true })
    return paths
  }

  return Object.freeze(paths)
}
