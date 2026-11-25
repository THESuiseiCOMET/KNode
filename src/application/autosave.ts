export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error'
export interface SaveState {
  status: SaveStatus
  error: string | null
}

/** One writer; revision tracking prevents stale completion from reporting saved. */
export class Autosave {
  private automatic = true
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private revision = 0
  private persisted = 0
  private latest = ''
  constructor(
    private write: (json: string) => Promise<void>,
    private notify: (state: SaveState) => void,
    private delay = 800,
  ) {}

  mark(json: string): void {
    this.latest = json
    this.revision++
    this.notify({ status: this.running ? 'saving' : 'dirty', error: null })
    if (this.automatic) this.schedule()
  }
  setAutomatic(enabled: boolean): void {
    if (this.automatic === enabled) return
    this.automatic = enabled
    if (enabled && this.dirty) this.schedule()
    else clearTimeout(this.timer)
  }
  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.flush(true).catch(() => {
        /* Error already exposed; retain draft. */
      })
    }, this.delay)
  }
  get dirty(): boolean {
    return this.revision !== this.persisted
  }
  async flush(automatic = false): Promise<void> {
    clearTimeout(this.timer)
    while (this.running || (this.dirty && (!automatic || this.automatic))) {
      if (this.running) {
        await this.running
        continue
      }
      const task = this.drain(automatic)
      this.running = task
      try {
        await task
      } finally {
        if (this.running === task) this.running = undefined
      }
    }
  }
  private async drain(automatic: boolean): Promise<void> {
    this.notify({ status: 'saving', error: null })
    try {
      while (this.dirty && (!automatic || this.automatic)) {
        const revision = this.revision,
          json = this.latest
        await this.write(json)
        this.persisted = revision
      }
      this.notify({ status: this.dirty ? 'dirty' : 'saved', error: null })
    } catch (e) {
      this.notify({ status: 'error', error: e instanceof Error ? e.message : String(e) })
      throw e
    }
  }
}
