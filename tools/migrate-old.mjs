#!/usr/bin/env node
/**
 * 一次性迁移工具：旧版 dshqqbot 表情包 → 本插件 data/stickers。
 *
 * 默认 dry-run（只读预览，不写任何文件）；只有传 --apply 才会写入本插件数据目录。
 * 旧版数据永远只读：本工具只从旧目录 readFileSync / readdirSync / statSync，
 * 所有写入都指向 <插件>/data/（可用 QQBOT_DATA_DIR 或 --data 覆盖）。
 *
 * 旧数据布局（只读参考）：
 *   <old>/表情包/index.json          {version:1, items:[{id,hash,ext,layer,tags,desc,...}]}
 *   <old>/表情包/lib/<layer>/<id>.<ext>
 *   <old>/.qqbot/people/*.md        人物小传，可选用 --people 导出到 data/people-import/
 */
import fs from 'node:fs'
import path from 'node:path'
import { createPaths } from '../host/paths.js'
import { loadConfig } from '../host/config.js'
import { createLogger } from '../host/util/log.js'
import { normalizeTags } from '../host/util/text.js'
import { createStickerStore } from '../host/stickers/store.js'
import { detectImageExt } from '../host/stickers/importer.js'

const CLI_NAME = 'node tools/migrate-old.mjs'
const DEFAULT_OLD_ROOT = path.resolve(process.cwd(), 'qq-robot', 'dshqqbot')
const LAYERS = ['library', 'candidate', 'negative', 'trash']
const OLD_STICKER_DIRNAME = '表情包'
const MAX_DESC_LENGTH = 2000

const HELP = `qqbot 旧版数据迁移工具（默认预览 dry-run，不写任何文件）

用法：
  ${CLI_NAME} [选项]

选项：
  --old <路径>     旧版插件数据目录，默认 ${DEFAULT_OLD_ROOT}
  --apply          真正执行迁移（不传时只预览，不会修改本插件数据）
  --people         同时把旧版 .qqbot/people/*.md 导出到 data/people-import/
  --data <路径>    本插件数据目录（等价于设置环境变量 QQBOT_DATA_DIR）
  --dry-run        只预览（默认行为，显式指定更清楚）
  --help, -h       显示本帮助

说明：
  - 旧版数据只读，本工具不会修改、移动或删除旧目录里的任何文件
  - 迁移后按内容 SHA-256 去重；已存在的图片只合并标签/描述，不重复写文件
  - 旧版标签、描述、使用次数、创建/最近使用时间、来源用户与会话都会尽量保留
  - 旧版 lib/<layer>/<id>.<ext> 会复制到 data/stickers/<layer>/<新id>.<ext>
  - 建议先不带 --apply 预览，确认统计无误后再加 --apply

示例：
  ${CLI_NAME}
  ${CLI_NAME} --apply
  ${CLI_NAME} --apply --people
  ${CLI_NAME} --old path/to/old-dshqqbot --apply --data path/to/qqbot-data
`

function takeValue(argv, index, name) {
  const arg = argv[index]
  const eq = arg.indexOf('=')
  if (eq !== -1) return { value: arg.slice(eq + 1), next: index + 1 }
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) return { value: undefined, next: index + 1, missing: name }
  return { value, next: index + 2 }
}

function parseArgs(argv) {
  const options = { old: DEFAULT_OLD_ROOT, apply: false, people: false, dataDir: '', help: false, errors: [] }
  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      index += 1
      continue
    }
    if (arg === '--apply') {
      options.apply = true
      index += 1
      continue
    }
    if (arg === '--people' || arg === '--with-people') {
      options.people = true
      index += 1
      continue
    }
    if (arg === '--dry-run') {
      options.apply = false
      index += 1
      continue
    }
    if (arg === '--old' || arg.startsWith('--old=')) {
      const { value, next, missing } = takeValue(argv, index, '--old')
      index = next
      if (missing !== undefined || value === undefined) {
        options.errors.push('--old 缺少路径')
        continue
      }
      options.old = value
      continue
    }
    if (arg === '--data' || arg.startsWith('--data=')) {
      const { value, next, missing } = takeValue(argv, index, '--data')
      index = next
      if (missing !== undefined || value === undefined) {
        options.errors.push('--data 缺少路径')
        continue
      }
      options.dataDir = value
      continue
    }
    options.errors.push(`未知选项：${arg}`)
    index += 1
  }
  return options
}

