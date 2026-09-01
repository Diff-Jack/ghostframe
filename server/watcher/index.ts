import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { FileChange } from '../../shared/types.js'

export const DEFAULT_IGNORES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
  '.turbo',
  '.venv',
  '__pycache__',
  'target',
  '.ghostframe',
]

export interface WatcherOptions {
  repoPath: string
  /** Extra directory/file names to ignore, merged with DEFAULT_IGNORES. */
  ignore?: string[]
  /** Quiet period before a burst of edits is emitted as one change. */
  debounceMs?: number
  onChanges: (changes: FileChange[]) => void
  onError?: (err: Error) => void
}

/**
 * Watches a repository and coalesces bursts of edits into a single change set.
 * Agents (and editors) write many files in quick succession — one checkpoint
 * per keystroke would be useless, so we wait for the tree to settle.
 */
export class RepoWatcher {
  private watcher: FSWatcher | null = null
  private pending = new Map<string, FileChange['kind']>()
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private readonly debounceMs: number
  private readonly ignoreNames: Set<string>

  constructor(private readonly opts: WatcherOptions) {
    this.debounceMs = opts.debounceMs ?? 1000
    this.ignoreNames = new Set([...DEFAULT_IGNORES, ...(opts.ignore ?? [])])
  }

  start(): void {
    const root = this.opts.repoPath
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      ignored: (target: string) => {
        const rel = path.relative(root, target)
        if (!rel || rel.startsWith('..')) return false
        return rel.split(path.sep).some((segment) => this.ignoreNames.has(segment))
      },
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
    })

    this.watcher
      .on('add', (p: string) => this.record(p, 'add'))
      .on('change', (p: string) => this.record(p, 'change'))
      .on('unlink', (p: string) => this.record(p, 'unlink'))
      .on('error', (err: unknown) => this.opts.onError?.(err as Error))
  }

  private record(absolute: string, kind: FileChange['kind']): void {
    if (this.closed) return
    const rel = path.relative(this.opts.repoPath, absolute)
    if (!rel || rel.startsWith('..')) return
    // A file created then edited inside one burst is still just "added".
    const existing = this.pending.get(rel)
    this.pending.set(rel, existing === 'add' && kind === 'change' ? 'add' : kind)
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.debounceMs)
  }

  private flush(): void {
    this.timer = null
    if (this.pending.size === 0) return
    const changes: FileChange[] = [...this.pending.entries()]
      .map(([p, kind]) => ({ path: p, kind }))
      .sort((a, b) => a.path.localeCompare(b.path))
    this.pending.clear()
    if (this.closed) return
    this.opts.onChanges(changes)
  }

  /** Emits anything still buffered — used by "stop recording". */
  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.flush()
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending.clear()
    await this.watcher?.close()
    this.watcher = null
  }
}
