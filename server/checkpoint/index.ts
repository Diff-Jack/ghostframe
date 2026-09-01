import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import type { Checkpoint, RestoreResult, UntrackedEntry } from '../../shared/types.js'
import * as G from '../git/index.js'
import { checkpointDir, newId, objectPath, saveCheckpoint } from '../storage/index.js'

export class RestoreAbortedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RestoreAbortedError'
  }
}

/** Refuse to snapshot pathological trees rather than silently truncating them. */
const MAX_UNTRACKED_FILES = 2000
const MAX_UNTRACKED_BYTES = 64 * 1024 * 1024

export interface CaptureOptions {
  runId: string
  eventId: string
  repoPath: string
  safety?: boolean
  label?: string
}

/**
 * Captures the full working-tree state as a git patch plus verbatim copies of
 * every untracked file. Deliberately not a VM/FS snapshot: a patch against a
 * known commit is small, inspectable and reversible.
 */
export async function captureCheckpoint(opts: CaptureOptions): Promise<Checkpoint> {
  const { repoPath } = opts
  if (!(await G.isGitRepo(repoPath))) {
    throw new Error(`Not a git repository: ${repoPath}`)
  }

  const [gitHead, branch, patch, untracked] = await Promise.all([
    G.headCommit(repoPath),
    G.currentBranch(repoPath),
    G.trackedPatch(repoPath),
    G.untrackedFiles(repoPath),
  ])

  if (untracked.length > MAX_UNTRACKED_FILES) {
    throw new Error(
      `Refusing to snapshot ${untracked.length} untracked files (limit ${MAX_UNTRACKED_FILES}). ` +
        'Add build output to .gitignore and try again.',
    )
  }

  const id = newId('cp')
  const dir = checkpointDir(opts.runId, id)
  const untrackedRoot = path.join(dir, 'untracked')
  const entries: UntrackedEntry[] = []
  let totalBytes = 0

  for (const rel of untracked) {
    const src = path.join(repoPath, rel)
    let stat: fsSync.Stats
    try {
      stat = await fs.lstat(src)
    } catch {
      continue // Vanished between listing and copy; nothing to preserve.
    }
    if (!stat.isFile()) continue
    totalBytes += stat.size
    if (totalBytes > MAX_UNTRACKED_BYTES) {
      throw new Error(
        `Refusing to snapshot more than ${Math.round(MAX_UNTRACKED_BYTES / 1024 / 1024)}MB of untracked files.`,
      )
    }
    const dest = path.join(untrackedRoot, rel)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    const sha = await storeObject(opts.runId, src, dest)
    entries.push({
      path: rel,
      contentPath: path.posix.join('untracked', toPosix(rel)),
      mode: stat.mode & 0o777,
      sha256: sha,
    })
  }

  const checkpoint: Checkpoint = {
    id,
    runId: opts.runId,
    eventId: opts.eventId,
    timestamp: Date.now(),
    gitHead,
    branch,
    trackedPatch: patch,
    untrackedFiles: entries,
    safety: opts.safety || undefined,
    label: opts.label,
  }
  await saveCheckpoint(checkpoint)
  return checkpoint
}

export interface RestoreOptions {
  checkpoint: Checkpoint
  repoPath: string
  /** Internal: used when rolling back, so a rollback does not recurse. */
  skipSafety?: boolean
  /** Run id the safety checkpoint should be filed under. */
  safetyRunId?: string
}

/**
 * Puts the working tree back into the state a checkpoint recorded.
 *
 * Never uses `git reset --hard`. Only paths that actually differ between the
 * current tree and the checkpoint are touched, and a safety checkpoint of the
 * current state is always written first.
 */
export async function restoreCheckpoint(opts: RestoreOptions): Promise<RestoreResult> {
  const { checkpoint, repoPath } = opts

  if (!fsSync.existsSync(repoPath)) {
    throw new RestoreAbortedError(
      `The repository path no longer exists:\n${repoPath}\nRestore was cancelled.`,
    )
  }
  if (!(await G.isGitRepo(repoPath))) {
    throw new RestoreAbortedError(
      `${repoPath} is not a Git repository.\nRestore was cancelled.`,
    )
  }
  if (checkpoint.gitHead && !(await G.commitExists(repoPath, checkpoint.gitHead))) {
    throw new RestoreAbortedError(
      `The commit this checkpoint was based on (${checkpoint.gitHead.slice(0, 7)}) is not in this repository.\n` +
        'Restore was cancelled.',
    )
  }

  // 1. Safety checkpoint. If we cannot read the working tree safely we must not
  //    proceed — losing the user's current work is the one unacceptable outcome.
  let safetyCheckpoint: Checkpoint | undefined
  if (!opts.skipSafety) {
    try {
      safetyCheckpoint = await captureCheckpoint({
        runId: opts.safetyRunId ?? checkpoint.runId,
        eventId: `safety_for_${checkpoint.id}`,
        repoPath,
        safety: true,
        label: `Safety backup before restoring ${checkpoint.id}`,
      })
    } catch (err) {
      throw new RestoreAbortedError(
        'GhostFrame could not create a safety checkpoint.\nRestore was cancelled.\n\n' +
          `Reason: ${(err as Error).message}`,
      )
    }
  }

  try {
    const result = await applyCheckpointToWorktree(checkpoint, repoPath)
    return {
      ok: true,
      checkpointId: checkpoint.id,
      safetyCheckpointId: safetyCheckpoint?.id,
      ...result,
      message: `Workspace restored to checkpoint ${checkpoint.id}.`,
    }
  } catch (err) {
    // 2. Roll the workspace back to the safety checkpoint so a failed restore
    //    leaves the user exactly where they started.
    let rollbackNote = ''
    if (safetyCheckpoint) {
      try {
        await applyCheckpointToWorktree(safetyCheckpoint, repoPath)
        rollbackNote = '\nYour workspace was rolled back to its state before the restore.'
      } catch (rollbackErr) {
        rollbackNote =
          `\nRollback also failed: ${(rollbackErr as Error).message}\n` +
          `Your previous state is preserved in checkpoint ${safetyCheckpoint.id}.`
      }
    }
    throw new RestoreAbortedError(`Restore failed: ${(err as Error).message}${rollbackNote}`)
  }
}

