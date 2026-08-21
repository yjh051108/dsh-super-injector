/**
 * dsh-super-injector 插件管理 UI（settings.section 页面）。
 * 功能：已注入插件列表 + 一键卸载 + 添加（路径输入/拖放提示）——
 *   - 直接注入：目录已是插件包（package.json + lib/）→ 立即注入
 *   - 内化：任意文件夹 → 新建 agent 会话 → AI 把内容变成插件
 * 通信：同源 fetch → host webServer API（/super-injector/api）
 *
 * 修复记录（v0.3.4）：旧实现把组件塞进 register 的 options.component 字段，
 * 且使用宿主不识别的 { render() } 原生 DOM 形态——slots.register(options,
 * component) 的组件必须是第二个参数（React 函数组件），否则分区注册成功
 * （导航有入口）但渲染为空白页。现改为标准 React 组件并作为第二参数注册。
 */
import * as React from 'react'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

type ClientContext = {
  slots: SlotsService
}

export const inject = ['slots']

const API = '/super-injector/api'

// 页面样式：模块级只注入一次（带守卫），不随组件重挂载重复追加。
const STYLES = `
.spi-page{font-family:ui-monospace,monospace;font-size:12px;line-height:1.6;padding:14px 16px;max-width:720px;width:100%}
.spi-page h3{margin:0 0 8px;font-size:13px}
.spi-add{border:1.5px dashed var(--theme-border,#555);border-radius:8px;padding:12px;margin-bottom:14px;text-align:center;color:var(--theme-text-secondary,#999)}
.spi-add.drag{border-color:var(--theme-accent,#4a9eff);background:rgba(74,158,255,.08)}
.spi-row{display:flex;gap:6px;margin-top:10px}
.spi-input{flex:1;background:var(--theme-input-bg,#111);color:var(--theme-text,#ddd);border:1px solid var(--theme-border,#333);border-radius:6px;padding:6px 8px;font-size:12px;min-width:0}
.spi-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px;white-space:nowrap}
.spi-btn:disabled{opacity:.45;cursor:not-allowed}
.spi-btn.ghost{background:transparent;border:1px solid var(--theme-border,#444);color:var(--theme-text,#ccc)}
.spi-btn.danger{background:transparent;border:1px solid #d33;color:#d33}
.spi-list{list-style:none;margin:0;padding:0}
.spi-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--theme-border,#333);border-radius:8px;margin-bottom:6px}
.spi-item .name{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.spi-item .dir{color:var(--theme-text-secondary,#888);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40%}
.spi-item .st{font-size:10px;padding:2px 6px;border-radius:10px}
.spi-item .st.on{background:rgba(46,204,113,.15);color:#2ecc71}
.spi-item .st.off{background:rgba(255,193,7,.12);color:#f1c40f}
.spi-msg{margin-top:10px;padding:8px 10px;border-radius:6px;background:var(--theme-input-bg,#111);border:1px solid var(--theme-border,#333);white-space:pre-wrap;max-height:180px;overflow:auto;font-size:11px}
.spi-stats{color:var(--theme-text-secondary,#888);font-size:11px;margin:0 0 10px}
`
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify('@dsh-external/dsh-super-injector/client') + ']') === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = '@dsh-external/dsh-super-injector'
  tag.dataset.pluginCss = '@dsh-external/dsh-super-injector/client'
  tag.textContent = STYLES
  document.head.appendChild(tag)
}

type InjectEntry = { name: string; dir: string; active?: boolean }
type InjectorStats = {
  inject?: { ok?: number; fail?: number }
  reload?: { ok?: number }
  uninject?: { ok?: number; fail?: number }
}
type Msg = { text: string; err: boolean } | null

function fetchJson(path: string, init?: RequestInit): Promise<any> {
  return fetch(API + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  }).then((r) => r.json())
}

