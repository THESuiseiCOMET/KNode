// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
it('重启加载深色偏好，损坏值安全回退浅色', async () => {
  localStorage.setItem('knode-theme', 'dark')
  vi.resetModules()
  const first = await import('../src/application/theme')
  expect(first.theme.value).toBe('dark')
  expect(document.documentElement.style.colorScheme).toBe('dark')
  localStorage.setItem('knode-theme', 'unknown')
  vi.resetModules()
  const second = await import('../src/application/theme')
  expect(second.theme.value).toBe('light')
  second.setTheme('light')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition
  document.documentElement.classList.remove('theme-transition', 'theme-transition-fallback')
  localStorage.removeItem('forest-fold-animation')
})
it('旧WebView平滑切色并清理过渡类，减少动态效果和关闭展开动画时立即切换', async () => {
  vi.useFakeTimers()
  const { setTheme, toggleTheme } = await import('../src/application/theme')
  setTheme('light')
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList)
  toggleTheme()
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(document.documentElement.classList.contains('theme-transition-fallback')).toBe(true)
  vi.advanceTimersByTime(300)
  expect(document.documentElement.classList.contains('theme-transition-fallback')).toBe(false)
  localStorage.setItem('forest-fold-animation', 'false')
  toggleTheme()
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(document.documentElement.classList.contains('theme-transition-fallback')).toBe(false)
  localStorage.removeItem('forest-fold-animation')
  vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList)
  toggleTheme()
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(document.documentElement.classList.contains('theme-transition-fallback')).toBe(false)
})
it('支持快照渐变时重复点击以最终选择为准，不让旧回调覆盖主题', async () => {
  const { setTheme, toggleTheme } = await import('../src/application/theme')
  setTheme('light')
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList)
  const callbacks: (() => void)[] = []
  const resolvers: (() => void)[] = []
  const skip = vi.fn()
  const start: typeof document.startViewTransition = (options) => {
    const callback = typeof options === 'function' ? options : options?.update
    callbacks.push(() => {
      void callback?.()
    })
    const finished = new Promise<void>((resolve) => resolvers.push(resolve))
    return {
      finished,
      skipTransition: skip,
      ready: Promise.resolve(),
      updateCallbackDone: Promise.resolve(),
      types: new Set<string>(),
    }
  }
  document.startViewTransition = vi.fn(start)
  toggleTheme()
  toggleTheme()
  expect(skip).toHaveBeenCalledOnce()
  callbacks[1]!()
  callbacks[0]!()
  expect(document.documentElement.dataset.theme).toBe('light')
  resolvers.forEach((resolve) => resolve())
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(document.documentElement.classList.contains('theme-transition')).toBe(false)
})
