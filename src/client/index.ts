/**
 * dsh-super-injector 插件管理 UI（settings.section 页面）。
 * 功能：已注入插件列表 + 一键卸载 + 添加（路径输入/拖放提示）——
 *   - 直接注入：目录已是插件包（package.json + lib/）→ 立即注入
 *   - 内化：任意文件夹 → 新建 agent 会话 → AI 把内容变成插件
 * 通信：同源 fetch → host webServer API（/super-injector/api）
 *
 * 修复（dsh-routing-suite#1：Web 设置页「插件」选项空白）：此前把 `component`
 * 塞进 `register(options, component)` 的 options 里，被插槽核心静默丢弃——label
 * 生效但组件未注册，点开设置页永远空白。现改为把真正的 React 函数组件作为
 * 第二个位置参数传入（与官方 settings.section 注册方式一致）；同时把 label 由
 * 「插件」改为「插件管理」，避免与官方设置页「插件」重名。
 */
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useState, type ChangeEvent, type DragEvent } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'

type ClientContext = {
  slots: SlotsService
}

export const inject = ['slots']

const API = '/super-injector/api'

const styles = `
.spi-page{font-family:ui-monospace,monospace;font-size:12px;line-height:1.6;padding:14px 16px;max-width:720px}
.spi-page h3{margin:0 0 8px;font-size:13px}
.spi-add{border:1.5px dashed var(--theme-border,#555);border-radius:8px;padding:12px;margin-bottom:14px;text-align:center;color:var(--theme-text-secondary,#999)}
.spi-add.drag{border-color:var(--theme-accent,#4a9eff);background:rgba(74,158,255,.08)}
.spi-row{display:flex;gap:6px;margin-top:10px}
.spi-input{flex:1;background:var(--theme-input-bg,#111);color:var(--theme-text,#ddd);border:1px solid var(--theme-border,#333);border-radius:6px;padding:6px 8px;font-size:12px}
.spi-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px;white-space:nowrap}
.spi-btn.ghost{background:transparent;border:1px solid var(--theme-border,#444);color:var(--theme-text,#ccc)}
.spi-btn.danger{background:transparent;border:1px solid #d33;color:#d33}
.spi-btn:disabled{opacity:.45;cursor:not-allowed}
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

function fetchJson(path: string, init?: RequestInit): Promise<any> {
  return fetch(API + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  }).then((r) => r.json())
}

/**
 * 插件管理设置页（React 函数组件）。
 * 经 `ctx.slots.register(options, Component)` 的第二个位置参数注册，由插槽
 * 渲染系统接管；不能再写 `component: () => ({ render(){} })`（会被插槽核心丢弃）。
 */
function SuperInjectorPluginsSection() {
  const [entries, setEntries] = useState<any[]>([])
  const [stats, setStats] = useState<any>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [msgErr, setMsgErr] = useState(false)
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [dropHint, setDropHint] = useState('D:/path/to/folder')

  const refresh = useCallback(() => {
    fetchJson('/list')
      .then((d) => {
        if (!d?.ok) {
          setMsg(JSON.stringify(d))
          setMsgErr(true)
          return
        }
        setEntries(d.entries ?? [])
        setStats(d.stats ?? {})
        setMsg(null)
        setMsgErr(false)
      })
      .catch((err) => {
        setMsg('加载失败: ' + err)
        setMsgErr(true)
      })
  }, [])

  useEffect(() => {
    refresh()
    // 60s 轮询刷新（内化会话建好后自动出现）
    const timer = window.setInterval(refresh, 60000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const say = (text: string | null, isErr = false): void => {
    setMsg(text)
    setMsgErr(isErr)
  }

  const doAction = (path: string, label: string): void => {
    const value = dir.trim()
    if (!value) {
      say('请先输入文件夹路径', true)
      return
    }
    setBusy(true)
    setMsg(null)
    fetchJson(path, { method: 'POST', body: JSON.stringify({ dir: value, title: label }) })
      .then((r) => {
        say(r?.result ?? JSON.stringify(r), !r?.ok)
        if (r?.ok) setTimeout(refresh, 1200)
      })
      .catch((err) => say('请求失败: ' + err, true))
      .finally(() => setBusy(false))
  }

  const doUninstall = (name: string): void => {
    setBusyName(name)
    fetchJson('/uninstall', { method: 'POST', body: JSON.stringify({ match: name }) })
      .then((r) => {
        say(r?.result ?? JSON.stringify(r), !r?.ok)
      })
      .catch((err) => say('卸载请求失败: ' + err, true))
      .finally(() => {
        setBusyName(null)
        setTimeout(refresh, 600)
      })
  }

  const statsText = stats
    ? `inject ${stats.inject?.ok ?? 0}✓/${stats.inject?.fail ?? 0}✗ · reload ${stats.reload?.ok ?? 0}✓ · uninject ${stats.uninject?.ok ?? 0}✓/${stats.uninject?.fail ?? 0}✗ · 共 ${entries.length} 个注入插件`
    : '正在读取插件…'

  return jsxs(Fragment, {
    children: [
      jsx('style', { children: styles }),
      jsx('div', {
        className: 'spi-page',
        children: jsxs(Fragment, {
          children: [
            jsx('h3', { children: '插件管理（dsh-super-injector）' }),
            jsx('p', { className: 'spi-stats', children: statsText }),
            jsx('div', {
              className: 'spi-add' + (dragging ? ' drag' : ''),
              onDragOver: (e: DragEvent<HTMLDivElement>) => {
                e.preventDefault()
                setDragging(true)
              },
              onDragLeave: () => setDragging(false),
              onDrop: (e: DragEvent<HTMLDivElement>) => {
                e.preventDefault()
                setDragging(false)
                setDropHint('浏览器无法读取拖入文件夹的绝对路径——请粘贴路径或使用选择器')
              },
              children: jsxs(Fragment, {
                children: [
                  '拖入文件夹，或输入路径——「内化」= 新建会话让 AI 把内容变成插件；「注入」= 目录已是插件包直接注入',
                  jsx('div', {
                    className: 'spi-row',
                    children: jsxs(Fragment, {
                      children: [
                        jsx('input', {
                          className: 'spi-input',
                          placeholder: dropHint,
                          value: dir,
                          onChange: (e: ChangeEvent<HTMLInputElement>) => setDir(e.target.value),
                        }),
                        jsx('button', {
                          className: 'spi-btn',
                          disabled: busy,
                          onClick: () => doAction('/ingest', '内化插件'),
                          children: busy ? '处理中…' : '内化（AI 造插件）',
                        }),
                        jsx('button', {
                          className: 'spi-btn ghost',
                          disabled: busy,
                          onClick: () => doAction('/inject', '直接注入'),
                          children: busy ? '处理中…' : '直接注入',
                        }),
                      ],
                    }),
                  }),
                ],
              }),
            }),
            jsx('ul', {
              className: 'spi-list',
              children: entries.length === 0
                ? jsx('li', { className: 'spi-item', children: '（暂无注入插件——拖入文件夹或输入路径开始）' })
                : entries.map((e) => jsx('li', {
                    className: 'spi-item',
                    children: jsxs(Fragment, {
                      children: [
                        jsx('span', { className: 'name', children: String(e.name) }),
                        jsx('span', { className: 'dir', children: String(e.dir) }),
                        jsx('span', { className: 'st ' + (e.active ? 'on' : 'off'), children: e.active ? '运行中' : '未激活' }),
                        jsx('button', {
                          className: 'spi-btn danger',
                          disabled: busyName === e.name,
                          onClick: () => doUninstall(e.name),
                          children: busyName === e.name ? '卸载中…' : '卸载',
                        }),
                      ],
                    }),
                  }, String(e.name))),
            }),
            msg ? jsx('div', {
              className: 'spi-msg',
              style: msgErr ? { borderColor: '#d33' } : undefined,
              children: msg,
            }) : null,
          ],
        }),
      }),
    ],
  })
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: 'super-injector-plugins',
      order: 50,
      label: () => '插件管理',
    }, SuperInjectorPluginsSection)
  ), 'super-injector: settings page')
}
