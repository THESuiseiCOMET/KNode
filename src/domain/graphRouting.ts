import type { Side } from './canvas'
import { selfLoopSides, type NodeBounds } from './connections'
import type { GraphEdge, Point } from './model'

export interface GraphRoute {
  handles: [Side, Side]
  offsets: [number, number]
  points: Point[]
  loop?: number
}

const CLEARANCE = 10
const LEAD = 16
const LANE_GAP = 14
const SWITCH_COST = 36
const sides: Side[] = ['right', 'left', 'bottom', 'top']
const normals: Record<Side, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
}

export function offsetPort(point: Point, side: Side, offset: number): Point {
  return normals[side].x ? { x: point.x, y: point.y + offset } : { x: point.x + offset, y: point.y }
}

function port(box: NodeBounds, side: Side, tangent: number): Point {
  const { x, y } = normals[side]
  return x
    ? { x: box.x + (box.width * (1 + x)) / 2, y: tangent }
    : { x: tangent, y: box.y + (box.height * (1 + y)) / 2 }
}

function extend(point: Point, side: Side, clearance = LEAD): Point {
  const { x, y } = normals[side]
  return { x: point.x + x * clearance, y: point.y + y * clearance }
}

const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

function corners(points: Point[]): Point[] {
  const result: Point[] = []
  for (const point of points) {
    while (result.length >= 2) {
      const last = result.at(-1)!,
        previous = result.at(-2)!
      if (!(
        (previous.x === last.x && last.x === point.x) ||
        (previous.y === last.y && last.y === point.y)
      ))
        break
      result.pop()
    }
    if (!result.length || !same(result.at(-1)!, point)) result.push(point)
  }
  return result
}

/** Round only the corners of an orthogonal polyline. */
export function graphRoutePath(route: GraphRoute): string {
  const points = route.points
  const start = points[0],
    end = points.at(-1)!
  let path = 'M ' + start.x + ' ' + start.y
  for (let i = 1; i < points.length - 1; i++) {
    const before = points[i - 1],
      corner = points[i],
      after = points[i + 1]
    const enter = distance(before, corner),
      exit = distance(after, corner)
    const turn =
      (corner.x - before.x) * (after.y - corner.y) - (corner.y - before.y) * (after.x - corner.x)
    const radius = Math.min(9, enter / 2, exit / 2)
    const toward = (point: Point) =>
      corner.x +
      Math.sign(point.x - corner.x) * radius +
      ' ' +
      (corner.y + Math.sign(point.y - corner.y) * radius)
    path += turn
      ? ` L ${toward(before)} A ${radius} ${radius} 0 0 ${turn > 0 ? 1 : 0} ${toward(after)}`
      : ` L ${corner.x} ${corner.y}`
  }
  return path + ' L ' + end.x + ' ' + end.y
}

interface Segment {
  horizontal: boolean
  axis: number
  low: number
  high: number
}

function segments(points: Point[]): Segment[] {
  return points.slice(1).map((point, i) => {
    const from = points[i],
      horizontal = point.y === from.y
    const a = horizontal ? from.x : from.y,
      b = horizontal ? point.x : point.y
    return {
      horizontal,
      axis: horizontal ? point.y : point.x,
      low: Math.min(a, b),
      high: Math.max(a, b),
    }
  })
}

function hitsBox(segment: Segment, box: NodeBounds): boolean {
  const cross = segment.horizontal ? box.y : box.x
  const main = segment.horizontal ? box.x : box.y
  const depth = segment.horizontal ? box.height : box.width
  const width = segment.horizontal ? box.width : box.height
  return (
    cross < segment.axis &&
    segment.axis < cross + depth &&
    segment.high > main &&
    segment.low < main + width
  )
}

function conflict(a: Segment, b: Segment): number {
  if (a.horizontal === b.horizontal) {
    if (Math.abs(a.axis - b.axis) >= LANE_GAP) return 0
    const shared = Math.min(a.high, b.high) - Math.max(a.low, b.low)
    return shared > 0 ? Math.min(shared, 240) * (a.axis === b.axis ? 1.5 : 0.5) : 0
  }
  return a.low < b.axis && b.axis < a.high && b.low < a.axis && a.axis < b.high ? 45 : 0
}

type Box = NodeBounds & { id: string }

type SidePair = GraphRoute['handles']
interface PortRange {
  low: number
  high: number
  center: number
}
interface Candidate {
  route: GraphRoute
  hits: number
  shared: number
  bends: number
  cost: number
}