interface ApplyOutcome {
  restoredTracked: string[]
  restoredUntracked: string[]
  removedUntracked: string[]
}

async function applyCheckpointToWorktree(cp: Checkpoint, repoPath: string): Promise<ApplyOutcome> {
  const base = cp.gitHead

  // --- Tracked files -------------------------------------------------------
  const affected = new Set<string>(G.patchFilePaths(cp.trackedPatch))
  if (base) {
    const diffNow = await G.git(repoPath, ['diff', '--name-only', '-z', base], { allowFailure: true })
    if (diffNow.exitCode === 0) {
      for (const p of diffNow.stdout.split('\0').filter(Boolean)) affected.add(p)
    }
  }

  const affectedPaths = [...affected]
  const restoredTracked: string[] = []

  if (base && affectedPaths.length > 0) {
    const inBase = await G.filesInCommit(repoPath, base, affectedPaths)
    const toRestore = affectedPaths.filter((p) => inBase.has(p))
    const toRemove = affectedPaths.filter((p) => !inBase.has(p))

    if (toRestore.length > 0) {
      // Rewinds both index and worktree for these paths to the base commit.
      await G.git(repoPath, ['checkout', base, '--', ...toRestore])
    }
    for (const rel of toRemove) {
      // Present now but absent in the base commit: drop it from index and disk
      // so the patch can recreate it cleanly.
      await G.git(repoPath, ['rm', '-f', '--quiet', '--ignore-unmatch', '--', rel], { allowFailure: true })
      await removeIfExists(path.join(repoPath, rel))
    }
    restoredTracked.push(...affectedPaths)
  }

  if (cp.trackedPatch.trim()) {
    if (!(await G.canApplyPatch(repoPath, cp.trackedPatch))) {
      throw new Error('the recorded patch does not apply to this repository state')
    }
    await G.applyPatch(repoPath, cp.trackedPatch)
  }

  // --- Untracked files -----------------------------------------------------
  const wanted = new Map(cp.untrackedFiles.map((f) => [f.path, f]))
  const nowUntracked = await G.untrackedFiles(repoPath)
  const removedUntracked: string[] = []
  for (const rel of nowUntracked) {
    if (wanted.has(rel)) continue
    await removeIfExists(path.join(repoPath, rel))
    removedUntracked.push(rel)
  }

  const cpDir = checkpointDir(cp.runId, cp.id)
  const restoredUntracked: string[] = []
  for (const entry of wanted.values()) {
    const src = path.join(cpDir, entry.contentPath)
    const dest = safeJoin(repoPath, entry.path)
    if (!fsSync.existsSync(src)) continue
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.copyFile(src, dest)
    if (entry.mode) await fs.chmod(dest, entry.mode)
    restoredUntracked.push(entry.path)
  }

  return { restoredTracked, restoredUntracked, removedUntracked }
}

/**
 * Puts `src` into the run's object store and hard-links it to `dest`.
 *
 * Returns the content hash. Falls back to a plain copy when linking is not
 * possible (different filesystem, link-count limit) — correctness never
 * depends on the optimisation succeeding.
 */
async function storeObject(runId: string, src: string, dest: string): Promise<string> {
  const sha = await hashFile(src)
  const object = objectPath(runId, sha)

  if (!fsSync.existsSync(object)) {
    await fs.mkdir(path.dirname(object), { recursive: true })
    // Copy to a temp name first so a crash cannot leave a truncated object
    // that later checkpoints would happily link to.
    const tmp = `${object}.${process.pid}.tmp`
    await fs.copyFile(src, tmp)
    try {
      await fs.rename(tmp, object)
    } catch {
      await fs.rm(tmp, { force: true })
    }
  }

  try {
    await fs.link(object, dest)
  } catch {
    await fs.copyFile(src, dest)
  }
  return sha
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(fsSync.createReadStream(file), hash)
  return hash.digest('hex')
}

async function removeIfExists(file: string): Promise<void> {
  try {
    await fs.rm(file, { force: true })
  } catch {
    // Already gone, or a directory we do not own — nothing to do.
  }
}

/** Guards against `../` escaping the repository when restoring recorded paths. */
function safeJoin(root: string, rel: string): string {
  const resolved = path.resolve(root, rel)
  const normalisedRoot = path.resolve(root)
  if (resolved !== normalisedRoot && !resolved.startsWith(normalisedRoot + path.sep)) {
    throw new Error(`Refusing to write outside the repository: ${rel}`)
  }
  return resolved
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}
