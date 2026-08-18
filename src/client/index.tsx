/**
 * dsh-super-injector 插件管理 UI。
 *
 * 挂载到官方设置页的 `settings.plugins.tab`，作为“插件”一级设置页下的
 * 二级标签页（避免再注册一个同名的一级“插件”设置页）。
 * 功能：已注入插件列表 + 一键卸载 + 添加（路径输入/拖放提示）——
 *   - 直接注入：目录已是插件包（package.json + lib/）→ 立即注入
 *   - 内化：任意文件夹 → 新建 agent 会话 → AI 把内容变成插件
 * 通信：同源 fetch → host webServer API（/super-injector/api）
 */
import { useEffect, useState } from 'react'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

type ClientContext = {
  slots: SlotsService
}

export const inject = ['slots']

const API = '/super-injector/api'

/** 注入清单里的一条记录。 */
type RegistryEntry = {
  name: string
  dir: string
  active?: boolean
}

/** /super-injector/api/list 的响应形状。 */
type ListResponse = {
  ok: boolean
  entries?: RegistryEntry[]
  stats?: {
    inject?: { ok?: number; fail?: number }
    reload?: { ok?: number }
    uninject?: { ok?: number; fail?: number }
  }
}

/** 沿用原 DOM 版样式，保持页面观感不变。 */
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

/** 真正的 React 函数组件：管理列表状态、操作反馈与 60s 轮询刷新。 */
function SuperInjectorSettingsTab() {
  const [entries, setEntries] = useState<RegistryEntry[]>([])
  const [stats, setStats] = useState('')
  const [path, setPath] = useState('')
  const [placeholder, setPlaceholder] = useState('D:/path/to/folder')
  const [message, setMessage] = useState('')
  const [messageError, setMessageError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [uninstalling, setUninstalling] = useState<string | null>(null)

  /** 输出操作反馈；空字符串时隐藏消息框。 */
  const say = (text: string, isErr = false): void => {
    setMessage(text)
    setMessageError(isErr)
  }

  /** 拉取注入清单并更新列表/统计。 */
  const refresh = async (): Promise<void> => {
    try {
      const d: ListResponse = await fetchJson('/list')
      if (!d?.ok) {
        say(JSON.stringify(d), true)
        return
      }
      const s = d.stats ?? {}
      setStats(
        `inject ${s.inject?.ok ?? 0}✓/${s.inject?.fail ?? 0}✗ · ` +
        `reload ${s.reload?.ok ?? 0}✓ · ` +
        `uninject ${s.uninject?.ok ?? 0}✓/${s.uninject?.fail ?? 0}✗ · ` +
        `共 ${d.entries?.length ?? 0} 个注入插件`,
      )
      setEntries(d.entries ?? [])
    } catch (err) {
      say('加载失败: ' + err, true)
    }
  }

  // 首次挂载立即刷新；之后每 60s 轮询（内化会话建好后自动出现）。
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 60000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 直接注入 / 内化共用的提交动作。 */
  const doAction = async (endpoint: string, title: string): Promise<void> => {
    const dir = path.trim()
    if (!dir) {
      say('请先输入文件夹路径', true)
      return
    }
    setBusy(true)
    say('')
    try {
      const r = await fetchJson(endpoint, {
        method: 'POST',
        body: JSON.stringify({ dir, title }),
      })
      say(r?.result ?? JSON.stringify(r), !r?.ok)
      if (r?.ok) window.setTimeout(() => void refresh(), 1200)
    } catch (err) {
      say('请求失败: ' + err, true)
    } finally {
      setBusy(false)
    }
  }

  /** 卸载一个已注入插件。 */
  const uninstall = async (entry: RegistryEntry): Promise<void> => {
    setUninstalling(entry.name)
    try {
      const r = await fetchJson('/uninstall', {
        method: 'POST',
        body: JSON.stringify({ match: entry.name }),
      })
      say(r?.result ?? JSON.stringify(r), !r?.ok)
      window.setTimeout(() => void refresh(), 600)
    } catch (err) {
      say('卸载请求失败: ' + err, true)
    } finally {
      setUninstalling(null)
    }
  }

  return (
    <div className="spi-page">
      <style>{styles}</style>
      <h3>插件管理（dsh-super-injector）</h3>
      <p className="spi-stats">{stats}</p>

      {/* 添加区：路径输入 + 拖放提示（浏览器拿不到绝对路径，只改提示文案） */}
      <div
        className={dragging ? 'spi-add drag' : 'spi-add'}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          setPlaceholder('浏览器无法读取拖入文件夹的绝对路径——请粘贴路径或使用选择器')
        }}
      >
        拖入文件夹，或输入路径——「内化」= 新建会话让 AI 把内容变成插件；「注入」= 目录已是插件包直接注入
        <div className="spi-row">
          <input
            className="spi-input"
            value={path}
            placeholder={placeholder}
            onChange={(e) => setPath(e.currentTarget.value)}
          />
          <button
            className="spi-btn"
            disabled={busy}
            onClick={() => void doAction('/ingest', '内化插件')}
          >
            {busy ? '处理中…' : '内化（AI 造插件）'}
          </button>
          <button
            className="spi-btn ghost"
            disabled={busy}
            onClick={() => void doAction('/inject', '直接注入')}
          >
            {busy ? '处理中…' : '直接注入'}
          </button>
        </div>
      </div>

      {/* 注入清单 */}
      <ul className="spi-list">
        {entries.length === 0 ? (
          <li className="spi-item">（暂无注入插件——拖入文件夹或输入路径开始）</li>
        ) : (
          entries.map((entry) => (
            <li className="spi-item" key={entry.name}>
              <span className="name">{entry.name}</span>
              <span className="dir">{entry.dir}</span>
              <span className={'st ' + (entry.active ? 'on' : 'off')}>
                {entry.active ? '运行中' : '未激活'}
              </span>
              <button
                className="spi-btn danger"
                disabled={uninstalling === entry.name}
                onClick={() => void uninstall(entry)}
              >
                {uninstalling === entry.name ? '卸载中…' : '卸载'}
              </button>
            </li>
          ))
        )}
      </ul>

      {/* 操作结果/错误消息 */}
      {message ? (
        <div
          className="spi-msg"
          style={{ borderColor: messageError ? '#d33' : 'var(--theme-border,#333)' }}
        >
          {message}
        </div>
      ) : null}
    </div>
  )
}

/** 浏览器入口：挂到官方“插件”设置页的二级标签，而不是再开一个一级“插件”页。 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('settings.plugins.tab', () =>
    ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'super-injector',
      order: 20,
      label: () => '插件管理',
    }, SuperInjectorSettingsTab),
  ), 'super-injector: plugin-manager tab')
}
