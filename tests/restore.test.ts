import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import type { Checkpoint } from '../shared/types.js'
import { cleanup, git, makeTempHome, makeTempRepo } from './helpers/tmpRepo.js'

let repo: string
let home: string
let capture: typeof import('../server/checkpoint/index.js').captureCheckpoint
let restore: typeof import('../server/checkpoint/index.js').restoreCheckpoint
let RestoreAbortedError: typeof import('../server/checkpoint/index.js').RestoreAbortedError

const RUN = 'run_restoretest'

async function snapshot(eventId: string): Promise<Checkpoint> {
  return capture({ runId: RUN, eventId, repoPath: repo })
}

const read = (rel: string) => fs.readFile(path.join(repo, rel), 'utf8')
const exists = (rel: string) => fsSync.existsSync(path.join(repo, rel))

beforeAll(async () => {
  home = await makeTempHome('restore')
  process.env.GHOSTFRAME_HOME = home
  repo = await makeTempRepo('restore')
  const mod = await import('../server/checkpoint/index.js')
  capture = mod.captureCheckpoint
  restore = mod.restoreCheckpoint
  RestoreAbortedError = mod.RestoreAbortedError
})

afterAll(async () => {
  await cleanup(home, repo)
})

describe('checkpoint restore', () => {
  it('restores a modified tracked file to its recorded content', async () => {
    await fs.writeFile(path.join(repo, 'src.txt'), 'state A\n')
    const cpA = await snapshot('evt_a')

    await fs.writeFile(path.join(repo, 'src.txt'), 'state B — broken by the agent\n')
    expect(await read('src.txt')).toContain('state B')

    const result = await restore({ checkpoint: cpA, repoPath: repo })
    expect(result.ok).toBe(true)
    expect(result.safetyCheckpointId).toBeTruthy()
    expect(await read('src.txt')).toBe('state A\n')
  })

  it('restores a file the agent deleted', async () => {
    await fs.writeFile(path.join(repo, 'src.txt'), 'keep me\n')
    const cp = await snapshot('evt_del')

    await fs.rm(path.join(repo, 'src.txt'))
    expect(exists('src.txt')).toBe(false)

    await restore({ checkpoint: cp, repoPath: repo })
    expect(await read('src.txt')).toBe('keep me\n')
  })

  it('restores untracked files and removes ones created afterwards', async () => {
    await fs.writeFile(path.join(repo, 'note.txt'), 'untracked original\n')
    const cp = await snapshot('evt_untracked')

    await fs.writeFile(path.join(repo, 'note.txt'), 'untracked mutated\n')
    await fs.writeFile(path.join(repo, 'junk.txt'), 'created after the checkpoint\n')

    const result = await restore({ checkpoint: cp, repoPath: repo })
    expect(await read('note.txt')).toBe('untracked original\n')
    expect(exists('junk.txt')).toBe(false)
    expect(result.removedUntracked).toContain('junk.txt')
  })

  it('restores files in nested directories', async () => {
    await fs.mkdir(path.join(repo, 'deep/nest'), { recursive: true })
    await fs.writeFile(path.join(repo, 'deep/nest/a.ts'), 'export const a = 1\n')
    const cp = await snapshot('evt_nested')

    await fs.rm(path.join(repo, 'deep'), { recursive: true })
    await restore({ checkpoint: cp, repoPath: repo })
    expect(await read('deep/nest/a.ts')).toBe('export const a = 1\n')

    await fs.rm(path.join(repo, 'deep'), { recursive: true, force: true })
  })

  it('restores a staged change', async () => {
    await fs.writeFile(path.join(repo, 'src.txt'), 'staged content\n')
    await git(repo, ['add', 'src.txt'])
    const cp = await snapshot('evt_staged')

    await fs.writeFile(path.join(repo, 'src.txt'), 'clobbered\n')
    await restore({ checkpoint: cp, repoPath: repo })
    expect(await read('src.txt')).toBe('staged content\n')
  })

  it('always writes a safety checkpoint before touching the tree', async () => {
    await fs.writeFile(path.join(repo, 'src.txt'), 'target state\n')
    const target = await snapshot('evt_target')

    await fs.writeFile(path.join(repo, 'src.txt'), 'work in progress I care about\n')
    const result = await restore({ checkpoint: target, repoPath: repo })

    const { loadCheckpoint } = await import('../server/storage/index.js')
    const safety = await loadCheckpoint(RUN, result.safetyCheckpointId!)
    expect(safety).toBeTruthy()
    expect(safety!.safety).toBe(true)
    expect(safety!.trackedPatch).toContain('work in progress I care about')

    // And the safety checkpoint really can bring the work back.
    await restore({ checkpoint: safety!, repoPath: repo })
    expect(await read('src.txt')).toBe('work in progress I care about\n')
  })

  it('refuses to restore when the repository path is gone', async () => {
    const cp = await snapshot('evt_missing_repo')
    const missing = { ...cp }
    await expect(restore({ checkpoint: missing, repoPath: path.join(repo, '__nope__') })).rejects.toBeInstanceOf(
      RestoreAbortedError,
    )
  })

  it('refuses to restore a checkpoint whose base commit is unknown here', async () => {
    const cp = await snapshot('evt_bad_base')
    const broken: Checkpoint = { ...cp, gitHead: '0'.repeat(40) }
    await expect(restore({ checkpoint: broken, repoPath: repo })).rejects.toThrow(/not in this repository/)
  })

  it('leaves the workspace intact when the patch cannot be applied', async () => {
    await fs.writeFile(path.join(repo, 'src.txt'), 'current important work\n')
    const cp = await snapshot('evt_corrupt')
    const corrupted: Checkpoint = {
      ...cp,
      trackedPatch: cp.trackedPatch.replace('original line', 'a line that never existed'),
    }

    await expect(restore({ checkpoint: corrupted, repoPath: repo })).rejects.toBeInstanceOf(RestoreAbortedError)

    // The failed restore must not have destroyed the user's work.
    expect(await read('src.txt')).toBe('current important work\n')
  })

  it('never rewrites the commit history', async () => {
    const before = (await git(repo, ['rev-parse', 'HEAD'])).trim()
    await fs.writeFile(path.join(repo, 'src.txt'), 'x\n')
    const cp = await snapshot('evt_history')
    await fs.writeFile(path.join(repo, 'src.txt'), 'y\n')
    await restore({ checkpoint: cp, repoPath: repo })
    expect((await git(repo, ['rev-parse', 'HEAD'])).trim()).toBe(before)
  })

  it('refuses to write outside the repository', async () => {
    const cp = await snapshot('evt_escape')
    const evil: Checkpoint = {
      ...cp,
      untrackedFiles: [{ path: '../escaped.txt', contentPath: 'untracked/escaped.txt' }],
    }
    await expect(restore({ checkpoint: evil, repoPath: repo })).rejects.toThrow(/outside the repository/)
  })
})
