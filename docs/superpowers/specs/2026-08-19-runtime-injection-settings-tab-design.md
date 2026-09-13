# Super Injector 运行时注入设置页兼容设计

## 背景

当前客户端把管理页注册为独立的 `settings.section`，侧栏因此出现第二个“插件”入口。该实现还把旧式 `component` 字段放在注册选项中，并返回带 `render()` 的对象；当前 DSH 要求把 React 组件作为 `slots.register(options, component)` 的第二个参数，所以入口可见但内容为空。

DSH 原生“插件列表”中的 `super-injector` 只表示 Super Injector 本体已安装并启用；本页面管理的是由 Super Injector 动态注入的其他插件，两者职责不同。

## 目标

- 移除设置侧栏中重复的“插件”入口。
- 在 DSH 原生“插件”页面增加“运行时注入”标签。
- 保留现有列表、状态统计、直接注入、AI 内化和卸载功能。
- 保持现有 `/super-injector/api` Host API 不变。
- 页面卸载或热重载时清理轮询定时器，避免泄漏。

## 方案

客户端改为向 `settings.plugins.tab` 注册 `super-injector-runtime`，标签为“运行时注入”。注册使用当前两参数接口：第一参数保存插槽名称、ID、排序和标签，第二参数传入 React 组件。

现有命令式 DOM 页面拆成一个可独立挂载的管理器：接收容器节点，构造页面并返回清理函数。薄 React 适配组件只负责取得容器引用、调用挂载函数，并在卸载时执行清理。这样可保留已验证的业务逻辑，同时满足当前 DSH 的 React 插槽契约，避免无关的整页重写。

## 数据流与错误处理

React 标签组件挂载后调用 `/super-injector/api/list`，并每 60 秒刷新一次。直接注入、AI 内化和卸载继续调用现有端点；接口失败仍显示在页面消息区域。组件卸载时取消轮询，并使已经卸载的视图不再更新 DOM。

## 测试

- 插槽注册测试：断言使用 `settings.plugins.tab`、标签为“运行时注入”，且组件通过 `register` 的第二个参数传入。
- 生命周期测试：挂载后渲染管理页并请求列表；卸载后清除 60 秒轮询。
- 运行现有 TypeScript 类型检查和客户端构建，确保与当前 DSH 插槽类型兼容。

## 非目标

- 不修改 Router Standard、Router Spec 或 Routing Suite。
- 不改变 Super Injector Host API、注入机制或清单格式。
- 不重新设计 DSH 原生插件列表，也不把运行时子插件伪装成正式安装插件。
