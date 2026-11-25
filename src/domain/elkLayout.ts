import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js'
import {
  sortedLayoutNodes,
  type LayoutDirection,
  type LayoutInput,
  type LayoutNode,
} from './layout'
import type { Point } from './model'

const elk = new ELK()
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const SEED_ORIENTATION: Record<LayoutDirection, number> = {
  LR: 0,
  TB: Math.PI / 2,
  RL: Math.PI,
  BT: (3 * Math.PI) / 2,
}
const CARD_SPACING = 100
const COMPONENT_SPACING = 180
// Leave room for subpixel rounding in the solver and the canvas transforms.
const SPACING_TOLERANCE = 0.01
const MAX_LOCAL_ALIGNMENT = 36
const MARGIN = 40

function desiredEdgeLength(source: LayoutNode, target: LayoutNode): number {
  // Stress measures center-to-center distance. The half-diagonals also allow diagonal edges.
  const sourceRadius = Math.hypot(source.width, source.height) / 2
  const targetRadius = Math.hypot(target.width, target.height) / 2
  return sourceRadius + targetRadius + CARD_SPACING
}

function connectedComponents(neighbors: ReadonlySet<number>[]): number[][] {
  const visited = new Set<number>()
  const components: number[][] = []
  for (const index of neighbors.keys()) {
    if (visited.has(index)) continue
    const component = [index]
    visited.add(index)
    for (let i = 0; i < component.length; i++) {
      for (const target of neighbors[component[i]]) {
        if (visited.has(target)) continue
        visited.add(target)
        component.push(target)
      }
    }
    components.push(component.sort((a, b) => a - b))
  }
  return components
}

type PositionedCard = Point & { id: string; width: number; height: number }

function cardClearance(a: PositionedCard, b: PositionedCard): number {
  return Math.max(
    Math.abs(a.x - b.x) - (a.width + b.width) / 2,
    Math.abs(a.y - b.y) - (a.height + b.height) / 2,
  )
}

function alignConnectedCards(
  cards: PositionedCard[],
  edges: NonNullable<ElkNode['edges']>,
): boolean {
  const byId = new Map(cards.map((card) => [card.id, card]))
  let minGap = Infinity
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++)
      minGap = Math.min(minGap, cardClearance(cards[i], cards[j]))
  const candidates = edges
    .flatMap((edge) => {
      const a = byId.get(edge.sources[0])!,
        b = byId.get(edge.targets[0])!
      const axis: keyof Point = Math.abs(a.x - b.x) < Math.abs(a.y - b.y) ? 'x' : 'y'
      const shift = Math.abs(a[axis] - b[axis])
      return shift <= MAX_LOCAL_ALIGNMENT ? [{ a, b, axis, shift }] : []
    })
    .sort((a, b) => a.shift - b.shift)
  const aligned = { x: new Set<string>(), y: new Set<string>() }
  let changed = false
  for (const { a, b, axis } of candidates) {
    const fixed = aligned[axis]
    const shift = Math.abs(a[axis] - b[axis])
    if (shift > MAX_LOCAL_ALIGNMENT) continue
    const place = (card: PositionedCard, anchor: PositionedCard) => {
      if (fixed.has(card.id) && shift > 0) return false
      const next = { ...card, [axis]: anchor[axis] }
      if (cards.some((other) => other !== card && cardClearance(next, other) < minGap - 1e-9))
        return false
      card[axis] = next[axis]
      fixed.add(card.id)
      fixed.add(anchor.id)
      return true
    }
    if ((place(b, a) || place(a, b)) && shift > 0) changed = true
  }
  return changed
}

