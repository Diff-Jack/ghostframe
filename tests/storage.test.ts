import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { cleanup, makeTempHome, makeTempRepo } from './helpers/tmpRepo.js'

let repo: string
let home: string
let capture: typeof import('../server/checkpoint/index.js').captureCheckpoint

const RUN = 'run_storagetest'

beforeAll(async () => {
  home = await makeTempHome('storage')
  process.env.GHOSTFRAME_HOME = home
  repo = await makeTempRepo('storage')
  capture = (await import('../server/checkpoint/index.js')).captureCheckpoint
})

afterAll(async () => {
  await cleanup(home, repo)
})

describe('checkpoint object store', () => {
  it('stores identical untracked content once per run', async () => {
    const big = 'x'.repeat(200_000)
    await fs.writeFile(path.join(repo, 'blob.bin'), big)

    const first = await capture({ runId: RUN, eventId: 'e1', repoPath: repo })
    // Three more checkpoints that all see the same untracked body.
    await capture({ runId: RUN, eventId: 'e2', repoPath: repo })
    await capture({ runId: RUN, eventId: 'e3', repoPath: repo })
    const last = await capture({ runId: RUN, eventId: 'e4', repoPath: repo })

    const entry = last.untrackedFiles.find((f) => f.path === 'blob.bin')!
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)

    const a = path.join(home, 'runs', RUN, 'checkpoints', first.id, entry.contentPath)
    const b = path.join(home, 'runs', RUN, 'checkpoints', last.id, entry.contentPath)

    // Same content...
    expect(await fs.readFile(b, 'utf8')).toBe(big)
    // ...and the same inode, so four checkpoints cost one copy.
    const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)])
    expect(sb.ino).toBe(sa.ino)
    expect(sb.nlink).toBeGreaterThanOrEqual(4)
  })

  it('keeps distinct content in distinct objects', async () => {
    await fs.writeFile(path.join(repo, 'blob.bin'), 'completely different\n')
    const cp = await capture({ runId: RUN, eventId: 'e5', repoPath: repo })
    const entry = cp.untrackedFiles.find((f) => f.path === 'blob.bin')!
    const file = path.join(home, 'runs', RUN, 'checkpoints', cp.id, entry.contentPath)
    expect(await fs.readFile(file, 'utf8')).toBe('completely different\n')

    const objects = await fs.readdir(path.join(home, 'runs', RUN, 'objects'))
    expect(objects.length).toBeGreaterThanOrEqual(2)
  })

  it('restores from a deduplicated object without disturbing other checkpoints', async () => {
    const { restoreCheckpoint } = await import('../server/checkpoint/index.js')
    const target = await capture({ runId: RUN, eventId: 'e6', repoPath: repo })

    await fs.writeFile(path.join(repo, 'blob.bin'), 'clobbered\n')
    await restoreCheckpoint({ checkpoint: target, repoPath: repo })

    expect(await fs.readFile(path.join(repo, 'blob.bin'), 'utf8')).toBe('completely different\n')

    // The restored file must be a fresh inode, not a link back into the store.
    const entry = target.untrackedFiles.find((f) => f.path === 'blob.bin')!
    const stored = path.join(home, 'runs', RUN, 'checkpoints', target.id, entry.contentPath)
    const [inRepo, inStore] = await Promise.all([
      fs.stat(path.join(repo, 'blob.bin')),
      fs.stat(stored),
    ])
    expect(inRepo.ino).not.toBe(inStore.ino)
  })
})
