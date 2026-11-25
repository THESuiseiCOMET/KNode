import { expect, it } from 'vitest'
import { fileTreeRows } from '../src/application/fileTree'
it('只投影明确展开目录，缓存未展开后代仍不可见，不修改输入', () => {
  const dir = (path: string) => ({ name: path, path, isDirectory: true, size: 0 })
  const file = (path: string) => ({ name: path, path, isDirectory: false, size: 1 })
  const cache = {
    '': [dir('a'), dir('b')],
    a: [dir('a/sub'), file('a/file')],
    'a/sub': [file('a/sub/deep')],
    b: [],
  }
  const before = JSON.stringify(cache)
  expect(fileTreeRows(cache, new Set()).map((r) => r.entry.path)).toEqual(['a', 'b'])
  const rows = fileTreeRows(cache, new Set(['a', 'a/sub']))
  expect(rows.map((r) => [r.entry.path, r.depth])).toEqual([
    ['a', 0],
    ['a/sub', 1],
    ['a/sub/deep', 2],
    ['a/file', 1],
    ['b', 0],
  ])
  expect(rows.find((r) => r.entry.path === 'b')?.empty).toBe(true)
  expect(JSON.stringify(cache)).toBe(before)
})
it('尚未读取的目录不误报为空，缺少根目录不会发起任何读取', () => {
  expect(fileTreeRows({}, new Set(['a']))).toEqual([])
  expect(
    fileTreeRows({ '': [{ name: 'a', path: 'a', isDirectory: true, size: 0 }] }, new Set(['a']))[0]
      ?.empty,
  ).toBe(false)
})

it('名为constructor或__proto__的目录不能误读对象原型', () => {
  const entries = ['constructor', '__proto__'].map((path) => ({
    name: path,
    path,
    isDirectory: true,
    size: 0,
  }))
  const rows = fileTreeRows({ '': entries }, new Set(['constructor', '__proto__']))
  expect(rows).toHaveLength(2)
  expect(rows.every((row) => !row.empty)).toBe(true)
})
