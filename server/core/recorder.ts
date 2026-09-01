import fsSync from 'node:fs'
import path from 'node:path'
import type { FileChange, Run, RunEvent } from '../../shared/types.js'
import * as G from '../git/index.js'
import { captureCheckpoint } from '../checkpoint/index.js'
import {
  appendEvent,
  ensureLayout,
  loadEvents,
  loadRun,
  newId,
  saveRun,
} from '../storage/index.js'
import { RepoWatcher } from '../watcher/index.js'
import { bus } from './bus.js'

interface Session {
  run: Run
  watcher: RepoWatcher
  /** Set while GhostFrame itself is writing to the tree (restore / fork). */
  suppressed: boolean
  /** Serialises change handling so two bursts cannot interleave git calls. */
  queue: Promise<void>
}

const sessions = new Map<string, Session>()

export function activeSessionForRepo(repoPath: string): Run | null {
  for (const session of sessions.values()) {
    if (session.run.repoPath === repoPath) return session.run
  }
  return null
}

export function isRecording(runId: string): boolean {
  return sessions.has(runId)
}

export function activeRuns(): Run[] {
  return [...sessions.values()].map((s) => s.run)
}

async function emit(runId: string, event: RunEvent): Promise<void> {
  await appendEvent(runId, event)
  bus.publish({ type: 'event', runId, event })
}

function publishRun(run: Run): void {
  bus.publish({ type: 'run', run })
}

export interface StartRunOptions {
  repoPath: string
  title?: string
  parentRunId?: string
  forkedFromCheckpointId?: string
}

/** Creates a run, writes the baseline checkpoint, and starts watching. */
export async function startRun(opts: StartRunOptions): Promise<Run> {
  await ensureLayout()
  const repoPath = await G.repoRoot(opts.repoPath)

  const existing = activeSessionForRepo(repoPath)
  if (existing) {
    throw new Error(`Already recording this repository (run ${existing.id}). Stop that run first.`)
  }

  const [branch, head] = await Promise.all([G.currentBranch(repoPath), G.headCommit(repoPath)])
  const run: Run = {
    id: newId('run'),
    repoPath,
    repoName: path.basename(repoPath),
    branch,
    headCommit: head,
    startedAt: Date.now(),
    status: 'recording',
    title: opts.title,
    parentRunId: opts.parentRunId,
    forkedFromCheckpointId: opts.forkedFromCheckpointId,
  }
  await saveRun(run)

  // Baseline: whatever the tree looks like the moment recording starts.
  const startEventId = newId('evt')
  const baseline = await captureCheckpoint({
    runId: run.id,
    eventId: startEventId,
    repoPath,
    label: 'Baseline at recording start',
  })

  await emit(run.id, {
    id: startEventId,
    runId: run.id,
    type: 'run_start',
    timestamp: run.startedAt,
    label: 'Recording started',
    gitHead: head,
    branch,
    checkpointId: baseline.id,
    diff: await G.displayDiff(repoPath),
  })
  await emitCheckpointEvent(run.id, baseline.id, baseline.timestamp, 'Baseline checkpoint')

  const watcher = new RepoWatcher({
    repoPath,
    debounceMs: Number(process.env.GHOSTFRAME_DEBOUNCE_MS ?? 1000),
    onChanges: (changes) => {
      const session = sessions.get(run.id)
      if (!session || session.suppressed) return
      session.queue = session.queue
        .then(() => handleChanges(run.id, changes))
        .catch(async (err: Error) => {
          await emit(run.id, {
            id: newId('evt'),
            runId: run.id,
            type: 'error',
            timestamp: Date.now(),
            label: 'Failed to record change',
            message: err.message,
          })
        })
    },
    onError: (err) => {
      void emit(run.id, {
        id: newId('evt'),
        runId: run.id,
        type: 'error',
        timestamp: Date.now(),
        label: 'Watcher error',
        message: err.message,
      })
    },
  })
  watcher.start()

  sessions.set(run.id, { run, watcher, suppressed: false, queue: Promise.resolve() })
  publishRun(run)
  bus.publish({ type: 'runs-changed' })
  return run
}

