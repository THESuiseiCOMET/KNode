// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProgressSlider from '../src/canvas/ProgressSlider.vue'
import {
  createChild,
  createRoot,
  computeProgress,
  setManualProgress,
  setWeight,
} from '../src/domain/forest'
import { createProject } from '../src/domain/model'
import { pointerProgress, keyboardProgress, previewProgress } from '../src/domain/progress'
let app: App | undefined, host: HTMLDivElement | undefined
afterEach(() => {
  app?.unmount()
  host?.remove()
  vi.restoreAllMocks()
})
function mount(readonly = false) {
  const props = reactive({
    value: 20,
    title: '叶任务',
    readonly,
    disabled: false,
    color: '#6599cb',
  })
  const start = vi.fn(),
    preview = vi.fn(),
    commit = vi.fn(),
    cancel = vi.fn(),
    bubble = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({
    render: () =>
      h('div', { onPointerdown: bubble, onMousedown: bubble }, [
        h(ProgressSlider, {
          ...props,
          onStart: start,
          onPreview: preview,
          onCommit: commit,
          onCancel: cancel,
        }),
      ]),
  })
  app.mount(host)
  const slider = host.querySelector<HTMLElement>('[role]')!
  vi.spyOn(slider.querySelector('.capsule-rail')!, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    width: 200,
  } as DOMRect)
  const capture = vi.fn(),
    release = vi.fn()
  slider.setPointerCapture = capture
  slider.releasePointerCapture = release
  slider.hasPointerCapture = () => true
  const pointer = (type: string, x: number, id = 1) =>
    slider.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        pointerId: id,
        button: 0,
      }),
    )
  return { props, slider, start, preview, commit, cancel, bubble, pointer, capture }
}
describe('进度条独立手势', () => {
  it('实时显示、左右边界、指针捕获；松开只提交一次且不冒泡到节点', async () => {
    const c = mount()
    c.pointer('pointerdown', 150)
    await nextTick()
    expect(c.slider.getAttribute('aria-valuenow')).toBe('25')
    c.pointer('pointermove', 50)
    await nextTick()
    expect(c.slider.getAttribute('aria-valuenow')).toBe('0')
    c.pointer('pointermove', 450)
    await nextTick()
    expect(c.slider.getAttribute('aria-valuenow')).toBe('100')
    expect(c.commit).not.toHaveBeenCalled()
    c.pointer('pointerup', 450)
    c.pointer('lostpointercapture', 450)
    expect(c.commit).toHaveBeenCalledExactlyOnceWith(100)
    expect(c.capture).toHaveBeenCalledWith(1)
    expect(c.bubble).not.toHaveBeenCalled()
    c.slider.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(c.bubble).not.toHaveBeenCalled()
  })
  it('缩放后的实际轨道边界仍正确映射中点与端点', async () => {
    const c = mount()
    vi.mocked(c.slider.querySelector('.capsule-rail')!.getBoundingClientRect).mockReturnValue({
      left: 120,
      width: 80,
    } as DOMRect)
    c.pointer('pointerdown', 160)
    await nextTick()
    expect(c.slider.getAttribute('aria-valuenow')).toBe('50')
    c.pointer('pointerup', 200)
    expect(c.commit).toHaveBeenCalledExactlyOnceWith(100)
    expect(c.bubble).not.toHaveBeenCalled()
  })
  it('pointercancel 或窗口失焦撤回预览，不提交；其他指针不会结束手势', async () => {
    const c = mount()
    c.pointer('pointerdown', 200)
    c.pointer('pointerup', 280, 2)
    expect(c.commit).not.toHaveBeenCalled()
    c.pointer('pointercancel', 250)
    await nextTick()
    expect(c.cancel).toHaveBeenCalledTimes(1)
    expect(c.slider.getAttribute('aria-valuenow')).toBe('20')
    c.pointer('pointerdown', 250)
    window.dispatchEvent(new Event('blur'))
    expect(c.cancel).toHaveBeenCalledTimes(2)
    expect(c.commit).not.toHaveBeenCalled()
  })
  it('父节点进度条只读，指针与键盘都不能提交', () => {
    const c = mount(true)
    c.pointer('pointerdown', 250)
    c.pointer('pointerup', 300)
    c.slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(c.slider.getAttribute('role')).toBe('progressbar')
    expect(c.slider.tabIndex).toBe(-1)
    expect(c.start).not.toHaveBeenCalled()
    expect(c.commit).not.toHaveBeenCalled()
  })
  it('键盘支持方向、Home/End、Page 键，Ctrl+Z 保留给画布历史', () => {
    const c = mount()
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End', 'PageUp', 'PageDown'])
      c.slider.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    expect(c.commit.mock.calls.map((x) => x[0])).toEqual([21, 19, 0, 100, 30, 10])
    expect(c.slider.getAttribute('aria-label')).toContain('叶任务')
    c.slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    expect(c.commit).toHaveBeenCalledTimes(6)
  })
  it('禁用、右键、卸载时不误提交或留下活动手势', async () => {
    const c = mount()
    c.pointer('pointerdown', 200)
    c.props.disabled = true
    await nextTick()
    expect(c.cancel).toHaveBeenCalledOnce()
    c.pointer('pointerup', 300)
    expect(c.commit).not.toHaveBeenCalled()
    c.props.disabled = false
    await nextTick()
    c.slider.dispatchEvent(new PointerEvent('pointerdown', { button: 2, pointerId: 2 }))
    expect(c.start).toHaveBeenCalledOnce()
    c.pointer('pointerdown', 220)
    app!.unmount()
    app = undefined
    expect(c.cancel).toHaveBeenCalledTimes(2)
  })
})
describe('预览计算与动画策略', () => {
  it('递归预览即时加权，不改手动值、坐标或原项目；零权重叶仍有自身值', () => {
    let p = createRoot(
      createProject('测试', 'c0e631c4-9154-4478-b7af-a2d166e62a36'),
      'root',
      '根',
      { x: 0, y: 0 },
    )
    p = createChild(p, 'root', 'a', 'a', { x: 300, y: 0 })
    p = createChild(p, 'root', 'b', 'b', { x: 300, y: 200 }, 3)
    p = createChild(p, 'a', 'leaf', '叶', { x: 600, y: 0 }, 0)
    p = setManualProgress(p, 'root', 73)
    p = setManualProgress(p, 'a', 32)
    p = setManualProgress(p, 'b', 80)
    const before = JSON.stringify(p),
      base = computeProgress(p),
      draft = previewProgress(p, base, { id: 'leaf', value: 100 })
    expect(draft.get('leaf')).toBe(100)
    expect(draft.get('a')).toBe(32)
    expect(draft.get('root')).toBeCloseTo(68, 12)
    expect(JSON.stringify(p)).toBe(before)
    p = setWeight(p, 'leaf', 1)
    const next = previewProgress(p, computeProgress(p), { id: 'leaf', value: 20 })
    expect(next.get('root')).toBeCloseTo(65, 12)
    expect(() => previewProgress(p, base, { id: 'root', value: 99 })).toThrow(/带权子节点/)
    expect(() => previewProgress(p, base, { id: 'leaf', value: NaN })).toThrow()
  })
  it('指针和键盘边界是 0–100 的整数', () => {
    expect(pointerProgress(-100, 0, 200)).toBe(0)
    expect(pointerProgress(300, 0, 200)).toBe(100)
    expect(pointerProgress(51, 0, 200)).toBe(26)
    expect(keyboardProgress(100, 'ArrowRight')).toBe(100)
    expect(keyboardProgress(0, 'ArrowLeft')).toBe(0)
    expect(keyboardProgress(20, 'z')).toBeNull()
  })
})

