# Runtime Injection Settings Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Super Injector 的运行时插件管理页从重复的设置侧栏入口迁移到 DSH 原生“插件”页面的“运行时注入”标签，并修复空白页。

**Architecture:** 保留现有命令式 DOM 管理页和 `/super-injector/api` 数据流，将其提取为 `mountRuntimeInjectionPage(container)` 生命周期单元；使用一个薄 React 组件负责挂载和清理。通过当前 DSH 的 `slots.register(options, component)` 两参数接口把组件注册到 `settings.plugins.tab`。

**Tech Stack:** TypeScript 5.9、React 18.3、DSH 0.1.0-rc.7 slots/settings contracts、Vitest 4、jsdom、tsdown。

## Global Constraints

- Host API `/super-injector/api`、注入机制和清单格式保持不变。
- 原有列表、统计、直接注入、AI 内化和卸载功能全部保留。
- 设置侧栏不再创建第二个“插件”入口。
- 原生插件页新增标签的固定文案为“运行时注入”。
- 页面卸载或热重载时必须取消 60 秒轮询，异步回调不得继续更新已卸载视图。
- 不修改 Router Standard、Router Spec 或 dsh-routing-suite。

---

## File Structure

- Modify: `package.json` — 声明 React/DSH 客户端契约与测试依赖，增加 `test` 脚本。
- Modify: `package-lock.json` — 锁定新增开发依赖。
- Modify: `src/client/index.ts` — 提供 DOM 挂载生命周期、React 适配组件和新的插件标签注册。
- Create: `tests/client/index.test.ts` — 覆盖插槽注册、页面内容和卸载清理。

