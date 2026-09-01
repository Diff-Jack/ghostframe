import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Checkpoint, Run, RunEvent } from '../../shared/types.js'

/** Root of all GhostFrame data. Overridable so tests never touch the real home. */
export function ghostHome(): string {
  return process.env.GHOSTFRAME_HOME ?? path.join(os.homedir(), '.ghostframe')
}

export function runsDir(): string {
  return path.join(ghostHome(), 'runs')
}

export function configDir(): string {
  return path.join(ghostHome(), 'config')
}

export function tracesDir(): string {
  return path.join(ghostHome(), 'traces')
}

export function runDir(runId: string): string {
  return path.join(runsDir(), runId)
}

export function checkpointsDir(runId: string): string {
  return path.join(runDir(runId), 'checkpoints')
}

export function checkpointDir(runId: string, checkpointId: string): string {
  return path.join(checkpointsDir(runId), checkpointId)
}

/**
 * Content-addressed store for untracked file bodies, one per run.
 *
 * Every checkpoint copies the whole untracked set, and across a long run most
 * of those bytes are identical. Each checkpoint's `untracked/<path>` is a hard
 * link into this directory, so identical content is stored once. The layout on
 * disk and inside a .ghost archive is unchanged — a hard link reads like any
 * other file.
 */
export function objectsDir(runId: string): string {
  return path.join(runDir(runId), 'objects')
}

export function objectPath(runId: string, sha: string): string {
  return path.join(objectsDir(runId), sha.slice(0, 2), sha)
}

export async function ensureLayout(): Promise<void> {
  await fs.mkdir(runsDir(), { recursive: true })
  await fs.mkdir(configDir(), { recursive: true })
  await fs.mkdir(tracesDir(), { recursive: true })
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/** Write-to-temp-then-rename, so a crash never leaves a half-written JSON file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, file)
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function saveRun(run: Run): Promise<void> {
  await writeJsonAtomic(path.join(runDir(run.id), 'run.json'), run)
}

export async function loadRun(runId: string): Promise<Run | null> {
  return readJson<Run>(path.join(runDir(runId), 'run.json'))
}

export async function listRuns(): Promise<Run[]> {
  await ensureLayout()
  const entries = await fs.readdir(runsDir(), { withFileTypes: true })
  const runs: Run[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const run = await loadRun(entry.name)
    if (run) runs.push(run)
  }
  runs.sort((a, b) => b.startedAt - a.startedAt)
  return runs
}

export async function deleteRun(runId: string): Promise<boolean> {
  const dir = runDir(runId)
  if (!fsSync.existsSync(dir)) return false
  await fs.rm(dir, { recursive: true, force: true })
  return true
}

function eventsFile(runId: string): string {
  return path.join(runDir(runId), 'events.json')
}

export async function loadEvents(runId: string): Promise<RunEvent[]> {
  return (await readJson<RunEvent[]>(eventsFile(runId))) ?? []
}

export async function saveEvents(runId: string, events: RunEvent[]): Promise<void> {
  await writeJsonAtomic(eventsFile(runId), events)
}

export async function appendEvent(runId: string, event: RunEvent): Promise<void> {
  const events = await loadEvents(runId)
  events.push(event)
  await saveEvents(runId, events)
}

/**
 * Checkpoint metadata lives in metadata.json, the patch in working.patch, and
 * untracked file contents under untracked/ — the same layout used inside a
 * .ghost archive, so export is a straight directory copy.
 */
export async function saveCheckpoint(cp: Checkpoint): Promise<void> {
  const dir = checkpointDir(cp.runId, cp.id)
  await fs.mkdir(dir, { recursive: true })
  const { trackedPatch, ...meta } = cp
  await fs.writeFile(path.join(dir, 'working.patch'), trackedPatch, 'utf8')
  await writeJsonAtomic(path.join(dir, 'metadata.json'), meta)
}

export async function loadCheckpoint(runId: string, checkpointId: string): Promise<Checkpoint | null> {
  const dir = checkpointDir(runId, checkpointId)
  const meta = await readJson<Omit<Checkpoint, 'trackedPatch'>>(path.join(dir, 'metadata.json'))
  if (!meta) return null
  let trackedPatch = ''
  try {
    trackedPatch = await fs.readFile(path.join(dir, 'working.patch'), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return { ...meta, trackedPatch }
}

export async function listCheckpoints(runId: string): Promise<Checkpoint[]> {
  const dir = checkpointsDir(runId)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: Checkpoint[] = []
  for (const id of entries) {
    const cp = await loadCheckpoint(runId, id)
    if (cp) out.push(cp)
  }
  out.sort((a, b) => a.timestamp - b.timestamp)
  return out
}

/** Finds which run owns a checkpoint id, for restore/fork routes. */
export async function findCheckpoint(
  checkpointId: string,
  runIdHint?: string,
): Promise<{ run: Run; checkpoint: Checkpoint } | null> {
  const candidates = runIdHint ? [runIdHint] : (await listRuns()).map((r) => r.id)
  for (const runId of candidates) {
    const cp = await loadCheckpoint(runId, checkpointId)
    if (cp) {
      const run = await loadRun(runId)
      if (run) return { run, checkpoint: cp }
    }
  }
  return null
}
