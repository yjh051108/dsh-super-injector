/* @vitest-environment jsdom */

import { act, createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apply, mountRuntimeInjectionPage } from '../../src/client/index.js'

type RegistrationOptions = {
  name?: string
  id?: string
  order?: number
  label?: () => string
  component?: unknown
}

const emptyList = {
  ok: true,
  entries: [],
  stats: {
    inject: { ok: 0, fail: 0 },
    reload: { ok: 0 },
    uninject: { ok: 0, fail: 0 },
  },
}

function jsonResponse(data: unknown): { ok: boolean; json: () => Promise<unknown> } {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue(data),
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

function captureRegistration(): {
  inject: ReturnType<typeof vi.fn>
  options: RegistrationOptions
  Component: ComponentType
} {
  const register = vi.fn((_options: unknown, _component?: unknown) => () => {})
  const inject = vi.fn((_name: string, setup: () => unknown) => setup())
  const effect = vi.fn((setup: () => unknown) => setup())

  apply({
    effect,
    slots: { inject, register },
  } as never)

  const [options, Component] = register.mock.calls[0] as unknown as [
    RegistrationOptions,
    ComponentType,
  ]

  return { inject, options, Component }
}

describe('Super Injector settings contribution', () => {
  let root: Root | undefined

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(emptyList)))
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
      root = undefined
    }
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('contributes the manager as a native Plugins tab component', () => {
    const { inject, options, Component } = captureRegistration()

    expect(inject).toHaveBeenCalledWith('settings.plugins.tab', expect.any(Function))
    expect(options).toMatchObject({
      name: 'settings.plugins.tab',
      id: 'super-injector-runtime',
      order: 30,
    })
    expect(options.label?.()).toBe('运行时注入')
    expect(options).not.toHaveProperty('component')
    expect(Component).toEqual(expect.any(Function))
  })

  it('renders the runtime manager and clears its polling timer on unmount', async () => {
    vi.useFakeTimers()
    const clearInterval = vi.spyOn(window, 'clearInterval')
    const { Component } = captureRegistration()
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(createElement(Component))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('插件管理（dsh-super-injector）')
    expect(container.textContent).toContain('暂无注入插件')

    act(() => root?.unmount())
    root = undefined

    expect(clearInterval).toHaveBeenCalledTimes(1)
    container.remove()
  })

  it('preserves the inject, ingest, and uninstall API contracts', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/list')) {
        return jsonResponse({
          ...emptyList,
          entries: [{ name: 'demo-plugin', dir: 'D:/plugins/demo', active: true }],
        })
      }
      return jsonResponse({ ok: false, result: 'fixture response' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const container = document.createElement('div')
    const dispose = mountRuntimeInjectionPage(container)
    await flushPromises()

    const input = container.querySelector('input') as HTMLInputElement
    input.value = 'D:/plugins/demo'
    const button = (label: string): HTMLButtonElement => {
      const match = [...container.querySelectorAll('button')]
        .find((candidate) => candidate.textContent === label)
      if (!match) throw new Error(`button not found: ${label}`)
      return match as HTMLButtonElement
    }

    button('直接注入').click()
    await flushPromises()
    button('内化（AI 造插件）').click()
    await flushPromises()
    button('卸载').click()
    await flushPromises()

    const request = (suffix: string): [string, RequestInit] => {
      const match = fetchMock.mock.calls.find(([url]) => String(url).endsWith(suffix))
      if (!match) throw new Error(`request not found: ${suffix}`)
      return match as unknown as [string, RequestInit]
    }
    expect(request('/inject')[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ dir: 'D:/plugins/demo', title: '直接注入' }),
    })
    expect(request('/ingest')[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ dir: 'D:/plugins/demo', title: '内化插件' }),
    })
    expect(request('/uninstall')[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ match: 'demo-plugin' }),
    })

    dispose()
  })

  it('ignores a list response that resolves after the page is disposed', async () => {
    const pending = deferred<typeof emptyList & {
      entries: Array<{ name: string; dir: string; active: boolean }>
    }>()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => pending.promise,
    }))
    const container = document.createElement('div')
    const dispose = mountRuntimeInjectionPage(container)
    const detachedPage = container.firstElementChild as HTMLElement

    dispose()
    pending.resolve({
      ...emptyList,
      entries: [{ name: 'late-plugin', dir: 'D:/plugins/late', active: true }],
    })
    await flushPromises()

    expect(detachedPage.textContent).not.toContain('late-plugin')
  })
})
