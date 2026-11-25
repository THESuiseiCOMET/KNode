import { calculateGraphLayout } from '../domain/elkLayout'
import type { LayoutInput } from '../domain/layout'

self.onmessage = async (event: MessageEvent<LayoutInput>) => {
  try {
    self.postMessage(await calculateGraphLayout(event.data))
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