function portRange(box: NodeBounds, side: Side): PortRange {
  const horizontal = normals[side].x !== 0
  const start = horizontal ? box.y : box.x
  const extent = horizontal ? box.height : box.width
  const inset = Math.min(LEAD, extent / 2)
  return { low: start + inset, high: start + extent - inset, center: start + extent / 2 }
}

function portOverlap(position: number, used: readonly number[]): number {
  return used.reduce((sum, p) => {
    const missing = LANE_GAP - Math.abs(p - position)
    return sum + (missing > 1e-6 ? missing : 0)
  }, 0)
}

function slots(
  low: number,
  high: number,
  desired: number,
  used: readonly number[],
  extra: readonly number[] = [],
): number[] {
  if (low > high) return []
  const clamp = (p: number) => Math.max(low, Math.min(high, p))
  const values = new Set([clamp(desired), low, high, ...extra.map(clamp)])
  for (const p of used) {
    values.add(clamp(p - LANE_GAP))
    values.add(clamp(p + LANE_GAP))
  }
  return [...values]
    .map((position) => ({ position, crowding: portOverlap(position, used) }))
    .sort(
      (a, b) =>
        a.crowding - b.crowding || Math.abs(a.position - desired) - Math.abs(b.position - desired),
    )
    .map(({ position }) => position)
}

function boundaryLanes(boxes: readonly Box[], horizontal: boolean): number[] {
  return boxes.flatMap((box) =>
    horizontal
      ? [box.y - 0.01, box.y + box.height + 0.01]
      : [box.x - 0.01, box.x + box.width + 0.01],
  )
}

function outwardDistance(port: Point, next: Point, side: Side): number {
  const { x, y } = normals[side]
  return (next.x - port.x) * x + (next.y - port.y) * y
}