async function handleChanges(runId: string, changes: FileChange[]): Promise<void> {
  const session = sessions.get(runId)
  if (!session) return
  const { repoPath } = session.run

  const eventId = newId('evt')
  // Stamped before the git work so the change always precedes the checkpoint
  // it produced when the timeline is sorted by time.
  const timestamp = Date.now()
  const [diff, head, branch] = await Promise.all([
    G.displayDiff(repoPath),
    G.headCommit(repoPath),
    G.currentBranch(repoPath),
  ])

  const checkpoint = await captureCheckpoint({ runId, eventId, repoPath })
  const files = changes.map((c) => c.path)

  await emit(runId, {
    id: eventId,
    runId,
    type: 'file_change',
    timestamp,
    label: describeChanges(changes),
    files,
    changes,
    diff,
    checkpointId: checkpoint.id,
    gitHead: head,
    branch,
  })
  await emitCheckpointEvent(
    runId,
    checkpoint.id,
    Math.max(checkpoint.timestamp, timestamp + 1),
    `Checkpoint ${checkpoint.id}`,
  )
}

async function emitCheckpointEvent(
  runId: string,
  checkpointId: string,
  timestamp: number,
  label: string,
): Promise<void> {
  await emit(runId, {
    id: newId('evt'),
    runId,
    type: 'checkpoint',
    timestamp,
    label,
    checkpointId,
  })
}

function describeChanges(changes: FileChange[]): string {
  const added = changes.filter((c) => c.kind === 'add').length
  const removed = changes.filter((c) => c.kind === 'unlink').length
  if (changes.length === 1) {
    const verb = changes[0].kind === 'add' ? 'Added' : changes[0].kind === 'unlink' ? 'Deleted' : 'Modified'
    return `${verb} ${changes[0].path}`
  }
  const parts = [`${changes.length} files changed`]
  if (added) parts.push(`${added} added`)
  if (removed) parts.push(`${removed} deleted`)
  return parts.join(' · ')
}

export async function stopRun(runId: string): Promise<Run> {
  const session = sessions.get(runId)
  if (!session) {
    const stored = await loadRun(runId)
    if (!stored) throw new Error(`Unknown run: ${runId}`)
    return stored
  }

  session.watcher.flushNow()
  await session.queue.catch(() => undefined)
  await session.watcher.close()
  sessions.delete(runId)

  const run: Run = { ...session.run, status: 'completed', endedAt: Date.now() }
  await saveRun(run)
  await emit(runId, {
    id: newId('evt'),
    runId,
    type: 'run_end',
    timestamp: run.endedAt!,
    label: 'Recording stopped',
  })
  publishRun(run)
  bus.publish({ type: 'runs-changed' })
  return run
}

export async function stopAll(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => stopRun(id).catch(() => undefined)))
}

/**
 * Pauses watching while GhostFrame mutates the tree itself, so a restore does
 * not immediately record itself as a fresh user edit.
 */
export async function withWatcherSuppressed<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const affected = [...sessions.values()].filter((s) => s.run.repoPath === repoPath)
  for (const s of affected) s.suppressed = true
  try {
    return await fn()
  } finally {
    // Let chokidar deliver the events caused by our own writes, then resume.
    setTimeout(() => {
      for (const s of affected) s.suppressed = false
    }, 1500)
  }
}

export async function recordRestoreEvent(
  runId: string,
  payload: { checkpointId: string; safetyCheckpointId?: string; message: string; files: string[] },
): Promise<RunEvent | null> {
  const run = await loadRun(runId)
  if (!run) return null
  const event: RunEvent = {
    id: newId('evt'),
    runId,
    type: 'restore',
    timestamp: Date.now(),
    label: `Restored workspace to ${payload.checkpointId}`,
    restoredFromCheckpointId: payload.checkpointId,
    safetyCheckpointId: payload.safetyCheckpointId,
    checkpointId: payload.safetyCheckpointId,
    message: payload.message,
    files: payload.files,
  }
  await emit(runId, event)
  return event
}

/** Marks runs that were left "recording" by a crashed or killed daemon. */
export async function reconcileOnStartup(): Promise<void> {
  await ensureLayout()
  const { listRuns } = await import('../storage/index.js')
  for (const run of await listRuns()) {
    if (run.status !== 'recording' || sessions.has(run.id)) continue
    const events = await loadEvents(run.id)
    const last = events[events.length - 1]
    await saveRun({
      ...run,
      status: 'completed',
      endedAt: run.endedAt ?? last?.timestamp ?? run.startedAt,
    })
  }
}

export function repoExists(repoPath: string): boolean {
  return fsSync.existsSync(repoPath)
}
