import { expect, it } from 'vitest'
import { displayProjectPath } from '../src/application/titlebar'
it('显示时隐藏Win32磁盘和UNC前缀，普通路径不变', () => {
  const slash = String.fromCharCode(92)
  const prefix = slash + slash + '?' + slash
  const disk = ['C:', '中文 空格', '项目.json'].join(slash)
  expect(displayProjectPath(prefix + disk)).toBe(disk)
  const unc = ['server', 'share', '项目.json'].join(slash)
  expect(displayProjectPath(prefix + 'UNC' + slash + unc)).toBe(slash + slash + unc)
  expect(displayProjectPath(slash + slash + unc)).toBe(slash + slash + unc)
  expect(displayProjectPath(disk)).toBe(disk)
})