function chooseRoute(
  from: NodeBounds,
  to: NodeBounds,
  choices: SidePair[],
  obstacles: Box[],
  traffic: Segment[],
  previous: GraphRoute | undefined,
  reserved: (side: Side, end: 0 | 1) => readonly number[],
  loop?: number,
): GraphRoute {
  let best: Candidate | undefined
  const detours: (() => void)[] = []
  for (const handles of choices) {
    const [source, target] = handles
    const fromRange = portRange(from, source),
      toRange = portRange(to, target)
    const fromUsed = reserved(source, 0),
      toUsed = reserved(target, 1)
    const fromSlot = slots(fromRange.low, fromRange.high, fromRange.center, fromUsed)[0]
    const toSlot = slots(toRange.low, toRange.high, toRange.center, toUsed)[0]
    const horizontal = normals[source].x !== 0
    const sameAxis = horizontal === (normals[target].x !== 0)
    const switching = previous
      ? SWITCH_COST *
        (Number(previous.handles[0] !== source) + Number(previous.handles[1] !== target))
      : 0
    const consider = (raw: Point[], first = fromSlot, last = toSlot) => {
      const points = corners(raw)
      if (
        points.length < 2 ||
        outwardDistance(points[0], points[1], source) <= 0 ||
        outwardDistance(points.at(-1)!, points.at(-2)!, target) <= 0
      )
        return
      const bends = points.length - 2
      const spans = segments(points)
      const hits =
        obstacles.filter((box) => spans.some((span) => hitsBox(span, box))).length +
        Number(spans.some((span) => hitsBox(span, from))) +
        Number(spans.some((span) => hitsBox(span, to)))
      if (best && hits > best.hits) return
      let shared = portOverlap(first, fromUsed) + portOverlap(last, toUsed)
      let trafficCost = 0
      for (const a of spans)
        for (const b of traffic) {
          trafficCost += conflict(a, b)
          if (a.axis === b.axis && a.horizontal === b.horizontal)
            shared += Math.max(0, Math.min(a.high, b.high) - Math.max(a.low, b.low))
        }
      const cost =
        switching +
        trafficCost +
        (Math.abs(first - fromRange.center) + Math.abs(last - toRange.center)) / 4 +
        spans.reduce((sum, span, index) => {
          const length = span.high - span.low
          // Prefer a usable straight run at a corner over a small jog of the same bend count.
          return (
            sum +
            length +
            (index > 0 && index < spans.length - 1 ? 4 * Math.max(0, LEAD - length) : 0)
          )
        }, 0) +
        (loop === undefined ? 0 : (fromUsed.length + toUsed.length) * 48)
      const rank = best
        ? hits - best.hits || shared - best.shared || bends - best.bends || cost - best.cost
        : -1
      if (rank < 0) {
        best = {
          route: {
            handles,
            offsets: [first - fromRange.center, last - toRange.center],
            points,
            loop,
          },
          hits,
          shared,
          bends,
          cost,
        }
      }
    }

    const a = port(from, source, fromSlot)
    const b = port(to, target, toSlot)
    if (loop !== undefined) {
      const clearance = 20 + Math.floor(loop / 4) * 9
      const p = extend(a, source, clearance),
        q = extend(b, target, clearance)
      consider([a, p, { x: p.x, y: q.y }, q, b])
      continue
    }

    if (sameAxis && outwardDistance(a, b, source) > 0 && outwardDistance(b, a, target) > 0) {
      const low = Math.max(fromRange.low, toRange.low)
      const high = Math.min(fromRange.high, toRange.high)
      const near = (fromRange.center + toRange.center) / 2
      const mainLow = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y)
      const mainHigh = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y)
      const blockers = obstacles.filter((box) =>
        horizontal
          ? box.x < mainHigh && box.x + box.width > mainLow
          : box.y < mainHigh && box.y + box.height > mainLow,
      )
      const used = [...fromUsed, ...toUsed]
      for (const span of traffic)
        if (span.horizontal === horizontal && span.high > mainLow && span.low < mainHigh)
          used.push(span.axis)
      for (const lane of slots(low, high, near, used, boundaryLanes(blockers, horizontal))) {
        consider([port(from, source, lane), port(to, target, lane)], lane, lane)
        if (best?.hits === 0 && best.shared === 0 && best.bends === 0) break
      }
    }

    if (best?.hits === 0 && best.shared === 0 && best.bends === 0) continue
    if (!sameAxis) {
      // A perpendicular pair has one elbow. Slide each port only within its usable edge.
      const beforeSign = horizontal ? normals[target].y : normals[target].x
      const afterSign = horizontal ? normals[source].x : normals[source].y
      const firstLimit = horizontal ? b.y : b.x
      const lastLimit = horizontal ? a.x : a.y
      const firstSlots = slots(
        beforeSign > 0 ? Math.max(fromRange.low, firstLimit + LEAD) : fromRange.low,
        beforeSign < 0 ? Math.min(fromRange.high, firstLimit - LEAD) : fromRange.high,
        fromRange.center,
        fromUsed,
        boundaryLanes(obstacles, horizontal),
      ).slice(0, 4)
      const lastSlots = slots(
        afterSign > 0 ? Math.max(toRange.low, lastLimit + LEAD) : toRange.low,
        afterSign < 0 ? Math.min(toRange.high, lastLimit - LEAD) : toRange.high,
        toRange.center,
        toUsed,
        boundaryLanes(obstacles, !horizontal),
      ).slice(0, 4)
      for (const first of firstSlots) {
        for (const last of lastSlots) {
          const start = port(from, source, first)
          const end = port(to, target, last)
          consider(
            [start, horizontal ? { x: end.x, y: start.y } : { x: start.x, y: end.y }, end],
            first,
            last,
          )
        }
      }
    }
    if (best?.hits === 0 && best.shared === 0 && best.bends < 2) continue

    const p = extend(a, source),
      q = extend(b, target)
    const across = (x: number) => consider([a, p, { x, y: p.y }, { x, y: q.y }, q, b])
    const down = (y: number) => consider([a, p, { x: p.x, y }, { x: q.x, y }, q, b])
    for (const x of [(p.x + q.x) / 2, p.x, q.x]) across(x)
    for (const y of [(p.y + q.y) / 2, p.y, q.y]) down(y)
    detours.push(() => {
      const lanes = (axis: 'x' | 'y', extent: 'width' | 'height') => {
        const middle = (p[axis] + q[axis]) / 2
        const candidates = new Set([
          middle - LANE_GAP,
          middle + LANE_GAP,
          p[axis] - LANE_GAP,
          q[axis] + LANE_GAP,
        ])
        let low = Infinity,
          high = -Infinity
        for (const box of obstacles) {
          low = Math.min(low, box[axis])
          high = Math.max(high, box[axis] + box[extent])
          candidates.add(box[axis])
          candidates.add(box[axis] + box[extent])
        }
        const nearest = [...candidates]
          .sort((x, y) => Math.abs(x - middle) - Math.abs(y - middle))
          .slice(0, 10)
        return obstacles.length ? [...new Set([...nearest, low, high])] : nearest
      }
      const xs = lanes('x', 'width'),
        ys = lanes('y', 'height')
      xs.forEach(across)
      ys.forEach(down)
      if (best?.hits) {
        for (const x of xs.slice(0, 5))
          for (const y of ys.slice(0, 5)) {
            consider([a, p, { x, y: p.y }, { x, y }, { x: q.x, y }, q, b])
            consider([a, p, { x: p.x, y }, { x, y }, { x, y: q.y }, q, b])
          }
      }
    })
  }

  if (!best || best.hits > 0 || best.shared > 0 || best.bends > 2)
    detours.forEach((search) => search())
  return best!.route
}

