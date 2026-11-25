// @vitest-environment happy-dom
import { createApp, h, nextTick } from 'vue'
import { expect, it, vi } from 'vitest'
import TitleBar from '../src/ui/TitleBar.vue'
import { pathParts } from '../src/application/titlebar'
const native = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  watchMaximized: vi.fn(),
}))
vi.mock('../src/adapters/window', () => ({ desktopWindow: native }))
it('仅空白是拖动区；路径和窗口控件独立，最大化图标响应系统调整', async () => {
  let notify: ((value: boolean) => void) | undefined
  const stop = vi.fn()
  native.watchMaximized.mockImplementation(async (callback: typeof notify) => {
    notify = callback
    return stop
  })
  const host = document.createElement('div')
  document.body.append(host)
  const open = vi.fn(),
    report = vi.fn()
  const app = createApp({
    render: () =>
      h(TitleBar, {
        directory: 'D:\\a\\VeryLongProject',
        dirty: true,
        desktop: true,
        onOpenFolder: open,
        onError: report,
      }),
  })
  try {
    app.mount(host)
    await nextTick()
    await Promise.resolve()
    expect(host.querySelectorAll('[data-tauri-drag-region]')).toHaveLength(1)
    expect(host.querySelector('[data-tauri-drag-region]')?.children).toHaveLength(0)
    expect(host.querySelector('.project-path')?.closest('[data-tauri-drag-region]')).toBeNull()
    host.querySelector<HTMLButtonElement>('.project-path')!.click()
    expect(open).toHaveBeenCalledOnce()
    host.querySelector<HTMLButtonElement>('[aria-label="最小化"]')!.click()
    expect(native.minimize).toHaveBeenCalledOnce()
    host.querySelector<HTMLButtonElement>('[aria-label="最大化"]')!.click()
    expect(native.toggleMaximize).toHaveBeenCalledOnce()
    notify!(true)
    await nextTick()
    expect(host.querySelector('[aria-label="还原窗口"]')).not.toBeNull()
    host.querySelector<HTMLButtonElement>('[aria-label="关闭窗口"]')!.click()
    expect(native.close).toHaveBeenCalledOnce()
    native.minimize.mockRejectedValueOnce(new Error('failed'))
    host.querySelector<HTMLButtonElement>('[aria-label="最小化"]')!.click()
    await Promise.resolve()
    expect(report).toHaveBeenCalled()
  } finally {
    app.unmount()
    host.remove()
  }
  expect(stop).toHaveBeenCalledOnce()
})
it('路径分段保留盘符、最后目录和 UNC 起点，不把 JSON 文件名当目录', () => {
  expect(pathParts('D:\\Projects\\Study\\Forest')).toEqual({
    start: 'D:\\',
    middle: 'Projects\\Study\\',
    name: 'Forest',
  })
  expect(pathParts('D:\\Forest')).toEqual({ start: '', middle: '', name: 'D:\\Forest' })
  const unc = '\\\\server\\share\\some\\folder'
  const parts = pathParts(unc)
  expect(parts.start + parts.middle + parts.name).toBe(unc)
  expect(parts.name).toBe('folder')
})
