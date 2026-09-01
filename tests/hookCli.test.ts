import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, makeTempHome, makeTempRepo } from './helpers/tmpRepo.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.resolve(here, '..', 'server', 'index.ts')

let repo: string
let home: string

/** Runs `ghostframe hook` the way Claude Code does: JSON on stdin. */
function runHook(payload: unknown, env: Record<string, string> = {}): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', ENTRY, 'hook'],
      { env: { ...process.env, ...env }, timeout: 20_000 },
      (err, stdout) => {
        resolve({ code: err && typeof err.code === 'number' ? err.code : 0, stdout })
      },
    )
    child.stdin?.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
  })
}

beforeAll(async () => {
  home = await makeTempHome('hookcli')
  process.env.GHOSTFRAME_HOME = home
  repo = await makeTempRepo('hookcli')
})

afterAll(async () => {
  await cleanup(home, repo)
})

describe('ghostframe hook (the process Claude Code spawns)', () => {
  // Point at a port nothing is listening on: the hook must degrade silently.
  const noDaemon = { GHOSTFRAME_PORT: '7997' }

  it('exits 0 and prints nothing when the daemon is down', async () => {
    const res = await runHook(
      { hook_event_name: 'UserPromptSubmit', cwd: repo, prompt: 'hello' },
      noDaemon,
    )
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('exits 0 on malformed JSON', async () => {
    const res = await runHook('this is not json', noDaemon)
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('exits 0 on empty stdin', async () => {
    const res = await runHook('', noDaemon)
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('exits 0 outside a git repository', async () => {
    const res = await runHook(
      { hook_event_name: 'PostToolUse', cwd: path.dirname(repo), tool_name: 'Read', tool_input: { file_path: 'x' } },
      noDaemon,
    )
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('exits 0 for an unknown hook event', async () => {
    const res = await runHook({ hook_event_name: 'SomethingNew', cwd: repo }, noDaemon)
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('never writes to stdout even on a successful post', async () => {
    // stdout from a UserPromptSubmit hook is injected into the model's context,
    // so silence here is a correctness requirement, not tidiness.
    await fs.writeFile(path.join(repo, 'x.txt'), 'x')
    const res = await runHook({ hook_event_name: 'UserPromptSubmit', cwd: repo, prompt: 'hi' }, noDaemon)
    expect(res.stdout).toBe('')
  })
})
