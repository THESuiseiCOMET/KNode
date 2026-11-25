// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import {
  readLayoutDirections,
  saveLayoutDirections,
  startAutoLayout,
} from '../src/application/autoLayout'
import type { LayoutInput } from '../src/domain/layout'

const input: LayoutInput = {
  view: 'tree',
  direction: 'TB',
  nodes: [{ id: 'a', parentId: null, width: 340, height: 152 }],
  edges: [],
}
let last: FakeWorker
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    last = this
  }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  localStorage.removeItem('knode-layout-directions')
})
it('方向分视图持久化，损坏或不可读设置使用默认值', () => {
  expect(readLayoutDirections()).toEqual({ tree: 'TB', graph: 'TB' })
  saveLayoutDirections({ tree: 'LR', graph: 'BT' })
  expect(readLayoutDirections()).toEqual({ tree: 'LR', graph: 'BT' })
  localStorage.setItem('knode-layout-directions', '{"tree":"bad","graph":"RL"}')
  expect(readLayoutDirections()).toEqual({ tree: 'TB', graph: 'RL' })
  localStorage.setItem('knode-layout-directions', 'broken')
  expect(readLayoutDirections()).toEqual({ tree: 'TB', graph: 'TB' })
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('denied')
  })
  expect(readLayoutDirections()).toEqual({ tree: 'TB', graph: 'TB' })
})
it('后台模块 Worker 完成后销毁，不创建主线程布局循环', async () => {
  vi.stubGlobal('Worker', FakeWorker)
  const job = startAutoLayout(input)
  expect(last.options.type).toBe('module')
  expect(last.url.pathname).toContain('layout.worker.ts')
  expect(last.postMessage).toHaveBeenCalledWith(input)
  last.onmessage!({ data: { positions: { a: { x: 40, y: 40 } } } } as MessageEvent)
  expect(await job.result).toEqual({ positions: { a: { x: 40, y: 40 } } })
  expect(last.terminate).toHaveBeenCalledOnce()
})
it('图布局保留独立 Worker，只接收坐标，保留图边给画布实时路由', async () => {
  vi.stubGlobal('Worker', FakeWorker)
  const graph: LayoutInput = {
    ...input,
    view: 'graph',
    edges: [{ id: 'loop', source: 'a', target: 'a', direction: 'forward' }],
  }
  const positions = { a: { x: 40, y: 40 } }
  const job = startAutoLayout(graph)
  expect(last.url.pathname).toContain('graphLayout.worker.ts')
  expect(last.postMessage).toHaveBeenCalledWith(graph)
  last.onmessage!({ data: { positions } } as MessageEvent)
  await expect(job.result).resolves.toEqual({ positions })
  expect(last.terminate).toHaveBeenCalledOnce()
})
it.each([
  { positions: {} },
  { positions: { a: { x: NaN, y: 0 } } },
  { positions: { a: { x: 0, y: 0 }, extra: { x: 0, y: 0 } } },
  { error: 'fault' },
])('失败或异常结果拒绝，不应用部分布局 %#', async (data) => {
  vi.stubGlobal('Worker', FakeWorker)
  const job = startAutoLayout(input),
    assertion = expect(job.result).rejects.toThrow()
  last.onmessage!({ data } as MessageEvent)
  await assertion
  expect(last.terminate).toHaveBeenCalledOnce()
})
it('取消、超时和 Worker 错误清理资源，保留由调用方持有的原项目', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('Worker', FakeWorker)
  let job = startAutoLayout(input),
    assertion = expect(job.result).rejects.toThrow(/取消/)
  job.cancel()
  await assertion
  expect(last.terminate).toHaveBeenCalledOnce()
  job = startAutoLayout(input)
  assertion = expect(job.result).rejects.toThrow(/超时/)
  vi.advanceTimersByTime(30_000)
  await assertion
  expect(last.terminate).toHaveBeenCalledOnce()
  job = startAutoLayout(input)
  assertion = expect(job.result).rejects.toThrow(/worker fault/)
  last.onerror!({ message: 'worker fault', preventDefault: vi.fn() } as unknown as ErrorEvent)
  await assertion
  expect(last.terminate).toHaveBeenCalledOnce()
})