function toEpoch(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.floor(number)
}

function findOldFile(oldStickerDir, id) {
  if (id === '') return ''
  const libDir = path.join(oldStickerDir, 'lib')
  for (const layer of LAYERS) {
    const dir = path.join(libDir, layer)
    let names
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    const match = names.find((name) => name.startsWith(`${id}.`) && !name.endsWith('.tmp'))
    if (match !== undefined) return path.join(dir, match)
  }
  return ''
}

/** Read the first bytes of a file to detect its format without loading it fully. */
function sniffHeader(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(16)
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0)
    return detectImageExt(buffer.subarray(0, bytes))
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // ignore close errors
      }
    }
  }
}

function buildOldSource(raw) {
  const source = {}
  const senderId = typeof raw?.senderId === 'string' ? raw.senderId.trim() : ''
  const senderName = typeof raw?.senderName === 'string' ? raw.senderName.trim() : ''
  const groupId = typeof raw?.sourceGroup === 'string' ? raw.sourceGroup.trim() : ''
  if (groupId !== '') source.chatId = `group_${groupId}`
  else if (senderId !== '') source.chatId = `c2c_${senderId}`
  if (senderId !== '') source.userId = senderId
  if (senderName !== '') source.userName = senderName
  return source
}

function buildPlan(rawItems, oldStickerDir) {
  const entries = []
  for (const raw of rawItems) {
    const rawId = typeof raw?.id === 'string' ? raw.id.trim() : ''
    const indexLayer = LAYERS.includes(raw?.layer) ? raw.layer : 'candidate'
    const ext = String(raw?.ext ?? '')
      .trim()
      .toLowerCase()
      .replace(/^\./, '') || 'jpg'
    let file = ''
    if (rawId !== '') {
      const expected = path.join(oldStickerDir, 'lib', indexLayer, `${rawId}.${ext}`)
      file = fs.existsSync(expected) ? expected : findOldFile(oldStickerDir, rawId)
    }
    const entry = {
      rawId,
      id: rawId === '' ? '(无 id)' : rawId,
      layer: indexLayer,
      file,
      size: 0,
      format: undefined,
      tags: normalizeTags(raw?.tags),
      desc: String(raw?.desc ?? '').trim().slice(0, MAX_DESC_LENGTH),
      useCount: Number.isFinite(Number(raw?.useCount)) && Number(raw.useCount) > 0 ? Math.floor(Number(raw.useCount)) : 0,
      createdAt: toEpoch(raw?.capturedAt ?? raw?.firstSeenAt ?? raw?.createdAt),
      lastUsedAt: toEpoch(raw?.lastSeenAt ?? raw?.lastUsedAt),
      source: buildOldSource(raw),
      error: ''
    }
    if (rawId === '') entry.error = '旧索引条目缺少 id'
    else if (file === '') entry.error = '旧文件缺失'
    else {
      try {
        entry.size = fs.statSync(file).size
      } catch {
        entry.error = '旧文件无法读取'
      }
      if (entry.error === '') {
        const foundLayer = path.basename(path.dirname(file))
        if (LAYERS.includes(foundLayer)) entry.layer = foundLayer
        entry.format = sniffHeader(file)
        if (entry.format === undefined) entry.error = '不是支持的图片格式'
      }
    }
    entries.push(entry)
  }
  return entries
}

