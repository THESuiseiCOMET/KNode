import { calculateLayout, type LayoutInput } from '../domain/layout'

// The worker receives only geometry and relations and returns positions only.
self.onmessage = (event: MessageEvent<LayoutInput>) => {
  try {
    self.postMessage({ positions: calculateLayout(event.data) })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