function refineComponent(component: ElkNode, edges: NonNullable<ElkNode['edges']>): ElkNode {
  const cards = (component.children ?? []).map(({ id, x, y, width, height }) => {
    if (x === undefined || y === undefined || width === undefined || height === undefined)
      throw new Error('ELK 未返回卡片外框')
    return { id, width, height, x: x + width / 2, y: y + height / 2 }
  })
  const gap = CARD_SPACING + SPACING_TOLERANCE
  let scale = 1
  for (let i = 0; i < cards.length; i++) {
    const a = cards[i]
    for (let j = i + 1; j < cards.length; j++) {
      const b = cards[j]
      const xScale = ((a.width + b.width) / 2 + gap) / Math.abs(a.x - b.x)
      const yScale = ((a.height + b.height) / 2 + gap) / Math.abs(a.y - b.y)
      // Separation along either axis is sufficient. Pick the smaller factor for this pair.
      scale = Math.max(scale, Math.min(xScale, yScale))
    }
  }
  if (!Number.isFinite(scale)) throw new Error('ELK 返回重合的卡片中心')
  // SPOrE may finish with a small spacing deficit. Move centers while keeping card sizes intact.
  const expanded = scale > 1 + 1e-9
  if (expanded)
    for (const card of cards) {
      card.x *= scale
      card.y *= scale
    }
  const aligned = alignConnectedCards(cards, edges)
  if (!expanded && !aligned) return component
  const placed = cards.map(({ id, x, y, width, height }) => ({
    id,
    width,
    height,
    x: x - width / 2,
    y: y - height / 2,
  }))
  const left = Math.min(...placed.map((node) => node.x))
  const top = Math.min(...placed.map((node) => node.y))
  return {
    id: component.id,
    width: Math.max(...placed.map((node) => node.x + node.width)) - left,
    height: Math.max(...placed.map((node) => node.y + node.height)) - top,
    children: placed.map((node) => ({ ...node, x: node.x - left, y: node.y - top })),
  }
}

function layoutSimpleChain(
  id: string,
  members: number[],
  nodes: LayoutNode[],
  neighbors: ReadonlySet<number>[],
  forward: ReadonlySet<number>[],
  hasExtraEdges: ReadonlySet<number>,
  direction: LayoutDirection,
): ElkNode | undefined {
  const ends = members.filter((index) => neighbors[index].size === 1)
  if (
    members.length < 3 ||
    ends.length !== 2 ||
    members.some((index) => neighbors[index].size > 2 || hasExtraEdges.has(index))
  )
    return

  const chain = [ends[0]]
  let votes = 0
  for (let i = 0; i < chain.length; i++) {
    const from = chain[i]
    for (const to of neighbors[from]) {
      if (to === chain[i - 1]) continue
      chain.push(to)
      votes += Number(forward[from].has(to)) - Number(forward[to].has(from))
    }
  }
  // Apply the selected layout direction to the predominant direction of the chain's arrows.
  if (votes < 0 !== (direction === 'RL' || direction === 'BT')) chain.reverse()
  const horizontal = direction === 'LR' || direction === 'RL'
  const main = horizontal ? 'width' : 'height'
  const cross = horizontal ? 'height' : 'width'
  let breadth = 0
  for (const index of chain) breadth = Math.max(breadth, nodes[index][cross])
  const gap = CARD_SPACING + SPACING_TOLERANCE
  let cursor = 0
  const children = chain.map((index) => {
    const node = nodes[index]
    const offset = (breadth - node[cross]) / 2
    const child = {
      id: 'node-' + index,
      x: horizontal ? cursor : offset,
      y: horizontal ? offset : cursor,
      width: node.width,
      height: node.height,
    }
    cursor += node[main] + gap
    return child
  })
  return { id, [main]: cursor - gap, [cross]: breadth, children }
}