function listPeopleFiles(oldRoot) {
  const dir = path.join(oldRoot, '.qqbot', 'people')
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

function isInside(parentDir, childDir) {
  const parent = path.resolve(parentDir)
  const child = path.resolve(childDir)
  if (parent === child) return true
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function countBy(list, key) {
  const out = {}
  for (const entry of list) out[entry[key]] = (out[entry[key]] ?? 0) + 1
  return out
}

function formatLayers(counts) {
  return LAYERS.filter((layer) => counts[layer] !== undefined)
    .map((layer) => `${layer} ${counts[layer]}`)
    .join(' / ')
}

function printPreview({ options, oldRoot, oldIndexFile, rawItems, plan, peopleFiles }) {
  const okEntries = plan.filter((entry) => entry.error === '')
  const badEntries = plan.filter((entry) => entry.error !== '')
  const layerCounts = countBy(okEntries, 'layer')
  const formatCounts = countBy(
    okEntries.map((entry) => ({ format: entry.format ?? 'unknown' })),
    'format'
  )
  const totalBytes = okEntries.reduce((sum, entry) => sum + entry.size, 0)

  console.log(options.apply ? '=== 旧版数据迁移预览 ===' : '=== 旧版数据迁移预览（dry-run）===')
  console.log(`旧版目录：${oldRoot}`)
  console.log(`旧版索引：${oldIndexFile}（共 ${rawItems.length} 条）`)
  console.log(`可迁移：${okEntries.length} 条${okEntries.length > 0 ? `（${formatLayers(layerCounts)}）` : ''}`)
  if (okEntries.length > 0) {
    console.log(`  文件总大小：${(totalBytes / 1024).toFixed(1)} KB，格式：${Object.entries(formatCounts).map(([key, count]) => `${key} ${count}`).join(' / ')}`)
  }
  console.log(`无法迁移：${badEntries.length} 条`)
  for (const entry of badEntries.slice(0, 10)) {
    console.log(`  - ${entry.id}（${entry.layer}）：${entry.error}`)
  }
  if (badEntries.length > 10) console.log(`  …还有 ${badEntries.length - 10} 条`)
  if (options.people) {
    console.log(`人物摘要：${peopleFiles.length} 个 .md 文件 → 将导出到 data/people-import/`)
    for (const file of peopleFiles.slice(0, 10)) console.log(`  - ${path.basename(file)}`)
    if (peopleFiles.length > 10) console.log(`  …还有 ${peopleFiles.length - 10} 个`)
  } else {
    console.log(`人物摘要：${peopleFiles.length} 个 .md 文件（加 --people 可一并导出）`)
  }
  console.log('提示：重复内容会在 --apply 时按 SHA-256 自动合并，不会重复写入。')
}

async function applyMigration({ options, oldRoot, plan, peopleFiles }) {
  if (options.dataDir !== '') process.env.QQBOT_DATA_DIR = path.resolve(options.dataDir)
  const paths = createPaths()
  if (isInside(oldRoot, paths.data) || path.resolve(oldRoot) === path.resolve(paths.data)) {
    console.error(`错误：目标数据目录 ${paths.data} 位于旧版数据目录内，为避免修改旧数据已中止。`)
    return 1
  }
  paths.ensure()
  const logger = createLogger({ file: paths.logFile, maxLines: 500 })
  const { config } = await loadConfig(paths, logger)
  const configStore = { get: () => config }
  const store = createStickerStore({ paths, configStore, logger })
  await store.init()

  const summary = { imported: 0, duplicates: 0, failed: 0, people: 0, layers: {}, errors: [] }
  console.log(`\n开始迁移到：${paths.stickers}`)
  for (const entry of plan) {
    if (entry.error !== '') {
      summary.failed += 1
      summary.errors.push({ id: entry.id, error: entry.error })
      continue
    }
    try {
      const buffer = fs.readFileSync(entry.file)
      const ext = detectImageExt(buffer)
      if (ext === undefined) {
        summary.failed += 1
        summary.errors.push({ id: entry.id, error: '不是支持的图片格式' })
        continue
      }
      const { item, duplicate } = await store.addItem({
        buffer,
        ext,
        tags: entry.tags,
        desc: entry.desc,
        layer: entry.layer,
        source: entry.source
      })
      if (duplicate) {
        summary.duplicates += 1
      } else {
        summary.imported += 1
        summary.layers[entry.layer] = (summary.layers[entry.layer] ?? 0) + 1
        const patch = {}
        if (entry.useCount > 0) patch.useCount = entry.useCount
        if (entry.createdAt > 0) patch.createdAt = entry.createdAt
        if (entry.lastUsedAt > 0) patch.lastUsedAt = entry.lastUsedAt
        if (Object.keys(patch).length > 0) await store.update(item.id, patch)
      }
    } catch (error) {
      summary.failed += 1
      summary.errors.push({ id: entry.id, error: error?.message ?? String(error) })
    }
  }

  if (options.people && peopleFiles.length > 0) {
    const targetDir = path.join(paths.data, 'people-import')
    fs.mkdirSync(targetDir, { recursive: true })
    for (const file of peopleFiles) {
      const target = path.join(targetDir, path.basename(file))
      if (path.resolve(target) === path.resolve(file)) continue
      fs.copyFileSync(file, target)
      summary.people += 1
    }
    logger.info?.('已导出旧版人物摘要', { count: summary.people, dir: targetDir })
  }

  await store.flush()
  await logger.flush()

  console.log('\n=== 迁移完成 ===')
  console.log(`  写入成功：${summary.imported} 个${summary.imported > 0 ? `（${formatLayers(summary.layers)}）` : ''}`)
  console.log(`  重复（目标库已有相同内容，已合并标签/描述）：${summary.duplicates} 个`)
  console.log(`  失败：${summary.failed} 个`)
  if (options.people) {
    console.log(`  人物摘要：${summary.people} 个 .md → ${path.join(paths.data, 'people-import')}`)
  }
  for (const entry of summary.errors.slice(0, 10)) {
    console.log(`  - 失败 ${entry.id}：${entry.error}`)
  }
  if (summary.errors.length > 10) console.log(`  …还有 ${summary.errors.length - 10} 个失败`)
  console.log(`  表情包索引：${paths.stickerIndex}`)
  return summary.failed > 0 ? 1 : 0
}

async function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(HELP)
    return 0
  }
  if (options.errors.length > 0) {
    for (const message of options.errors) console.error(`错误：${message}`)
    console.error(`使用 ${CLI_NAME} --help 查看用法。`)
    return 1
  }

  const oldRoot = path.resolve(options.old)
  const oldStickerDir = path.join(oldRoot, OLD_STICKER_DIRNAME)
  const oldIndexFile = path.join(oldStickerDir, 'index.json')
  if (!fs.existsSync(oldIndexFile)) {
    console.error(`错误：找不到旧版表情包索引：${oldIndexFile}`)
    console.error('请用 --old 指定旧版插件数据目录（包含「表情包」子目录）。')
    return 1
  }
  let oldIndex
  try {
    oldIndex = JSON.parse(fs.readFileSync(oldIndexFile, 'utf8'))
  } catch (error) {
    console.error(`错误：旧版索引不是合法的 JSON：${oldIndexFile}`)
    console.error(`  ${error?.message ?? error}`)
    return 1
  }
  const rawItems = Array.isArray(oldIndex?.items) ? oldIndex.items : []
  if (rawItems.length === 0) {
    console.error(`错误：旧版索引里没有表情包条目：${oldIndexFile}`)
    return 1
  }

  const plan = buildPlan(rawItems, oldStickerDir)
  const peopleFiles = listPeopleFiles(oldRoot)
  printPreview({ options, oldRoot, oldIndexFile, rawItems, plan, peopleFiles })

  if (!options.apply) {
    console.log('\n这是预览（dry-run），没有写入任何文件。确认无误后加 --apply 执行迁移。')
    return 0
  }
  return applyMigration({ options, oldRoot, plan, peopleFiles })
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(`迁移失败：${error?.message ?? error}`)
    process.exitCode = 1
  })
