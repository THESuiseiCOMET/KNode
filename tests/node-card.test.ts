// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import ForestNode from '../src/canvas/ForestNode.vue'
import { cardHeight } from '../src/domain/geometry'
vi.mock('@vue-flow/core', () => ({
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
  Handle: { render: () => null },
}))
let app: App | undefined, host: HTMLDivElement | undefined
afterEach(() => {
  app?.unmount()
  host?.remove()
})
it('默认340×152，权重0隐藏进度，父节点折叠按钮排在文件和属性之前', async () => {
  const data = reactive({
    title: '任务',
    weight: 1,
    progress: 73,
    automatic: false,
    collapsed: false,
    count: 0,
    color: '#6599cb',
    highlight: false,
  })
  host = document.createElement('div')
  document.body.append(host)
  const collapse = vi.fn()
  app = createApp({
    render: () => h(ForestNode, { id: 'node', data, selected: true, onCollapse: collapse }),
  })
  app.mount(host)
  const article = host.querySelector<HTMLElement>('article')!
  expect(article.style.width).toBe('340px')
  expect(article.style.height).toBe('152px')
  expect(host.querySelector('[role=slider]')?.getAttribute('aria-valuenow')).toBe('73')
  expect(host.querySelector('.collapse-toggle')).toBeNull()
  data.weight = 0
  await nextTick()
  expect(host.querySelector('.card-progress-slot')).toBeNull()
  expect(article.style.height).toBe('')
  expect(article.style.width).toBe('340px')
  expect(data.progress).toBe(73)
  const files = host.querySelector<HTMLButtonElement>('.card-tabs button')!
  files.click()
  await nextTick()
  expect(article.style.height).toBe(`${cardHeight(0, true)}px`)
  files.click()
  await nextTick()
  expect(article.style.height).toBe('')
  data.weight = 2
  data.automatic = true
  data.count = 2
  await nextTick()
  expect(host.querySelector('[role=progressbar]')).toBeTruthy()
  const fold = host.querySelector<HTMLButtonElement>('.collapse-toggle')!
  expect(
    [...host.querySelectorAll('.card-tabs button')].map((el) => el.getAttribute('aria-label')),
  ).toEqual(['折叠子树', '文件', '属性'])
  expect(host.querySelector('.card-titlebar button')).toBeNull()
  expect(fold.disabled).toBe(false)
  expect(fold.getAttribute('aria-label')).toBe('折叠子树')
  fold.click()
  expect(collapse).toHaveBeenCalledOnce()
  data.collapsed = true
  await nextTick()
  expect(fold.getAttribute('aria-label')).toBe('展开子树')
  data.count = 0
  await nextTick()
  expect(host.querySelector('.collapse-toggle')).toBeNull()
  expect(article.style.height).toBe('152px')
})

it('展开文件/属性再收起时标题、进度和工具栏的间距保持一致且进度DOM不重建', async () => {
  const { readFileSync } = await import('node:fs')
  const style = document.createElement('style')
  style.textContent =
    readFileSync(process.cwd() + '/src/style.css', 'utf8') +
    readFileSync(process.cwd() + '/src/ui/capsule-slider.css', 'utf8')
  document.head.append(style)
  try {
    host = document.createElement('div')
    document.body.append(host)
    app = createApp({
      render: () =>
        h(ForestNode, {
          id: 'stable',
          selected: false,
          data: {
            title: '稳定布局',
            weight: 1,
            progress: 42,
            automatic: false,
            collapsed: false,
            count: 0,
            color: '#6599cb',
            highlight: false,
          },
        }),
    })
    app.mount(host)
    await nextTick()
    const card = host.querySelector<HTMLElement>('article')!,
      slider = host.querySelector('.progress-slider')!
    const measure = () => {
      const css = getComputedStyle(card)
      return {
        gap: css.gap,
        padding: css.padding,
        width: css.width,
        header: getComputedStyle(card.querySelector('.card-titlebar')!).height,
        slot: getComputedStyle(card.querySelector('.card-progress-slot')!).height,
      }
    }
    const compact = measure()
    for (const name of ['文件', '属性', '属性']) {
      host.querySelector<HTMLButtonElement>('button[aria-label="' + name + '"]')!.click()
      await nextTick()
      expect(measure()).toEqual(compact)
      expect(host.querySelector('.progress-slider')).toBe(slider)
    }
    expect(card.style.height).toBe('152px')
  } finally {
    style.remove()
  }
})

it('卡片自身只过渡高度，关闭展开动画或减少动态效果时立即切换', async () => {
  const { readFileSync } = await import('node:fs')
  const style = document.createElement('style')
  style.textContent =
    readFileSync(process.cwd() + '/src/style.css', 'utf8') +
    readFileSync(process.cwd() + '/src/ui/capsule-slider.css', 'utf8')
  document.head.append(style)
  try {
    host = document.createElement('div')
    document.body.append(host)
    app = createApp({
      render: () =>
        h(ForestNode, {
          id: 'motion',
          selected: false,
          data: {
            title: '动画',
            weight: 1,
            progress: 42,
            automatic: false,
            collapsed: false,
            count: 0,
            color: '#6599cb',
            highlight: false,
          },
        }),
    })
    app.mount(host)
    await nextTick()
    const card = host.querySelector('article')!
    expect(getComputedStyle(card).transition).toBe('height 225ms ease')
    host.className = 'static-folds'
    expect(getComputedStyle(card).transition).toBe('none')
    host.className = 'reduce-motion'
    expect(getComputedStyle(card).transition).toBe('none')
  } finally {
    style.remove()
  }
})
