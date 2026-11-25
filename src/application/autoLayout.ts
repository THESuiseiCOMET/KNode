import { isLayoutDirection, type LayoutDirection, type LayoutInput } from '../domain/layout'
import { isRecord, type Point, type ViewName } from '../domain/model'

export type LayoutDirections = Record<ViewName, LayoutDirection>
const KEY = 'knode-layout-directions'
export function readLayoutDirections(): LayoutDirections {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (isRecord(stored))
      return {
        tree: isLayoutDirection(stored.tree) ? stored.tree : 'TB',
        graph: isLayoutDirection(stored.graph) ? stored.graph : 'TB',
      }
  } catch {
    /* Missing/corrupt preferences never affect project data. */
  }
  return { tree: 'TB', graph: 'TB' }
}
export function saveLayoutDirections(value: LayoutDirections): void {
  localStorage.setItem(KEY, JSON.stringify(value))
}

interface LayoutResult {
  positions: Record<string, Point>
}

function isPoint(value: unknown): value is Point {
  return isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y)
}

export function startAutoLayout(input: LayoutInput): {
  result: Promise<LayoutResult>
  cancel: () => void
} {
  const worker =
    input.view === 'graph'
      ? new Worker(new URL('../workers/graphLayout.worker.ts', import.meta.url), { type: 'module' })
      : new Worker(new URL('../workers/layout.worker.ts', import.meta.url), { type: 'module' })
  let cancel = () => {},
    done = false
  const result = new Promise<LayoutResult>((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('自动整理超时，原布局保留')), 30_000)
    function finish() {
      done = true
      clearTimeout(timer)
      worker.terminate()
    }
    function fail(error: Error) {
      if (done) return
      finish()
      reject(error)
    }
    cancel = () => fail(new Error('自动整理已取消'))
    worker.onerror = (event) => {
      event.preventDefault()
      fail(new Error('自动整理失败：' + event.message))
    }
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (done) return
      const data = event.data
      if (!isRecord(data)) {
        fail(new Error('布局结果无效，原布局保留'))
        return
      }
      if (typeof data.error === 'string') {
        fail(new Error('自动整理失败：' + data.error))
        return
      }
      const { positions } = data
      if (
        !isRecord(positions) ||
        Object.keys(positions).length !== input.nodes.length ||
        !input.nodes.every(({ id }) => Object.hasOwn(positions, id) && isPoint(positions[id]))
      ) {
        fail(new Error('布局结果无效，原布局保留'))
        return
      }
      finish()
      resolve({ positions: positions as Record<string, Point> })
    }
    try {
      worker.postMessage(input)
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)))
    }
  })
  return { result, cancel: () => cancel() }
}
