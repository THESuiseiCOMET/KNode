import type { Point } from './model'
import type { Side } from './canvas'
import type { LayoutDirection } from './layout'

export interface NodeBounds extends Point {
  width: number
  height: number
}
export interface ConnectionLink {
  source: string
  target: string
}
export const layoutConnectorSides: Record<LayoutDirection, [Side, Side]> = {
  LR: ['right', 'left'],
  TB: ['bottom', 'top'],
  RL: ['left', 'right'],
  BT: ['top', 'bottom'],
}

export function isFacingTarget(from: NodeBounds, to: NodeBounds, side: Side): boolean {
  switch (side) {
    case 'right':
      return to.x >= from.x + from.width
    case 'left':
      return to.x + to.width <= from.x
    case 'bottom':
      return to.y >= from.y + from.height
    case 'top':
      return to.y + to.height <= from.y
  }
}
/** Infer tree rank alignment from saved positions and measured node bounds.
 * Siblings use facing handles so the curves stay in the gap between ranks.
 */
export function alignedConnectorSides(
  bounds: ReadonlyMap<string, NodeBounds>,
  links: readonly ConnectionLink[],
): Map<string, [Side, Side]> {
  const targets = new Map<string, Set<string>>(),
    result = new Map<string, [Side, Side]>()
  for (const { source, target } of links) {
    if (source === target || !bounds.has(source) || !bounds.has(target)) continue
    const ids = targets.get(source) ?? new Set<string>()
    ids.add(target)
    targets.set(source, ids)
  }
  const epsilon = 1
  for (const [source, ids] of targets) {
    if (ids.size < 2) continue
    const from = bounds.get(source)!,
      peers = [...ids].map((id) => bounds.get(id)!)
    if (
      peers.every(
        (p) => Math.abs(p.x - peers[0].x) < epsilon && Math.abs(p.y - peers[0].y) < epsilon,
      )
    )
      continue
    const same = (coordinate: (p: NodeBounds) => number) =>
      peers.every((p) => Math.abs(coordinate(p) - coordinate(peers[0])) <= epsilon)
    const candidates: [Side, Side][] = []
    if (same((p) => p.x) && peers.every((p) => p.x >= from.x + from.width))
      candidates.push(['right', 'left'])
    if (same((p) => p.x + p.width) && peers.every((p) => p.x + p.width <= from.x))
      candidates.push(['left', 'right'])
    if (same((p) => p.y) && peers.every((p) => p.y >= from.y + from.height))
      candidates.push(['bottom', 'top'])
    if (same((p) => p.y + p.height) && peers.every((p) => p.y + p.height <= from.y))
      candidates.push(['top', 'bottom'])
    if (candidates.length === 1) result.set(source, candidates[0])
  }
  return result
}

/** Prefer an unused corner so the loop does not cross the normal branch fan. */
export function selfLoopSides(occupied: ReadonlySet<Side>): ['left' | 'right', 'top' | 'bottom'] {
  const corners: ['left' | 'right', 'top' | 'bottom'][] = [
    ['right', 'top'],
    ['left', 'top'],
    ['right', 'bottom'],
    ['left', 'bottom'],
  ]
  const score = (pair: readonly Side[]) =>
    pair.reduce((sum, side) => sum + Number(occupied.has(side)), 0)
  return corners.reduce((best, pair) => (score(pair) < score(best) ? pair : best))
}
