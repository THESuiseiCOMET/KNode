export interface Point {
  x: number
  y: number
}
export interface Viewport extends Point {
  zoom: number
}
export interface ForestNode {
  id: string
  title: string
  parentId: string | null
  progress: number
  weight: number
  color: string | null
  linkedPaths?: string[]
}
export interface ProjectDocument {
  format: 'forest-project'
  version: 3
  projectId: string
  name: string
  views: ProjectViews
  nodes: ForestNode[]
}

export type ViewName = 'tree' | 'graph'
export interface GraphEdge {
  id: string
  source: string
  target: string
  direction: 'forward' | 'both' | 'undirected'
  label?: string
}
export interface TreeView {
  positions: Record<string, Point>
  collapsedIds: string[]
  viewport: Viewport
}
export interface GraphView {
  positions: Record<string, Point>
  edges: GraphEdge[]
  viewport: Viewport
}
export interface ProjectViews {
  tree: TreeView
  graph: GraphView
}

export class ValidationError extends Error {}
export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ValidationError(message)
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function validTitle(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
}
export function validFilename(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 240 &&
    !/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    !/[. ]$/u.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(value)
  )
}
export function validNodeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value) && validFilename(value)
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
export const MAX_COORDINATE = 1e9
const coordinate = (v: unknown): v is number => finite(v) && Math.abs(v) <= MAX_COORDINATE
function point(value: unknown): boolean {
  return isRecord(value) && coordinate(value.x) && coordinate(value.y)
}
function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  ensure(
    Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k)),
    `${label} 字段不完整或含不支持字段；拒绝改写`,
  )
}

