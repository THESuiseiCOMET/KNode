import { afterEach, describe, expect, it, vi } from 'vitest'
import { Autosave, type SaveState } from '../src/application/autosave'

afterEach(() => vi.useRealTimers())
describe('单写入自动保存', () => {
  it('写入完成交接间隙的新修订也必须被 flush 等待', async () => {
    const write = vi.fn(async (_json: string) => {})
    let injected = false
    const saver = new Autosave(write, (state) => {
      if (state.status === 'saved' && !injected) {
        injected = true
        saver.mark('final revision')
      }
    })
    saver.mark('initial revision')
    await saver.flush()
    expect(write.mock.calls.map((c) => c[0])).toEqual(['initial revision', 'final revision'])
    expect(saver.dirty).toBe(false)
  })
  it('800ms 防抖只写最新内容，完成前不显示已保存', async () => {
    vi.useFakeTimers()
    const write = vi.fn(async () => {}),
      states: SaveState[] = []
    const saver = new Autosave(write, (state) => states.push(state))
    saver.mark('first')
    await vi.advanceTimersByTimeAsync(600)
    saver.mark('latest')
    await vi.advanceTimersByTimeAsync(799)
    expect(write).not.toHaveBeenCalled()
    expect(saver.dirty).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(write).toHaveBeenCalledExactlyOnceWith('latest')
    expect(states.at(-1)?.status).toBe('saved')
    expect(saver.dirty).toBe(false)
  })
  it('关闭自动保存时允许已开始的写入结束，新的修改继续保持待保存', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const write = vi
      .fn(async (_json: string) => {})
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      )
    const states: SaveState[] = []
    const saver = new Autosave(write, (state) => states.push(state))
    saver.mark('first')
    await vi.advanceTimersByTimeAsync(800)
    saver.setAutomatic(false)
    saver.mark('draft')
    finish()
    await vi.advanceTimersByTimeAsync(900)
    expect(write).toHaveBeenCalledExactlyOnceWith('first')
    expect(states.at(-1)?.status).toBe('dirty')
    await saver.flush()
    expect(write).toHaveBeenLastCalledWith('draft')
    expect(saver.dirty).toBe(false)
  })
  it('保存中修改串行写下一轮，旧写入完成不能虚报已保存', async () => {
    let finish: (() => void) | undefined
    const write = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      )
      .mockResolvedValue(undefined)
    const states: SaveState[] = [],
      saver = new Autosave(write, (state) => states.push(state))
    saver.mark('v1')
    const flushing = saver.flush()
    saver.mark('v2')
    const secondFlush = saver.flush()
    expect(write).toHaveBeenCalledTimes(1)
    expect(states.some((s) => s.status === 'saved')).toBe(false)
    finish!()
    await Promise.all([flushing, secondFlush])
    expect(write.mock.calls.map((c) => c[0])).toEqual(['v1', 'v2'])
    expect(saver.dirty).toBe(false)
  })
  it('关闭前 flush 不等待防抖；失败保留草稿且能重试', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('磁盘空间不足'))
      .mockResolvedValue(undefined)
    const states: SaveState[] = [],
      saver = new Autosave(write, (state) => states.push(state))
    saver.mark('draft')
    await expect(saver.flush()).rejects.toThrow('磁盘空间不足')
    expect(saver.dirty).toBe(true)
    expect(states.at(-1)).toEqual({ status: 'error', error: '磁盘空间不足' })
    await saver.flush()
    expect(write).toHaveBeenNthCalledWith(2, 'draft')
    expect(saver.dirty).toBe(false)
  })
  it('失败期间的新修改仍保留最新草稿', async () => {
    let reject: ((e: Error) => void) | undefined
    const write = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, r) => {
            reject = r
          }),
      )
      .mockResolvedValue(undefined)
    const saver = new Autosave(write, () => {})
    saver.mark('old')
    const flush = saver.flush()
    saver.mark('new')
    reject!(new Error('写入拒绝'))
    await expect(flush).rejects.toThrow()
    await saver.flush()
    expect(write).toHaveBeenLastCalledWith('new')
  })
})
