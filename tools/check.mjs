#!/usr/bin/env node
/**
 * Static gate for the qqbot bundle: syntax-check every JS module, validate the
 * JSON files and the bundle manifest, and assert required files exist.
 *
 * Usage: node tools/check.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const failures = []
const notes = []

function walk(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'data' || entry.name === 'tmp' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) out.push(full)
  }
}

const files = []
for (const dir of ['host', 'tools', 'tests']) walk(path.join(ROOT, dir), files)
files.push(path.join(ROOT, 'index.js'))

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failures.push(`语法错误：${path.relative(ROOT, file)}\n${result.stderr.trim()}`)
  }
}

const jsonFiles = [path.join(ROOT, 'package.json')]
for (const locale of ['en', 'zh']) jsonFiles.push(path.join(ROOT, 'locale', `${locale}.json`))
for (const file of jsonFiles) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    JSON.parse(raw)
  } catch (error) {
    failures.push(`JSON 无效：${path.relative(ROOT, file)}：${error.message}`)
  }
}

const required = [
  'package.json',
  'cordis.patch.yml',
  'index.js',
  'client.js',
  'icon.svg',
  'LICENSE',
  'README.md',
  'locale/en.json',
  'locale/zh.json',
  'host/index.js',
  'host/app.js',
  'host/config.js',
  'host/paths.js',
  'host/admin/routes.js',
  'host/admin/ui/index.html',
  'host/admin/ui/app.js',
  'host/admin/ui/style.css',
  'host/qq/api.js',
  'host/qq/gateway.js',
  'host/qq/inbound.js',
  'host/qq/outbound.js',
  'host/qq/index.js',
  'host/brain/llm.js',
  'host/brain/prompt.js',
  'host/brain/chat.js',
  'host/brain/commands.js',
  'host/vision/client.js',
  'host/vision/download.js',
  'host/memory/store.js',
  'host/memory/compress.js',
  'host/memory/extract.js',
  'host/budget/store.js',
  'host/persona/store.js',
  'host/stickers/store.js',
  'host/stickers/importer.js',
  'host/stickers/selector.js',
  'tools/sticker-import.mjs',
  'tools/migrate-old.mjs'
]
for (const relative of required) {
  if (!fs.existsSync(path.join(ROOT, relative))) failures.push(`缺少文件：${relative}`)
}

const manifestPath = path.join(ROOT, 'package.json')
if (fs.existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    for (const [key, value] of Object.entries(manifest.exports ?? {})) {
      const target = typeof value === 'string' ? value : undefined
      if (target !== undefined && !target.includes('*') && !fs.existsSync(path.join(ROOT, target))) {
        failures.push(`exports[${key}] 指向不存在的文件：${target}`)
      }
    }
    const patch = manifest.dsh?.bundle?.patch
    if (typeof patch !== 'string' || !fs.existsSync(path.join(ROOT, patch))) {
      failures.push('package.json 的 dsh.bundle.patch 不存在')
    }
    const icon = manifest.exports?.['./icon']
    if (typeof icon !== 'string' || !fs.existsSync(path.join(ROOT, icon))) {
      failures.push('package.json 缺少有效的 ./icon 导出')
    }
  } catch {
    // already reported above
  }
}

const importDir = path.join(ROOT, 'import')
if (!fs.existsSync(importDir)) {
  notes.push('import/ 目录不存在（首次运行时会自动创建，建议保留）')
}

if (failures.length > 0) {
  console.error(`✗ qqbot 静态检查失败（${failures.length} 项）`)
  for (const failure of failures) console.error(`\n- ${failure}`)
  process.exit(1)
}
console.log(`✓ qqbot 静态检查通过：${files.length} 个 JS 文件语法正常，${jsonFiles.length} 个 JSON 有效，${required.length} 个必需文件齐全`)
for (const note of notes) console.log(`  note: ${note}`)
