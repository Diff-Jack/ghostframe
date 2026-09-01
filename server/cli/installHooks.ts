import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as G from '../git/index.js'

/**
 * Stable sentinel written into every hook command we install.
 *
 * The command text itself varies — `ghostframe hook` when the binary is on
 * PATH, an absolute node invocation when it is not — so detection cannot rely
 * on the executable name. `ghostframe hook` is still matched so hooks written
 * by earlier versions are recognised and can be upgraded or removed.
 */
const SENTINEL = '--id=ghostframe'
const LEGACY_MARKER = 'ghostframe hook'

function isOurs(command: string | undefined): boolean {
  if (!command) return false
  return command.includes(SENTINEL) || command.includes(LEGACY_MARKER)
}

/** Quotes a path for a shell command only when it needs it. */
function shellQuote(value: string): string {
  return /[\s"'$`\\]/.test(value) ? `"${value.replace(/(["$`\\])/g, '\\$1')}"` : value
}

/**
 * The command Claude Code should run.
 *
 * Prefers the bare `ghostframe` name so the hook keeps working if the install
 * moves. Falls back to an absolute invocation of the currently running build,
 * because a hook that resolves to nothing fails *silently* — the worst possible
 * failure mode for a recorder.
 */
function hookCommandText(): string {
  if (whichSync('ghostframe')) return `ghostframe hook ${SENTINEL}`
  const entry = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'index.js')
  return `${shellQuote(process.execPath)} ${shellQuote(entry)} hook ${SENTINEL}`
}

function whichSync(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, bin)
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK)
      return candidate
    } catch {
      // Keep looking.
    }
  }
  return null
}

interface HookCommand {
  type: 'command'
  command: string
}
interface HookMatcher {
  matcher?: string
  hooks: HookCommand[]
}
interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>
  [key: string]: unknown
}

/** Hook events GhostFrame listens to, and the matcher each needs. */
const WANTED: Array<{ event: string; matcher?: string }> = [
  { event: 'UserPromptSubmit' },
  { event: 'PostToolUse', matcher: '*' },
]

/**
 * `ghostframe install-hooks [repo]`
 *
 * Merges GhostFrame's hooks into a repository's .claude/settings.json without
 * disturbing hooks that are already there. Idempotent.
 */
export async function installHooksCommand(argv: string[]): Promise<number> {
  const uninstall = argv.includes('--uninstall')
  const target = argv.find((a) => !a.startsWith('-')) ?? process.cwd()

  let repoPath: string
  try {
    repoPath = await G.repoRoot(path.resolve(target))
  } catch {
    process.stderr.write(`Not a git repository: ${path.resolve(target)}\n`)
    return 1
  }

  const settingsPath = path.join(repoPath, '.claude', 'settings.json')
  const settings = await readSettings(settingsPath)
  const before = JSON.stringify(settings)

  settings.hooks ??= {}
  for (const { event, matcher } of WANTED) {
    settings.hooks[event] = mergeEvent(settings.hooks[event] ?? [], matcher, uninstall)
    if (settings.hooks[event].length === 0) delete settings.hooks[event]
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks

  if (JSON.stringify(settings) === before) {
    process.stdout.write(
      uninstall ? 'GhostFrame hooks were not installed here.\n' : `GhostFrame hooks already installed in ${settingsPath}\n`,
    )
    return 0
  }

  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')

  if (uninstall) {
    process.stdout.write(`Removed GhostFrame hooks from ${settingsPath}\n`)
    return 0
  }

  process.stdout.write(
    `Installed GhostFrame hooks in ${settingsPath}\n` +
      `  command: ${hookCommandText()}\n\n` +
      'Claude Code will now report prompts and tool calls to GhostFrame.\n' +
      'Start a recording for this repository and your timeline will group\n' +
      'every edit under the instruction that caused it.\n\n' +
      'Remove them again with: ghostframe install-hooks --uninstall\n',
  )
  return 0
}

/** Adds or removes our entry, leaving any other hooks in the list untouched. */
function mergeEvent(existing: HookMatcher[], matcher: string | undefined, uninstall: boolean): HookMatcher[] {
  const cleaned = existing
    .map((entry) => ({
      ...entry,
      hooks: (entry.hooks ?? []).filter((h) => !isOurs(h.command)),
    }))
    .filter((entry) => entry.hooks.length > 0)

  if (uninstall) return cleaned

  const ours: HookCommand = { type: 'command', command: hookCommandText() }
  const slot = cleaned.find((entry) => (entry.matcher ?? '') === (matcher ?? ''))
  if (slot) {
    slot.hooks.push(ours)
    return cleaned
  }
  return [...cleaned, matcher ? { matcher, hooks: [ours] } : { hooks: [ours] }]
}

async function readSettings(file: string): Promise<ClaudeSettings> {
  if (!fsSync.existsSync(file)) return {}
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as ClaudeSettings
  } catch {
    throw new Error(`${file} is not valid JSON — fix or remove it before installing hooks.`)
  }
}
