#!/usr/bin/env node
/**
 * 批量导入表情包命令行工具。
 *
 * 用法：
 *   node tools/sticker-import.mjs <目录> [--tags "无语,敷衍"] [--layer candidate|library] [--desc "描述"]
 *
 * 复用 host/stickers/importer.js：按文件内容（魔数）识别图片格式、SHA-256 去重，
 * 写入插件 data/stickers/。只依赖 node:* 内置模块。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createPaths } from '../host/paths.js'
import { loadConfig } from '../host/config.js'
import { createLogger } from '../host/util/log.js'
import { normalizeTags } from '../host/util/text.js'
import { createStickerStore } from '../host/stickers/store.js'
import { createStickerImporter } from '../host/stickers/importer.js'

const CLI_NAME = 'node tools/sticker-import.mjs'
const VALID_LAYERS = ['candidate', 'library']

const HELP = `qqbot 表情包批量导入工具

用法：
  ${CLI_NAME} <目录> [选项]

选项：
  --tags "无语,敷衍"      给本次导入的表情包统一打标签
                          （逗号、顿号、分号分隔，可重复指定多次以累加）
  --layer <图层>          导入到哪个图层：candidate（默认，待审核）或 library（正式可用）
  --desc "描述"           统一填写描述文本
  --help, -h              显示本帮助

说明：
  - 支持 jpg / jpeg / png / gif / webp / bmp，按文件内容魔数识别，扩展名仅作参考
  - 内容相同（SHA-256）的图片不会重复导入，只会合并这次的标签/描述
  - 数据默认写入 <插件目录>/data/stickers/，可用环境变量 QQBOT_DATA_DIR 覆盖
  - 目录会递归扫描，子目录里的图片同样会导入

示例：
  ${CLI_NAME} ./import
  ${CLI_NAME} ./import --tags "无语,敷衍" --layer library
  ${CLI_NAME} D:\\表情包 --tags "可爱" --desc "来源：群聊收集"
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
  const options = { dir: '', tags: [], layer: 'candidate', desc: '', help: false, errors: [] }
  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      index += 1
      continue
    }
    if (arg === '--tags' || arg.startsWith('--tags=')) {
      const { value, next, missing } = takeValue(argv, index, '--tags')
      index = next
      if (missing !== undefined || value === undefined) {
        options.errors.push('--tags 缺少值，例如 --tags "无语,敷衍"')
        continue
      }
      options.tags.push(value)
      continue
    }
    if (arg === '--layer' || arg.startsWith('--layer=')) {
      const { value, next, missing } = takeValue(argv, index, '--layer')
      index = next
      if (missing !== undefined || value === undefined) {
        options.errors.push('--layer 缺少值（candidate 或 library）')
        continue
      }
      options.layer = value.trim().toLowerCase()
      continue
    }
    if (arg === '--desc' || arg.startsWith('--desc=')) {
      const { value, next, missing } = takeValue(argv, index, '--desc')
      index = next
      if (missing !== undefined || value === undefined) {
        options.errors.push('--desc 缺少值')
        continue
      }
      options.desc = value
      continue
    }
    if (arg.startsWith('-')) {
      options.errors.push(`未知选项：${arg}`)
      index += 1
      continue
    }
    if (options.dir === '') {
      options.dir = arg
      index += 1
      continue
    }
    options.errors.push(`多余的参数：${arg}`)
    index += 1
  }
  if (!VALID_LAYERS.includes(options.layer)) {
    options.errors.push(`--layer 只能是 candidate 或 library，收到：${options.layer}`)
  }
  return options
}

function printDetails(result) {
  const limit = 10
  if (result.skipped.length > 0) {
    console.log('  跳过的文件：')
    for (const entry of result.skipped.slice(0, limit)) {
      console.log(`    - ${path.basename(entry.path || entry.name || '')}：${entry.reason}`)
    }
    if (result.skipped.length > limit) console.log(`    …还有 ${result.skipped.length - limit} 个`)
  }
  if (result.errors.length > 0) {
    console.log('  失败的文件：')
    for (const entry of result.errors.slice(0, limit)) {
      console.log(`    - ${path.basename(entry.path || entry.name || '')}：${entry.error}`)
    }
    if (result.errors.length > limit) console.log(`    …还有 ${result.errors.length - limit} 个`)
  }
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
  if (options.dir === '') {
    console.error('错误：缺少要导入的目录参数。')
    console.error(`用法：${CLI_NAME} <目录> [--tags "无语,敷衍"] [--layer candidate|library] [--desc "描述"]`)
    console.error(`使用 ${CLI_NAME} --help 查看完整帮助。`)
    return 1
  }

  const dir = path.resolve(options.dir)
  let stat
  try {
    stat = fs.statSync(dir)
  } catch {
    console.error(`错误：导入目录不存在：${dir}`)
    return 1
  }
  if (!stat.isDirectory()) {
    console.error(`错误：不是目录：${dir}`)
    return 1
  }

  const paths = createPaths()
  paths.ensure()
  const logger = createLogger({ file: paths.logFile, maxLines: 500 })
  const { config } = await loadConfig(paths, logger)
  const configStore = { get: () => config }
  const stickerStore = createStickerStore({ paths, configStore, logger })
  await stickerStore.init()
  const importer = createStickerImporter({ paths, configStore, stickerStore, logger })

  // Each --tags occurrence may itself contain a delimited list ("无语,敷衍").
  const tags = normalizeTags(options.tags.join(','))

  console.log(`开始导入：${dir}`)
  console.log(`  目标图层：${options.layer}`)
  if (tags.length > 0) console.log(`  标签：${tags.join(',')}`)
  if (options.desc !== '') console.log(`  描述：${options.desc}`)

  const result = await importer.importDirectory({
    dir,
    tags,
    desc: options.desc,
    layer: options.layer
  })
  await stickerStore.flush()
  await logger.flush()

  console.log('导入完成：')
  console.log(`  扫描文件：${result.scanned} 个`)
  console.log(`  新增：${result.added.length} 个`)
  console.log(`  重复（内容相同，已合并标签/描述）：${result.duplicates.length} 个`)
  console.log(`  跳过：${result.skipped.length} 个`)
  console.log(`  失败：${result.errors.length} 个`)
  printDetails(result)
  console.log(`  数据目录：${paths.stickers}`)
  return result.errors.length > 0 ? 1 : 0
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(`导入失败：${error?.message ?? error}`)
    process.exitCode = 1
  })