function envelope(a: NodeBounds, b: NodeBounds, margin: number): NodeBounds {
  const x = Math.min(a.x, b.x) - margin,
    y = Math.min(a.y, b.y) - margin
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) + margin - x,
    height: Math.max(a.y + a.height, b.y + b.height) + margin - y,
  }
}

function nearby(rect: NodeBounds, area: NodeBounds): boolean {
  return (
    rect.x <= area.x + area.width &&
    rect.x + rect.width >= area.x &&
    rect.y <= area.y + area.height &&
    rect.y + rect.height >= area.y
  )
}

/** Graph-only routing, with ports and lanes reserved in deterministic edge order. */
export function routeGraphEdges(
  bounds: ReadonlyMap<string, NodeBounds>,
  edges: readonly GraphEdge[],
  previous?: ReadonlyMap<string, GraphRoute>,
): Map<string, GraphRoute> {
  const routes = new Map<string, GraphRoute>()
  if (!edges.length) return routes
  const boxes: Box[] = [...bounds].map(([id, box]) => ({ id, ...envelope(box, box, CLEARANCE) }))
  const ports = new Map<string, number[]>()
  const loops = new Map<string, number>()
  const used: Segment[] = []
  const ordered = edges
    .filter((e) => bounds.has(e.source) && bounds.has(e.target))
    .sort(
      (a, b) =>
        Number(a.source === a.target) - Number(b.source === b.target) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
  const key = (id: string, side: Side) => id + ':' + side
  const allPairs: SidePair[] = sides.flatMap((source) =>
    sides.map((target): SidePair => [source, target]),
  )
  for (const edge of ordered) {
    const from = bounds.get(edge.source)!
    const to = bounds.get(edge.target)!
    const reserved = (side: Side, end: 0 | 1): readonly number[] =>
      ports.get(key(end === 0 ? edge.source : edge.target, side)) ?? []
    let choices = allPairs
    let loop: number | undefined
    if (edge.source === edge.target) {
      loop = loops.get(edge.source) ?? 0
      loops.set(edge.source, loop + 1)
      const preferred = selfLoopSides(new Set(sides.filter((side) => reserved(side, 0).length)))
      const corners: SidePair[] = [
        ['right', 'top'],
        ['left', 'top'],
        ['right', 'bottom'],
        ['left', 'bottom'],
      ]
      choices = [preferred, ...corners.filter(([a, b]) => a !== preferred[0] || b !== preferred[1])]
    }
    const area = envelope(from, to, 90)
    const obstacles = boxes.filter(
      (box) => box.id !== edge.source && box.id !== edge.target && nearby(box, area),
    )
    const traffic = used
      .filter(({ horizontal, axis, low, high }) =>
        horizontal
          ? axis >= area.y &&
            axis <= area.y + area.height &&
            low <= area.x + area.width &&
            high >= area.x
          : axis >= area.x &&
            axis <= area.x + area.width &&
            low <= area.y + area.height &&
            high >= area.y,
      )
      .slice(-48)
    const route = chooseRoute(
      from,
      to,
      choices,
      obstacles,
      traffic,
      previous?.get(edge.id),
      reserved,
      loop,
    )
    routes.set(edge.id, route)
    used.push(...segments(route.points))
    for (const end of [0, 1] as const) {
      const side = route.handles[end]
      const portKey = key(end === 0 ? edge.source : edge.target, side)
      const list = ports.get(portKey) ?? []
      const terminal = end === 0 ? route.points[0] : route.points.at(-1)!
      list.push(normals[side].x ? terminal.y : terminal.x)
      ports.set(portKey, list)
    }
  }
  return routes
}