/** 插件管理页（React 函数组件）。 */
function InjectorPluginsPage(): React.ReactElement {
  const [entries, setEntries] = React.useState<InjectEntry[]>([])
  const [stats, setStats] = React.useState<InjectorStats | null>(null)
  const [msg, setMsg] = React.useState<Msg>(null)
  const [dir, setDir] = React.useState('')
  const [drag, setDrag] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const alive = React.useRef(true)

  const say = React.useCallback((text: string, isErr = false): void => {
    setMsg(text ? { text, err: isErr } : null)
  }, [])

  const refresh = React.useCallback((): void => {
    fetchJson('/list')
      .then((d) => {
        if (!alive.current) return
        if (!d?.ok) return say(JSON.stringify(d), true)
        setEntries(d.entries ?? [])
        setStats(d.stats ?? null)
      })
      .catch((err) => {
        if (alive.current) say('加载失败: ' + err, true)
      })
  }, [say])

  // 首次加载 + 60s 轮询刷新（内化会话建好后自动出现）；卸载时清理定时器。
  React.useEffect(() => {
    alive.current = true
    refresh()
    const timer = window.setInterval(refresh, 60000)
    return () => {
      alive.current = false
      window.clearInterval(timer)
    }
  }, [refresh])

  const doAction = (path: string, label: string): void => {
    const target = dir.trim()
    if (!target) { say('请先输入文件夹路径', true); return }
    setBusy(true)
    say('')
    fetchJson(path, { method: 'POST', body: JSON.stringify({ dir: target, title: label }) })
      .then((r) => { say(r?.result ?? JSON.stringify(r), !r?.ok); if (r?.ok) setTimeout(refresh, 1200) })
      .catch((err) => say('请求失败: ' + err, true))
      .finally(() => setBusy(false))
  }

  const uninstall = (name: string): void => {
    setBusy(true)
    fetchJson('/uninstall', { method: 'POST', body: JSON.stringify({ match: name }) })
      .then((r) => { say(r?.result ?? JSON.stringify(r), !r?.ok); setTimeout(refresh, 600) })
      .catch((err) => say('卸载请求失败: ' + err, true))
      .finally(() => setBusy(false))
  }

  const h = React.createElement
  const s = stats
  return h('div', { className: 'spi-page' },
    h('h3', null, '插件管理（dsh-super-injector）'),
    h('p', { className: 'spi-stats' },
      `inject ${s?.inject?.ok ?? 0}✓/${s?.inject?.fail ?? 0}✗ · reload ${s?.reload?.ok ?? 0}✓ · uninject ${s?.uninject?.ok ?? 0}✓/${s?.uninject?.fail ?? 0}✗ · 共 ${entries.length} 个注入插件`),
    // ── 添加区（浏览器拿不到拖入文件夹的绝对路径——提示用输入框）──
    h('div', {
      className: 'spi-add' + (drag ? ' drag' : ''),
      onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDrag(true) },
      onDragLeave: () => setDrag(false),
      onDrop: (e: React.DragEvent) => { e.preventDefault(); setDrag(false) },
    },
      '拖入文件夹，或输入路径——「内化」= 新建会话让 AI 把内容变成插件；「注入」= 目录已是插件包直接注入',
      h('div', { className: 'spi-row' },
        h('input', {
          className: 'spi-input',
          placeholder: 'D:/path/to/folder',
          value: dir,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDir(e.target.value),
        }),
        h('button', { className: 'spi-btn', disabled: busy, onClick: () => doAction('/ingest', '内化插件') }, '内化（AI 造插件）'),
        h('button', { className: 'spi-btn ghost', disabled: busy, onClick: () => doAction('/inject', '直接注入') }, '直接注入'))),
    // ── 列表 ──
    h('ul', { className: 'spi-list' },
      entries.length === 0
        ? h('li', { className: 'spi-item' }, '（暂无注入插件——拖入文件夹或输入路径开始）')
        : entries.map((e) => h('li', { className: 'spi-item', key: String(e.name) },
          h('span', { className: 'name' }, String(e.name)),
          h('span', { className: 'dir' }, String(e.dir)),
          h('span', { className: 'st ' + (e.active ? 'on' : 'off') }, e.active ? '运行中' : '未激活'),
          h('button', { className: 'spi-btn danger', disabled: busy, onClick: () => uninstall(String(e.name)) }, '卸载')))),
    msg ? h('div', {
      className: 'spi-msg',
      style: { borderColor: msg.err ? '#d33' : undefined },
      role: msg.err ? 'alert' : undefined,
    }, msg.text) : null)
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('settings.section', () =>
    // 组件必须作为 slots.register 的第二个参数（React 函数组件）；
    // 放进 options.component 宿主不认，分区会渲染成空白页。
    ctx.slots.register({
      name: 'settings.section',
      id: 'super-injector-plugins',
      order: 50,
      label: () => '插件',
    }, () => React.createElement(InjectorPluginsPage)),
  ), 'super-injector: settings page')
}
