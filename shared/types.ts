/**
 * Shared contract between the GhostFrame local daemon and the web UI.
 * Everything here is serialised as JSON, both over HTTP and on disk.
 */

export const TRACE_FORMAT = 'ghostframe'
export const TRACE_VERSION = 1

export type RunStatus = 'recording' | 'completed' | 'failed'

export interface Run {
  id: string
  /** Absolute path of the repository this run was recorded against. */
  repoPath: string
  repoName: string
  branch: string
  headCommit: string
  startedAt: number
  endedAt?: number
  status: RunStatus
  /** Optional human label. Falls back to a timestamp in the UI. */
  title?: string
  parentRunId?: string
  forkedFromCheckpointId?: string
  /** True when the run came from an imported .ghost archive. */
  imported?: boolean
  /** Imported runs whose repoPath no longer resolves are read-only. */
  readOnly?: boolean
}

export type EventType =
  | 'run_start'
  | 'file_change'
  | 'checkpoint'
  | 'shell'
  | 'test'
  | 'error'
  | 'restore'
  | 'run_end'

export interface FileChange {
  path: string
  kind: 'add' | 'change' | 'unlink'
}

export interface RunEvent {
  id: string
  runId: string
  type: EventType
  timestamp: number
  /** Short one-line label rendered in the timeline. */
  label: string
  /** Paths touched by this event, repo-relative. */
  files?: string[]
  changes?: FileChange[]
  /** Unified git diff captured at the moment of the event. */
  diff?: string
  checkpointId?: string
  gitHead?: string
  branch?: string
  /** shell / test events */
  command?: string
  stdout?: string
  stderr?: string
  exitCode?: number
  durationMs?: number
  /** error / restore events */
  message?: string
  /** restore events: the checkpoint the workspace was rolled back to. */
  restoredFromCheckpointId?: string
  /** restore events: the safety backup taken before the rollback. */
  safetyCheckpointId?: string
}

export interface UntrackedEntry {
  /** Repo-relative path of the file. */
  path: string
  /** Path of the stored copy, relative to the checkpoint directory. */
  contentPath: string
  mode?: number
}

export interface Checkpoint {
  id: string
  runId: string
  eventId: string
  timestamp: number
  gitHead: string
  branch: string
  /** `git diff <head> --binary` of tracked files at capture time. */
  trackedPatch: string
  untrackedFiles: UntrackedEntry[]
  /** Set on checkpoints created automatically right before a restore. */
  safety?: boolean
  label?: string
}

export interface RepoInfo {
  path: string
  name: string
  isGitRepo: boolean
  branch: string
  headCommit: string
  headCommitShort: string
  /** `clean` when the working tree has no modifications. */
  status: 'clean' | 'dirty'
  dirtyFileCount: number
  /** Present when the repository has no commits yet. */
  warning?: string
}

export interface RestoreResult {
  ok: boolean
  checkpointId: string
  safetyCheckpointId?: string
  restoredTracked: string[]
  restoredUntracked: string[]
  removedUntracked: string[]
  message: string
}

export interface ForkResult {
  run: Run
  safetyCheckpointId: string
  fromCheckpointId: string
}

export interface RegressionAnalysis {
  /** Last checkpoint observed in a passing state. */
  lastGoodCheckpointId?: string
  /** First checkpoint observed in a failing state. */
  firstBadCheckpointId?: string
  /** Candidate checkpoints between the two, inclusive of the first bad one. */
  suspects: string[]
  summary: string
}

export interface TraceManifest {
  format: typeof TRACE_FORMAT
  version: number
  runId: string
  repoName: string
  repoPath: string
  branch: string
  headCommit: string
  createdAt: number
}

export interface RunDetail {
  run: Run
  events: RunEvent[]
  checkpoints: Checkpoint[]
}

/** Server-sent event payloads pushed to the UI. */
export type StreamMessage =
  | { type: 'event'; runId: string; event: RunEvent }
  | { type: 'run'; run: Run }
  | { type: 'runs-changed' }
  | { type: 'hello'; serverStartedAt: number }
