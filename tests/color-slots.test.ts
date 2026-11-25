// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import ColorDisk from '../src/ui/ColorDisk.vue'
import { colorSlots } from '../src/application/colorSlots'
let app: App | undefined, host: HTMLDivElement | undefined
afterEach(() => {
  app?.unmount()
  app = undefined
  host?.remove()
  vi.restoreAllMocks()
  localStorage.clear()
  window.dispatchEvent(new StorageEvent('storage', { key: 'knode-color-slots' }))
})
function mount(echoPreview = false) {
  host = document.createElement('div')
  document.body.append(host)
  let savedColor = '#6599cb'
  const state = reactive({ value: savedColor, disabled: false }),
    commit = vi.fn((c: string | null) => {
      if (c !== null) state.value = savedColor = c
    }),
    preview = vi.fn((c: string) => {
      if (echoPreview) state.value = c
    }),
    cancel = () => (state.value = savedColor)
  app = createApp({
    render: () =>
      h(ColorDisk, { ...state, onCommit: commit, onPreview: preview, onCancel: cancel }),
  })
  app.mount(host)
  return {
    state,
    commit,
    preview,
    slots: () => host!.querySelectorAll<HTMLButtonElement>('.color-presets button'),
    range: () => host!.querySelector<HTMLInputElement>('[aria-label="颜色明度"]')!,
  }
}
it('明度从最高拖到黑色时保留色相饱和度，提交和取消预览后仍可还原亮色', async () => {
  const c = mount(true)
  const adjust = async (value: string) => {
    c.range().value = value
    c.range().dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
  }
  const marker = host!.querySelector<HTMLElement>('.hsv-disk i')!
  const point = () => [marker.style.left, marker.style.top]
  const original = point()
  expect(original).not.toEqual(['50%', '50%'])
  await adjust('100')
  const bright = c.state.value
  await adjust('1')
  expect(point()).toEqual(original)
  await adjust('0')
  expect(c.state.value).toBe('#000000')
  expect(point()).toEqual(original)
  c.range().dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
  expect(c.commit).toHaveBeenCalledWith('#000000')
  await adjust('100')
  expect(c.state.value).toBe(bright)
  c.range().dispatchEvent(new PointerEvent('pointercancel'))
  await nextTick()
  expect(c.state.value).toBe('#000000')
  expect(point()).toEqual(original)
  await adjust('100')
  expect(c.state.value).toBe(bright)
})
it('九个色槽，明度实时预览仅松开记忆；重新挂载仍取回自定义颜色', async () => {
  const c = mount()
  expect(c.slots()).toHaveLength(9)
  c.slots()[1].click()
  await nextTick()
  c.commit.mockClear()
  const before = localStorage.getItem('knode-color-slots')
  c.range().value = '40'
  c.range().dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  expect(c.preview).toHaveBeenCalled()
  expect(c.commit).not.toHaveBeenCalled()
  expect(localStorage.getItem('knode-color-slots')).toBe(before)
  c.range().dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
  const edited = c.commit.mock.calls[0][0]
  expect(edited).not.toBe('#6599cb')
  expect(JSON.parse(localStorage.getItem('knode-color-slots')!)[1]).toBe(edited)
  app!.unmount()
  app = undefined
  host!.remove()
  const reopened = mount()
  reopened.slots()[1].click()
  expect(reopened.commit).toHaveBeenCalledWith(edited)
})
it('拖动色轮改写选中色槽，取消明度预览不覆盖已记忆颜色', async () => {
  const c = mount()
  c.slots()[2].click()
  await nextTick()
  const disk = host!.querySelector<HTMLElement>('.hsv-disk')!
  vi.spyOn(disk, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 112,
    height: 112,
  } as DOMRect)
  disk.dispatchEvent(
    new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 56 }),
  )
  disk.dispatchEvent(
    new PointerEvent('pointerup', { button: 0, pointerId: 1, clientX: 56, clientY: 100 }),
  )
  await nextTick()
  expect(colorSlots.value[2]).toBe(c.commit.mock.calls.at(-1)![0])
  const before = localStorage.getItem('knode-color-slots')
  c.range().value = '10'
  c.range().dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  c.range().dispatchEvent(new PointerEvent('pointercancel'))
  await nextTick()
  expect(localStorage.getItem('knode-color-slots')).toBe(before)
})
it('损坏偏好安全回退；偏好写入失败提示但节点颜色仍提交', async () => {
  localStorage.setItem('knode-color-slots', '["bad"]')
  window.dispatchEvent(new StorageEvent('storage', { key: 'knode-color-slots' }))
  expect(colorSlots.value).toHaveLength(9)
  expect(colorSlots.value.every((c) => /^#[0-9a-f]{6}$/i.test(c))).toBe(true)
  const c = mount()
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('full')
  })
  c.slots()[0].click()
  await nextTick()
  expect(c.commit).toHaveBeenCalled()
  expect(host!.querySelector('[role=alert]')?.textContent).toContain('无法保存')
})
