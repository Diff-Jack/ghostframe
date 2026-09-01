import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { cleanup, makeTempDir, makeTempHome, makeTempRepo } from './helpers/tmpRepo.js'

let repo: string
let home: string
let plain: string
let install: typeof import('../server/cli/installHooks.js').installHooksCommand

const settingsPath = () => path.join(repo, '.claude', 'settings.json')
const readSettings = async (): Promise<Settings> =>
  JSON.parse(await fs.readFile(settingsPath(), 'utf8')) as Settings

interface HookEntry {
  hooks?: { command: string }[]
}
interface Settings {
  hooks?: Record<string, HookEntry[]>
  permissions?: unknown
  model?: unknown
}

function commandsIn(settings: Settings): string[] {
  const out: string[] = []
  for (const entries of Object.values(settings.hooks ?? {})) {
    for (const entry of entries) for (const h of entry.hooks ?? []) out.push(h.command)
  }
  return out
}

beforeAll(async () => {
  home = await makeTempHome('hooks')
  process.env.GHOSTFRAME_HOME = home
  repo = await makeTempRepo('hooks')
  plain = await makeTempDir('hooks-plain')
  install = (await import('../server/cli/installHooks.js')).installHooksCommand
})

afterAll(async () => {
  await cleanup(home, repo, plain)
})

describe('ghostframe install-hooks', () => {
  it('creates .claude/settings.json with both hook events', async () => {
    expect(await install([repo])).toBe(0)
    const settings = await readSettings()
    expect(Object.keys(settings.hooks)).toEqual(['UserPromptSubmit', 'PostToolUse'])
    expect(settings.hooks.PostToolUse[0].matcher).toBe('*')
    // Every command must be resolvable, and carry the sentinel we detect on.
    for (const cmd of commandsIn(settings)) {
      expect(cmd).toContain('hook')
      expect(cmd).toContain('--id=ghostframe')
    }
  })

  it('is idempotent — running twice does not duplicate hooks', async () => {
    const before = commandsIn(await readSettings()).length
    expect(await install([repo])).toBe(0)
    expect(commandsIn(await readSettings()).length).toBe(before)
  })

  it('preserves hooks and settings it did not write', async () => {
    const settings = await readSettings()
    settings.hooks!.PostToolUse[0].hooks!.unshift({ command: 'my-own-linter' })
    settings.permissions = { allow: ['Bash(npm test)'] }
    settings.model = 'opus'
    await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2))

    await install([repo])
    const after = await readSettings()
    expect(commandsIn(after)).toContain('my-own-linter')
    expect(after.permissions).toEqual({ allow: ['Bash(npm test)'] })
    expect(after.model).toBe('opus')
  })

  it('removes only its own hooks on --uninstall', async () => {
    expect(await install([repo, '--uninstall'])).toBe(0)
    const after = await readSettings()
    const cmds = commandsIn(after)
    expect(cmds).toContain('my-own-linter')
    expect(cmds.some((c) => c.includes('--id=ghostframe'))).toBe(false)
    // Unrelated settings survive a full uninstall.
    expect(after.permissions).toEqual({ allow: ['Bash(npm test)'] })
  })

  it('also recognises and removes hooks written by older versions', async () => {
    const settings = await readSettings()
    settings.hooks!.UserPromptSubmit = [{ hooks: [{ command: 'ghostframe hook' }] }]
    await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2))

    await install([repo, '--uninstall'])
    expect(commandsIn(await readSettings()).some((c) => c.includes('ghostframe'))).toBe(false)
  })

  it('refuses a directory that is not a git repository', async () => {
    expect(await install([plain])).toBe(1)
  })
})
