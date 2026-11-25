import { describe, expect, it } from 'vitest'
import { createProject, parseProject, serializeProject } from '../src/domain/model'
import { createRoot, setWeight, setManualProgress, renameNode } from '../src/domain/forest'
import { copyNodes, pasteNodes } from '../src/domain/canvas'
import { setLinkedPaths, validLinkedPath } from '../src/domain/linkedPaths'
import { CanvasHistory } from '../src/application/history'
const initial = () =>
  createRoot(
    createRoot(createProject('关联', 'c0e631c4-9154-4478-b7af-a2d166e62a36'), 'a', 'A', {
      x: 0,
      y: 0,
    }),
    'b',
    'B',
    { x: 400, y: 0 },
  )
describe('外部关联数据', () => {
  it('无关联时省略字段，多文件/目录及不同节点同一目标保存重开', () => {
    const original = initial()
    expect(serializeProject(original)).not.toContain('linkedPaths')
    const paths = ['../notes/a.txt', '../folder', 'D:/reference/book.pdf', '//server/share/reports']
    const p = setLinkedPaths(setLinkedPaths(original, 'a', paths), 'b', paths)
    expect(parseProject(serializeProject(p))).toEqual(p)
    expect(original.nodes[0].linkedPaths).toBeUndefined()
    expect(setLinkedPaths(p, 'a', []).nodes[0]).not.toHaveProperty('linkedPaths')
  })
  it('忽略大小写、分隔符与点组件去重；不修改输入数组', () => {
    const paths = [
      '../Notes/a.txt',
      '..\\notes\\a.txt',
      '../notes/./a.txt',
      '../notes/sub/../a.txt',
    ]
    const p = setLinkedPaths(initial(), 'a', paths)
    expect(p.nodes[0].linkedPaths).toEqual([paths[0]])
    expect(paths).toHaveLength(4)
    paths[0] = 'changed'
    expect(p.nodes[0].linkedPaths).toEqual(['../Notes/a.txt'])
  })
  it.each([
    '',
    'C:relative',
    '//?/C:/x',
    '//./C:/x',
    '/Windows',
    'a:stream',
    'a\n',
    'a//b',
    'NUL',
    'x.',
  ])('拒绝格式不安全的路径 %j', (path) => {
    expect(validLinkedPath(path)).toBe(false)
    expect(() => setLinkedPaths(initial(), 'a', [path])).toThrow()
  })
  it('拒绝损坏类型与重复 JSON，不静默清除关联', () => {
    for (const bad of [null, [], 'x', [42], ['x', './X']]) {
      const p = JSON.parse(serializeProject(initial()))
      p.nodes[0].linkedPaths = bad
      expect(() => parseProject(JSON.stringify(p))).toThrow()
    }
  })
  it('权重进度与重命名保留路径；历史和副本只处理引用', () => {
    const original = initial(),
      history = new CanvasHistory()
    const linked = setLinkedPaths(original, 'a', ['../note.txt'])
    history.record(original, linked)
    expect(history.undo(linked)).toEqual(original)
    expect(history.redo(original)).toEqual(linked)
    const edited = renameNode(setManualProgress(setWeight(linked, 'a', 0), 'a', 73), 'a', '重命名')
    expect(edited.nodes[0].linkedPaths).toEqual(['../note.txt'])
    const pasted = pasteNodes(edited, copyNodes(edited, ['a']), { x: 800, y: 0 }, () => 'copy')
    expect(pasted.nodes.at(-1)?.linkedPaths).toEqual(['../note.txt'])
    const unlinked = setLinkedPaths(pasted, 'copy', [])
    expect(unlinked.nodes[0].linkedPaths).toEqual(['../note.txt'])
    expect(unlinked.nodes[0].progress).toBe(73)
  })
})