it('全0孩子的父节点可以预览手动值，祖先实时加权且不覆盖任何保存值', () => {
  let p = createRoot(
    createProject('回退', 'c0e631c4-9154-4478-b7af-a2d166e62a36'),
    'root',
    '祖父',
    { x: 0, y: 0 },
  )
  p = createChild(p, 'root', 'parent', '父', { x: 300, y: 0 }, 2)
  p = createChild(p, 'parent', 'zero', '零权孩子', { x: 600, y: 0 }, 0)
  p = createChild(p, 'root', 'other', '另一孩子', { x: 300, y: 200 }, 2)
  p = setManualProgress(p, 'parent', 73)
  p = setManualProgress(p, 'other', 80)
  const before = JSON.stringify(p),
    base = computeProgress(p)
  const draft = previewProgress(p, base, { id: 'parent', value: 20 })
  expect(draft.get('parent')).toBe(20)
  expect(draft.get('root')).toBe(50)
  const ignored = previewProgress(p, base, { id: 'zero', value: 100 })
  expect(ignored.get('parent')).toBe(73)
  expect(ignored.get('root')).toBe(76.5)
  expect(JSON.stringify(p)).toBe(before)
  expect([...base]).toEqual([...computeProgress(p)])
})

it('无权父节点的带权子树实时预览，祖父回退手动值且不被隐藏子树带动', () => {
  let p = createRoot(
    createProject('无权父节点', 'c0e631c4-9154-4478-b7af-a2d166e62a36'),
    'root',
    '祖父',
    { x: 0, y: 0 },
  )
  p = setManualProgress(p, 'root', 73)
  p = createChild(p, 'root', 'parent', '无权父', { x: 300, y: 0 }, 0)
  p = setManualProgress(p, 'parent', 17)
  p = createChild(p, 'parent', 'a', '孩子A', { x: 600, y: 0 }, 1)
  p = createChild(p, 'parent', 'b', '孩子B', { x: 600, y: 200 }, 3)
  p = setManualProgress(p, 'a', 20)
  p = setManualProgress(p, 'b', 60)
  const draft = previewProgress(p, computeProgress(p), { id: 'a', value: 100 })
  expect(draft.get('parent')).toBeCloseTo(70, 12)
  expect(draft.get('root')).toBe(73)
  expect(p.nodes.find((n) => n.id === 'parent')?.progress).toBe(17)
  p = setWeight(p, 'parent', 2)
  expect(previewProgress(p, computeProgress(p), { id: 'a', value: 100 }).get('root')).toBeCloseTo(
    70,
    12,
  )
})