/** Reject rather than repair: a failed load must never become an empty editable project. */
export function validateProject(value: unknown): asserts value is ProjectDocument {
  ensure(isRecord(value), '项目必须是 JSON 对象')
  ensure(value.format === 'forest-project', '不是 Forest Editor 项目')
  ensure(value.version === 3, '不支持的项目版本：仅支持 V3，未迁移或覆盖原文件')
  exactKeys(value, ['format', 'version', 'projectId', 'name', 'views', 'nodes'], '项目')
  ensure(typeof value.projectId === 'string' && uuid.test(value.projectId), 'projectId 必须是 UUID')
  ensure(validTitle(value.name), '项目名称必须为 1–200 字符且不含控制字符')
  ensure(Array.isArray(value.nodes), 'nodes 必须是数组')
  const ids = new Set<string>(),
    directoryIds = new Set<string>()
  for (const n of value.nodes as unknown[]) {
    ensure(isRecord(n), '节点必须是对象')
    exactKeys(
      n,
      [
        'id',
        'title',
        'parentId',
        'progress',
        'weight',
        'color',
        ...(Object.hasOwn(n, 'linkedPaths') ? ['linkedPaths'] : []),
      ],
      '节点',
    )
    ensure(
      validNodeId(n.id) && !directoryIds.has(n.id.toLowerCase()),
      '节点 ID 不安全或重复（忽略大小写）',
    )
    ids.add(n.id)
    directoryIds.add(n.id.toLowerCase())
    ensure(validTitle(n.title), '节点标题必须为 1–200 字符且不含控制字符')
    ensure(n.parentId === null || typeof n.parentId === 'string', 'parentId 无效')
    ensure(finite(n.progress) && n.progress >= 0 && n.progress <= 100, '手动进度必须为 0–100')
    ensure(
      typeof n.weight === 'number' && Number.isSafeInteger(n.weight) && n.weight >= 0,
      '权重必须是非负安全整数',
    )
    ensure(
      n.color === null || (typeof n.color === 'string' && /^#[0-9a-f]{6}$/iu.test(n.color)),
      '颜色必须为 null 或六位 HEX',
    )
    if (Object.hasOwn(n, 'linkedPaths')) {
      ensure(
        Array.isArray(n.linkedPaths) &&
          n.linkedPaths.length > 0 &&
          n.linkedPaths.every(validLinkedPath),
        'linkedPaths 必须为非空路径数组，无关联时省略',
      )
      ensure(
        new Set(n.linkedPaths.map(linkedPathKey)).size === n.linkedPaths.length,
        '外部关联路径重复',
      )
    }
  }
  validateViews(value.views, ids)
  const parents = new Map((value.nodes as ForestNode[]).map((n) => [n.id, n.parentId]))
  const finished = new Set<string>()
  for (const n of value.nodes as ForestNode[]) {
    ensure(
      n.parentId === null || (n.parentId !== n.id && ids.has(n.parentId)),
      '父节点缺失或节点自连',
    )
    const visiting = new Set<string>()
    let cursor: string | null = n.id
    while (cursor !== null && !finished.has(cursor)) {
      ensure(!visiting.has(cursor), '禁止循环父子关系')
      visiting.add(cursor)
      cursor = parents.get(cursor) ?? null
    }
    for (const id of visiting) finished.add(id)
  }
}
export function parseProject(json: string): ProjectDocument {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new ValidationError('JSON 语法损坏，未打开或覆盖文件')
  }
  validateProject(value)
  return value
}
/** Explicit schema projection; no Vue Flow fields can leak to disk. */
export function serializeProject(p: ProjectDocument): string {
  validateProject(p)
  return JSON.stringify(p, null, 2) + '\n'
}
export function createProject(name: string, projectId: string): ProjectDocument {
  const p: ProjectDocument = {
    format: 'forest-project',
    version: 3,
    projectId,
    name: name.trim(),
    views: {
      tree: { positions: {}, collapsedIds: [], viewport: { x: 0, y: 0, zoom: 1 } },
      graph: { positions: {}, edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    },
    nodes: [],
  }
  validateProject(p)
  return p
}

function validateViews(value: unknown, ids: ReadonlySet<string>): void {
  ensure(isRecord(value), 'views 必须是对象')
  exactKeys(value, ['tree', 'graph'], 'views')
  for (const mode of ['tree', 'graph'] as const) {
    const view = value[mode]
    ensure(isRecord(view), '视图必须是对象')
    exactKeys(view, ['positions', mode === 'tree' ? 'collapsedIds' : 'edges', 'viewport'], '视图')
    ensure(isRecord(view.positions), 'positions 必须是节点坐标映射')
    for (const [id, position] of Object.entries(view.positions)) {
      ensure(ids.has(id), '视图引用不存在的节点')
      ensure(point(position) && isRecord(position), '节点坐标无效')
      exactKeys(position, ['x', 'y'], '坐标')
    }
    if (mode === 'tree') {
      ensure(Object.keys(view.positions).length === ids.size, '树视图必须包含所有节点坐标')
      ensure(Array.isArray(view.collapsedIds), 'collapsedIds 必须是数组')
      ensure(
        view.collapsedIds.every((id) => typeof id === 'string' && ids.has(id)) &&
          new Set(view.collapsedIds).size === view.collapsedIds.length,
        '折叠节点缺失或重复',
      )
    } else {
      ensure(Array.isArray(view.edges), 'edges 必须是数组')
      const edgeIds = new Set<string>()
      for (const edge of view.edges as unknown[]) {
        ensure(isRecord(edge), '图边必须是对象')
        exactKeys(
          edge,
          [
            'id',
            'source',
            'target',
            'direction',
            ...(Object.hasOwn(edge, 'label') ? ['label'] : []),
          ],
          '图边',
        )
        ensure(validNodeId(edge.id) && !edgeIds.has(edge.id), '图边 ID 无效或重复')
        edgeIds.add(edge.id)
        ensure(
          typeof edge.source === 'string' &&
            Object.hasOwn(view.positions, edge.source) &&
            typeof edge.target === 'string' &&
            Object.hasOwn(view.positions, edge.target),
          '图边端点必须属于图视图',
        )
        ensure(
          typeof edge.direction === 'string' &&
            ['forward', 'both', 'undirected'].includes(edge.direction),
          '图边方向无效',
        )
        if (Object.hasOwn(edge, 'label')) ensure(validTitle(edge.label), '图边说明无效')
      }
    }
    ensure(point(view.viewport) && isRecord(view.viewport), '视口坐标无效')
    exactKeys(view.viewport, ['x', 'y', 'zoom'], '视口')
    ensure(
      finite(view.viewport.zoom) && view.viewport.zoom >= 0.2 && view.viewport.zoom <= 2.5,
      '缩放范围必须为 0.2–2.5',
    )
  }
}

/** Windows path spelling key; filesystem aliases are additionally deduplicated by Rust. */
export function linkedPathKey(path: string): string {
  const source = path.replaceAll('\\', '/').toLowerCase()
  const prefix = source.startsWith('//') ? '//' : ''
  const parts: string[] = []
  for (const part of source.split('/')) {
    if (!part || part === '.') continue
    if (part === '..' && parts.length && parts.at(-1) !== '..' && !parts.at(-1)!.endsWith(':'))
      parts.pop()
    else parts.push(part)
  }
  return prefix + parts.join('/')
}
export function validLinkedPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f-\u009f<>"|?*]/u.test(value)
  )
    return false
  const path = value.replaceAll('\\', '/')
  if (path.startsWith('/') && !path.startsWith('//')) return false
  const drive = /^[a-z]:\//iu.test(path)
  if (path.includes(':') && (!drive || path.slice(2).includes(':'))) return false
  const rest = drive ? path.slice(3) : path.startsWith('//') ? path.slice(2) : path
  if (path.startsWith('//') && rest.split('/').filter(Boolean).length < 2) return false
  return (
    rest === '' ||
    rest.split('/').every((part) => part === '.' || part === '..' || validFilename(part))
  )
}
