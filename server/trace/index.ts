import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import {
  TRACE_FORMAT,
  TRACE_VERSION,
  type Checkpoint,
  type Run,
  type RunEvent,
  type TraceManifest,
} from '../../shared/types.js'
import {
  checkpointsDir,
  ensureLayout,
  listCheckpoints,
  loadEvents,
  loadRun,
  newId,
  runDir,
  saveCheckpoint,
  saveEvents,
  saveRun,
} from '../storage/index.js'
import * as G from '../git/index.js'

export class TraceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TraceError'
  }
}

/** Builds a `.ghost` archive (a plain ZIP) for one run. */
export async function exportRun(runId: string): Promise<{ filename: string; buffer: Buffer }> {
  const run = await loadRun(runId)
  if (!run) throw new TraceError(`Unknown run: ${runId}`)
  const events = await loadEvents(runId)
  const checkpoints = await listCheckpoints(runId)

  const manifest: TraceManifest = {
    format: TRACE_FORMAT,
    version: TRACE_VERSION,
    runId: run.id,
    repoName: run.repoName,
    repoPath: run.repoPath,
    branch: run.branch,
    headCommit: run.headCommit,
    createdAt: Date.now(),
  }

  const zip = new JSZip()
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  zip.file('metadata.json', JSON.stringify(run, null, 2))
  zip.file('events.json', JSON.stringify(events, null, 2))

  for (const cp of checkpoints) {
    const folder = `checkpoints/${cp.id}`
    const { trackedPatch, ...meta } = cp
    zip.file(`${folder}/metadata.json`, JSON.stringify(meta, null, 2))
    zip.file(`${folder}/working.patch`, trackedPatch)
    for (const entry of cp.untrackedFiles) {
      const abs = path.join(checkpointsDir(runId), cp.id, entry.contentPath)
      if (!fsSync.existsSync(abs)) continue
      zip.file(`${folder}/${entry.contentPath}`, await fs.readFile(abs))
    }
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const safeName = run.repoName.replace(/[^a-zA-Z0-9._-]/g, '_')
  return { filename: `${safeName}-${run.id}.ghost`, buffer }
}

export interface ImportResult {
  run: Run
  readOnly: boolean
  message: string
}

/** Reads a `.ghost` archive back into the local run store. */
export async function importTrace(data: Buffer): Promise<ImportResult> {
  await ensureLayout()

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(data)
  } catch {
    throw new TraceError('This file is not a valid .ghost archive (could not read the ZIP container).')
  }

  const manifest = await readJsonEntry<TraceManifest>(zip, 'manifest.json')
  if (!manifest) throw new TraceError('This archive has no manifest.json — it is not a GhostFrame trace.')
  if (manifest.format !== TRACE_FORMAT) {
    throw new TraceError(`Unsupported trace format: ${String(manifest.format)}`)
  }
  if (typeof manifest.version !== 'number' || manifest.version > TRACE_VERSION) {
    throw new TraceError(
      `Unsupported trace version ${String(manifest.version)}. This build of GhostFrame supports up to version ${TRACE_VERSION}.`,
    )
  }

  const storedRun = await readJsonEntry<Run>(zip, 'metadata.json')
  const events = (await readJsonEntry<RunEvent[]>(zip, 'events.json')) ?? []
  if (!storedRun) throw new TraceError('This archive has no metadata.json — the run cannot be reconstructed.')

  // Always import under a fresh id so re-importing never clobbers a local run.
  const newRunId = newId('run')
  const repoAvailable =
    !!storedRun.repoPath && fsSync.existsSync(storedRun.repoPath) && (await G.isGitRepo(storedRun.repoPath))

  const run: Run = {
    ...storedRun,
    id: newRunId,
    status: storedRun.status === 'recording' ? 'completed' : storedRun.status,
    endedAt: storedRun.endedAt ?? events[events.length - 1]?.timestamp ?? storedRun.startedAt,
    imported: true,
    readOnly: !repoAvailable,
    title: storedRun.title ?? `Imported ${storedRun.repoName}`,
  }

  await fs.mkdir(runDir(newRunId), { recursive: true })
  await saveRun(run)
  await saveEvents(
    newRunId,
    events.map((e) => ({ ...e, runId: newRunId })),
  )

  const checkpointIds = new Set<string>()
  zip.forEach((relPath) => {
    const m = /^checkpoints\/([^/]+)\//.exec(relPath)
    if (m) checkpointIds.add(m[1])
  })

  for (const cpId of checkpointIds) {
    const meta = await readJsonEntry<Omit<Checkpoint, 'trackedPatch'>>(zip, `checkpoints/${cpId}/metadata.json`)
    if (!meta) continue
    const patchEntry = zip.file(`checkpoints/${cpId}/working.patch`)
    const trackedPatch = patchEntry ? await patchEntry.async('string') : ''
    const cp: Checkpoint = { ...meta, runId: newRunId, trackedPatch }
    await saveCheckpoint(cp)

    for (const entry of cp.untrackedFiles ?? []) {
      const file = zip.file(`checkpoints/${cpId}/${entry.contentPath}`)
      if (!file) continue
      const dest = safeJoin(path.join(checkpointsDir(newRunId), cpId), entry.contentPath)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.writeFile(dest, await file.async('nodebuffer'))
    }
  }

  return {
    run,
    readOnly: !repoAvailable,
    message: repoAvailable
      ? `Trace imported. Repository found at ${storedRun.repoPath}.`
      : 'Trace imported in read-only mode. The original repository path is not available on this machine, so checkpoints cannot be restored.',
  }
}

async function readJsonEntry<T>(zip: JSZip, name: string): Promise<T | null> {
  const file = zip.file(name)
  if (!file) return null
  try {
    return JSON.parse(await file.async('string')) as T
  } catch {
    throw new TraceError(`${name} inside the archive is not valid JSON.`)
  }
}

/** Zip entries are untrusted input; never let one write outside its folder. */
function safeJoin(root: string, rel: string): string {
  const resolved = path.resolve(root, rel)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new TraceError(`Archive entry escapes its directory: ${rel}`)
  }
  return resolved
}
