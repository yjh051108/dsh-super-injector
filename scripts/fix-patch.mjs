#!/usr/bin/env node
/**
 * dsh-super-injector — profile patch 修复器（零依赖，独立运行）。
 *
 * 用途：dsh 启动崩溃且报 `duplicate loader entry id: <xxx>` 时，说明
 * ~/.dsh/profiles/<profile>/cordis.patch.yml 里存在重复 id 条目（手动 patch
 * 两次 / 重复安装 / 多路径写入造成）。此时注入器自身无法启动，只有本脚本
 * 能救——它不依赖 dsh，也不依赖任何 npm 包，node 直接跑。
 *
 * 行为：
 *  1. 扫描所有 profile 的 cordis.patch.yml（或 --profile 指定一个）；
 *  2. 按顶层/嵌套条目分桶去重（同 id 保留最后一条；注释保留；顶层 [] 清理）；
 *  3. 修复前自动备份为 cordis.patch.yml.bak-<时间戳>；
 *  4. 输出每处修复（哪个 profile、哪个 id 重复、删了几条）。
 *
 * 用法：
 *  node scripts/fix-patch.mjs                 # 修复全部 profile
 *  node scripts/fix-patch.mjs --profile web   # 只修 web profile
 *  node scripts/fix-patch.mjs --check         # 只检查不写（退出码 0=健康 1=有重复）
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const onlyProfile = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : null
const checkOnly = args.includes('--check')

/** 切分 patch 内容为条目块（`- id:` 及其子行 + 前置注释），返回块列表与杂散行。
 * 顶层条目只认第 0 列的 `- id:`；缩进的 `- id:`（insert 子条目 / group config
 * 子条目）打 fromInsert 标记，去重时与顶层分桶——避免把同 id 的顶层 config 块
 * （如 dsh-vision 的 baseURL/model）误当重复删掉（2026-08-15 事故）。 */
function extractBlocks(content) {
  const lines = content.split('\n')
  const blocks = []
  let current = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') {
      if (current) current.text += '\n' + line
      continue
    }
    const atCol0 = line[0] !== ' ' && line[0] !== '\t'
    const idMatch = /^-\s+id:\s*([^\s#]+)/.exec(line)
    if (atCol0 && idMatch) {
      if (current) blocks.push(current)
      current = { id: idMatch[1], fromInsert: false, text: line }
    } else if (idMatch) {
      // 缩进 `- id:`：insert/group 的嵌套子条目，去重时与顶层分桶
      if (current) blocks.push(current)
      current = { id: idMatch[1], fromInsert: true, text: line }
    } else if (atCol0) {
      if (current) blocks.push(current)
      current = null
      if (!/^\s*\[\]\s*$/.test(trimmed)) blocks.push({ id: undefined, text: line })
    } else if (current) {
      current.text += '\n' + line
    } else if (trimmed !== '' && !/^\s*#/.test(trimmed)) {
      blocks.push({ id: undefined, text: line })
    }
  }
  if (current) blocks.push(current)
  return blocks
}

/** 去重：顶层与嵌套分桶、同 id 保留最后一条（与 loader 顺序覆盖语义一致）；
 * 返回 {text, removed:[{id, fromInsert, count}]}。 */
function dedupe(content) {
  const blocks = extractBlocks(content)
  const keyOf = (b) => (b.fromInsert ? 'nested:' : 'top:') + b.id
  const counts = new Map()
  for (const b of blocks) {
    if (!b.id) continue
    const k = keyOf(b)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const removed = []
  for (const [k, n] of counts) {
    if (n > 1) {
      const sep = k.indexOf(':')
      removed.push({ id: k.slice(sep + 1), fromInsert: k.startsWith('nested:'), count: n - 1 })
    }
  }
  if (removed.length === 0) return { text: content, removed }
  // 保留最后一条：倒序遍历，从尾部看首次出现者保留
  const seen = new Set()
  const kept = []
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.id) {
      const k = keyOf(b)
      if (seen.has(k)) continue
      seen.add(k)
    }
    kept.unshift(b.text)
  }
  return { text: kept.join('\n'), removed }
}

function fixFile(patchFile) {
  let content
  try {
    content = readFileSync(patchFile, 'utf8')
  } catch {
    return { ok: false, error: '读取失败（跳过）' }
  }
  const { text, removed } = dedupe(content)
  if (removed.length === 0) return { ok: true, clean: true, removed: [] }
  if (!checkOnly) {
    const bak = patchFile + '.bak-' + Date.now()
    try {
      mkdirSync(dirname(patchFile), { recursive: true })
      renameSync(patchFile, bak)
      // 末尾补回单个换行，保持文件以换行结尾
      writeFileSync(patchFile, text.replace(/\s*$/, '') + '\n', 'utf8')
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e), removed }
    }
  }
  return { ok: true, clean: false, removed, backup: checkOnly ? undefined : patchFile + '.bak-*' }
}

function main() {
  const profilesRoot = join(homedir(), '.dsh', 'profiles')
  let profileDirs = []
  try {
    profileDirs = readdirSync(profilesRoot).filter((d) => !d.startsWith('.'))
  } catch {
    console.error('未找到 profiles 目录: ' + profilesRoot)
    process.exit(2)
  }
  if (onlyProfile) profileDirs = profileDirs.filter((d) => d === onlyProfile)
  if (profileDirs.length === 0) {
    console.error(checkOnly ? '未找到 profile: ' + onlyProfile : '未找到任何 profile')
    process.exit(2)
  }

  let foundAny = false
  let fixedAny = false
  for (const profile of profileDirs) {
    const patchFile = join(profilesRoot, profile, 'cordis.patch.yml')
    if (!existsSync(patchFile)) continue
    const r = fixFile(patchFile)
    if (r.error) {
      console.log(`[${profile}] cordis.patch.yml ${r.error}`)
      continue
    }
    foundAny = true
    if (r.clean) {
      console.log(`[${profile}] 健康：无重复 id`)
      continue
    }
    fixedAny = true
    for (const rec of r.removed) {
      console.log(`[${profile}] 修复：${rec.fromInsert ? '嵌套条目 ' : ''}id "${rec.id}" 重复，删除 ${rec.count} 条（保留最后一条）`)
    }
    if (!checkOnly) console.log(`[${profile}] 已重写（原文件备份为 ${patchFile}.bak-<时间戳>）`)
  }
  if (!foundAny) {
    console.log('未找到任何 cordis.patch.yml（全部 profile 都是全新未 patch？）')
    process.exit(0)
  }
  if (checkOnly) {
    process.exit(fixedAny ? 1 : 0)
  }
  console.log(fixedAny ? '\n✅ 修复完成，现在可以重新启动 dsh' : '\n✅ 无需修复')
}

main()
