#!/usr/bin/env node
/**
 * Self-contained build for git/path dependency installs (package.json `prepare`).
 *
 * npm/pnpm run `prepare` automatically when a `github:`/`git+` dependency is
 * installed, which is exactly the case that previously failed with
 * "Cannot find module ...\lib\index.js": the fetched repo has no build output
 * and scripts/build.sh demanded DSH_CHECKOUT. This script builds the
 * self-contained `lib/` (host + client bundles) with the already-committed
 * tsdown.config.ts — no DSH_CHECKOUT, no source checkout needed.
 *
 * Strategy:
 *   1. Use a locally installed tsdown (devDependency, installed for git deps
 *      by npm/pnpm) when available.
 *   2. Otherwise fall back to `npx --yes tsdown` (downloads on first use).
 *
 * Failing loudly on build errors is intentional: an install that ends with a
 * broken lib/ is worse than one that stops with a clear message.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// prepare.mjs lives in scripts/, so the package root is one level up.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TSDOWN_RANGE = 'tsdown@^0.22.14'
const REQUIRED = ['lib/index.js', 'lib/client.js']

/**
 * ★★★ **发布面脱敏：把构建机上的绝对路径换成 `<HOME>` 占位**（2026-09-19）
 *
 * 【为什么必须有这一步】`tsdown` 会把 bundle 进去的依赖写成
 * `//#region C:/Users/<构建机用户名>/AppData/.../node_modules/…` 这类**注释**，
 * 并在 `.map` 的 `sources` 里写同样的绝对路径
 * ⇒ ★★ **那会把【构建机的用户名】带进发布件** —— 而它是**别人的机器上毫无用处的隐私** ❌
 * ⇒ ⚠️ **实测**：`v0.3.4` 那份已发布的 tgz 里 `lib/index.js` 命中【构建机用户名】11 处
 *
 * 【判据】① 产物里**不再出现构建机的用户目录**（`C:/Users/<名>/` · `/home/<名>/` · `/Users/<名>/`）
 *        ② ★ **运行时不依赖这些注释**（它们是 `//#region` 注释与 sourcemap 的 `sources`）
 *        ③ ★★ **替换后 `node --check lib/index.js` 仍 exit=0**（**证明没改坏语法**）
 */
const HOME_PATH_RE = /(?:[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+[\\/]|\/(?:home|Users)\/[^/\s"']+\/)/g

function scrubBuildPaths() {
  const targets = ['lib/index.js', 'lib/client.js', 'lib/index.js.map', 'lib/client.js.map']
  let total = 0
  for (const rel of targets) {
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) continue
    const before = readFileSync(abs, 'utf8')
    const hits = (before.match(HOME_PATH_RE) ?? []).length
    if (hits === 0) { console.log(`[prepare] scrub ${rel}: 无绝对路径 ✓`); continue }
    const after = before.replace(HOME_PATH_RE, '<HOME>/')
    writeFileSync(abs, after, 'utf8')
    total += hits
    console.log(`[prepare] scrub ${rel}: 替换 ${hits} 处构建机绝对路径`)
  }
  // 判据①：替换后再扫一遍，必须为 0
  let left = 0
  for (const rel of targets) {
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) continue
    left += (readFileSync(abs, 'utf8').match(HOME_PATH_RE) ?? []).length
  }
  if (left > 0) {
    console.error(`[prepare] ✗ 脱敏后仍有 ${left} 处构建机路径 ⇒ 发布件不干净`)
    return false
  }
  console.log(`[prepare] ✓ 脱敏完成（共替换 ${total} 处）`)
  return true
}

function verifySyntax() {
  const hosts = ['lib/index.js', 'lib/client.js'].filter((r) => existsSync(join(ROOT, r)))
  for (const rel of hosts) {
    const r = spawnSync(process.execPath, ['--check', join(ROOT, rel)], { stdio: 'pipe' })
    if (r.status !== 0) {
      console.error(`[prepare] ✗ ${rel} 语法检查失败（脱敏改坏了？）`)
      console.error(String(r.stderr ?? '').split('\n').slice(0, 4).join('\n'))
      return false
    }
  }
  console.log('[prepare] ✓ node --check 通过（lib/index.js + lib/client.js）')
  return true
}

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) throw result.error
  return result.status
}

function localTsdownBin() {
  const bin = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsdown.cmd' : 'tsdown')
  return existsSync(bin) ? bin : undefined
}

function verifyOutputs() {
  for (const file of REQUIRED) {
    if (!existsSync(join(ROOT, file))) {
      return false
    }
  }
  return true
}

function main() {
  if (verifyOutputs()) {
    console.log('[prepare] lib/ already built — skipping tsdown run')
    // ★ 即使跳过构建，也要过脱敏与语法检查（**已构建的产物同样可能带路径**）
    if (!scrubBuildPaths()) return 1
    if (!verifySyntax()) return 1
    return 0
  }

  const bin = localTsdownBin()
  let status
  if (bin !== undefined) {
    console.log('[prepare] building with local tsdown')
    status = run(bin, ['--config', 'tsdown.config.ts'])
  } else {
    console.log(`[prepare] local tsdown not found — fetching ${TSDOWN_RANGE} via npx (first install only)`)
    status = run('npx', ['--yes', TSDOWN_RANGE, '--config', 'tsdown.config.ts'])
  }

  if (status !== 0) {
    console.error('[prepare] tsdown build failed — the plugin cannot load without lib/')
    console.error('[prepare] alternatives: (a) install from the Release tgz (prebuilt), or')
    console.error('[prepare] (b) run "bash scripts/build.sh" with DSH_CHECKOUT set to a dsh source checkout, then reinstall.')
    return status ?? 1
  }
  if (!verifyOutputs()) {
    console.error(`[prepare] build finished but ${REQUIRED.join(', ')} missing`)
    return 1
  }
  // ★★★ 构建后两步（缺一则发布件不干净 / 可能被改坏）
  if (!scrubBuildPaths()) return 1
  if (!verifySyntax()) return 1
  return 0
}

process.exit(main())