async function layoutComponent(
  members: number[],
  nodes: LayoutNode[],
  neighbors: ReadonlySet<number>[],
  forward: ReadonlySet<number>[],
  hasExtraEdges: ReadonlySet<number>,
  direction: LayoutDirection,
): Promise<ElkNode> {
  const id = 'component-' + members[0]
  const chain = layoutSimpleChain(id, members, nodes, neighbors, forward, hasExtraEdges, direction)
  if (chain) return chain
  const children = members.map((index, order) => {
    const { width, height } = nodes[index]
    const radius = 200 * Math.sqrt(order)
    const angle = SEED_ORIENTATION[direction] + GOLDEN_ANGLE * order
    return {
      id: 'node-' + index,
      width,
      height,
      x: radius * Math.cos(angle) - width / 2,
      y: radius * Math.sin(angle) - height / 2,
    }
  })
  if (members.length === 1) {
    const [node] = children
    return { id, width: node.width, height: node.height, children: [{ ...node, x: 0, y: 0 }] }
  }

  const graph: ElkNode = {
    id,
    layoutOptions: {
      // Run Stress from the supplied seed, then resolve overlaps using the card rectangles.
      'elk.algorithm': 'sporeOverlap',
      'elk.underlyingLayoutAlgorithm': 'org.eclipse.elk.stress',
      'elk.interactive': 'true',
      'elk.stress.iterationLimit': members.length > 200 ? '20' : '64',
      'elk.spacing.nodeNode': String(CARD_SPACING + SPACING_TOLERANCE),
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
    },
    children,
    edges: members.flatMap((source) =>
      [...neighbors[source]]
        .filter((target) => source < target)
        .sort((a, b) => a - b)
        .map((target) => ({
          id: 'edge-' + source + '-' + target,
          sources: ['node-' + source],
          targets: ['node-' + target],
          layoutOptions: {
            'elk.stress.desiredEdgeLength': String(desiredEdgeLength(nodes[source], nodes[target])),
          },
        })),
    ),
  }
  return refineComponent(await elk.layout(graph), graph.edges!)
}

export async function calculateGraphLayout(
  input: LayoutInput,
): Promise<{ positions: Record<string, Point> }> {
  const nodes = sortedLayoutNodes(input)
  if (!nodes.length) return { positions: {} }
  const indices = new Map(nodes.map(({ id }, index) => [id, index]))
  const neighbors = nodes.map(() => new Set<number>())
  const forward = nodes.map(() => new Set<number>())
  const hasExtraEdges = new Set<number>()
  // Direction, parallel edges and loops are kept in the project and rendered by the live router.
  // Stress only needs a single undirected adjacency between distinct cards.
  for (const edge of input.edges) {
    const source = indices.get(edge.source)
    const target = indices.get(edge.target)
    if (source === undefined || target === undefined) throw new Error('布局连线引用了未知节点')
    if (source === target || neighbors[source].has(target)) {
      hasExtraEdges.add(source)
      continue
    }
    neighbors[source].add(target)
    neighbors[target].add(source)
    if (edge.direction === 'forward') forward[source].add(target)
  }

  const components = []
  // Keep the worker's memory bounded by laying out one component at a time.
  for (const members of connectedComponents(neighbors))
    components.push(
      await layoutComponent(members, nodes, neighbors, forward, hasExtraEdges, input.direction),
    )

  const packing =
    components.length === 1
      ? [{ id: components[0].id, x: MARGIN, y: MARGIN }]
      : (
          await elk.layout({
            id: 'graph',
            layoutOptions: {
              'elk.algorithm': 'rectpacking',
              'elk.aspectRatio': '1.2',
              'elk.spacing.nodeNode': String(COMPONENT_SPACING + SPACING_TOLERANCE),
              'elk.padding': `[top=${MARGIN},left=${MARGIN},bottom=${MARGIN},right=${MARGIN}]`,
            },
            children: components.map(({ id, width, height }) => ({ id, width, height })),
          })
        ).children
  const offsets = new Map(packing?.map((part) => [part.id, part]))
  const placements = new Map<string, Point>()
  for (const component of components) {
    const offset = offsets.get(component.id)
    if (offset?.x === undefined || offset.y === undefined) throw new Error('ELK 未返回分量位置')
    for (const node of component.children ?? []) {
      if (node.x === undefined || node.y === undefined) throw new Error('ELK 未返回节点位置')
      // Place each packed component by translation so its internal clearances stay intact.
      placements.set(node.id, { x: offset.x + node.x, y: offset.y + node.y })
    }
  }
  return {
    positions: Object.fromEntries(
      nodes.map(({ id }, index) => {
        const position = placements.get('node-' + index)
        if (!position) throw new Error('ELK 未返回节点位置')
        return [id, position]
      }),
    ),
  }
}