### Task 1: 建立回归测试并迁移到当前 DSH 插槽接口

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tests/client/index.test.ts`
- Modify: `src/client/index.ts`

**Interfaces:**
- Consumes: `SlotsService.register(options, component)`；`settings.plugins.tab`；现有 `/super-injector/api/list|inject|ingest|uninstall`。
- Produces: `mountRuntimeInjectionPage(container: HTMLElement): () => void`；`RuntimeInjectionTab(): ReactNode`；`apply(ctx: ClientContext): void` 注册 `super-injector-runtime` 标签。

- [ ] **Step 1: 安装并声明测试/客户端类型依赖**

在 `package.json` 中增加：

```json
{
  "peerDependencies": {
    "@deepseek-ai/dsh-client-ui-settings": ">=0.1.0-rc.6 <0.2.0",
    "@deepseek-ai/dsh-client-ui-slots": ">=0.1.0-rc.6 <0.2.0",
    "react": "^18.3.1"
  },
  "devDependencies": {
    "@deepseek-ai/dsh-client-ui-settings": "0.1.0-rc.7",
    "@deepseek-ai/dsh-client-ui-slots": "0.1.0-rc.7",
    "@types/react": "~18.3.1",
    "@types/react-dom": "~18.3.1",
    "jsdom": "^29.1.1",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "vitest": "^4.1.8"
  },
  "scripts": {
    "test": "vitest run"
  }
}
```

同时把 `@deepseek-ai/dsh-client-ui-settings` 加入 `dsh.client.inject`，然后运行：

```powershell
npm install
```

- [ ] **Step 2: 写入能复现旧实现的失败测试**

创建 `tests/client/index.test.ts`，使用 jsdom、React root 和伪造的 `ctx.effect/slots.inject/slots.register`。核心断言如下：

```ts
expect(inject).toHaveBeenCalledWith('settings.plugins.tab', expect.any(Function))
expect(register).toHaveBeenCalledTimes(1)
const [options, Component] = register.mock.calls[0]
expect(options).toMatchObject({
  name: 'settings.plugins.tab',
  id: 'super-injector-runtime',
  label: expect.any(Function),
})
expect(options.label()).toBe('运行时注入')
expect(options).not.toHaveProperty('component')
expect(Component).toEqual(expect.any(Function))
```

第二个测试把捕获的 `Component` 挂载到 React root，stub `/list` 返回空列表，断言出现“插件管理（dsh-super-injector）”和“暂无注入插件”。使用 fake timers 监控 `setInterval/clearInterval`，卸载 root 后断言对应轮询已清除。

- [ ] **Step 3: 运行测试并确认按预期失败**

Run:

```powershell
npm test -- tests/client/index.test.ts
```

Expected: FAIL；旧代码调用 `settings.section`，把 `component` 放在 options 内，且没有可由 React 挂载的第二参数组件。

- [ ] **Step 4: 实现最小兼容修复**

在 `src/client/index.ts` 中：

```ts
import { createElement, useEffect, useRef, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-settings'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

export function mountRuntimeInjectionPage(container: HTMLElement): () => void {
  let disposed = false
  const page = el('div', 'spi-page')
  container.append(page)
  const refresh = (): void => {
    fetchJson('/list').then((data) => {
      if (disposed) return
      renderEntries(data)
    }).catch((error) => {
      if (disposed) return
      say('加载失败: ' + error, true)
    })
  }
  refresh()
  const timer = window.setInterval(refresh, 60000)
  return () => {
    disposed = true
    window.clearInterval(timer)
    container.replaceChildren()
  }
}

export function RuntimeInjectionTab(): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!containerRef.current) return
    return mountRuntimeInjectionPage(containerRef.current)
  }, [])
  return createElement('div', { ref: containerRef })
}
```

这里的 `renderEntries` 代表把当前 `refresh` 内部从 `if (!d?.ok)` 到列表循环结束的现有语句提取为局部函数；`say`、按钮事件、`doAction` 和全部中文文案保持原值。`/inject`、`/ingest`、`/uninstall` 的 Promise 回调在操作按钮或消息区前统一执行 `if (disposed) return`。

`apply` 改为：

```ts
ctx.effect(() => ctx.slots.inject('settings.plugins.tab', () =>
  ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'super-injector-runtime',
    order: 30,
    label: () => '运行时注入',
  }, RuntimeInjectionTab),
), 'super-injector: runtime injection settings tab')
```

- [ ] **Step 5: 运行聚焦测试并确认通过**

Run:

```powershell
npm test -- tests/client/index.test.ts
```

Expected: PASS，两个测试全部通过，且无未处理 Promise 或 React `act` 警告。

- [ ] **Step 6: 运行完整验证**

Run:

```powershell
npm test
npm run typecheck
npm run build:client
git diff --check
```

Expected: 所有命令 exit 0；`lib/client.js` 成功生成但保持被 `.gitignore` 忽略。

- [ ] **Step 7: 提交实现**

```powershell
git add package.json package-lock.json src/client/index.ts tests/client/index.test.ts
git commit -m "fix: mount injector manager in plugins tab"
```

### Task 2: 在本机 DSH 中验证真实界面

**Files:**
- No repository file changes.

**Interfaces:**
- Consumes: Task 1 生成的 `lib/index.js`、`lib/client.js` 和当前 `web` profile。
- Produces: 真实 DSH 设置界面的验收证据。

- [ ] **Step 1: 使用 fork 重新装配插件**

从 `D:\dsh-super-injector` 运行 `npm run build:client`；当前 `tsdown.config.ts` 同时构建 Host 和 Client bundle。然后运行：

```powershell
npx --yes @deepseek-ai/dsh plugin --profile web add D:\dsh-super-injector
```

重新启动 `web` profile 对应的 DSH 进程，使装配后的客户端 bundle 生效。

- [ ] **Step 2: 验证界面与 API 行为**

打开设置，确认侧栏只剩一个原生“插件”；进入该页后确认存在“运行时注入”标签。打开标签，确认页面不为空、列表请求成功，并确认离开标签后没有重复轮询或控制台异常。

- [ ] **Step 3: 记录验收结果**

执行：

```powershell
git status --short
git log -2 --oneline
```

Expected: 仅有预期提交；报告自动测试、客户端构建和真实界面验证结果，不提交 `lib/` 或本机 profile 文件。
