import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import * as G from '../git/index.js'
import { daemonUrl } from './exec.js'

const OK = '✓'
const BAD = '✗'
const WARN = '!'

/**
 * `ghostframe doctor`
 *
 * Hooks are deliberately silent — a recorder must never break someone's coding
 * session — which means a misconfiguration produces no error anywhere. This is
 * where that silence gets explained.
 */
export async function doctorCommand(argv: string[]): Promise<number> {
  const target = argv.find((a) => !a.startsWith('-')) ?? process.cwd()
  const lines: string[] = []
  let failed = false

  const say = (status: string, text: string, hint?: string) => {
    lines.push(`  ${status} ${text}`)
    if (hint) lines.push(`      ${hint}`)
    if (status === BAD) failed = true
  }

  // 1. Daemon reachable, and new enough to understand agent events?
  let daemonUp = false
  try {
    const res = await fetch(`${daemonUrl()}/api/health`, { signal: AbortSignal.timeout(2000) })
    const body = (await res.json()) as { version?: string }
    daemonUp = res.ok
    say(OK, `Daemon reachable at ${daemonUrl()} (v${body.version ?? '?'})`)
  } catch {
    say(BAD, `Daemon not reachable at ${daemonUrl()}`, 'Start it with: ghostframe')
  }

  if (daemonUp) {
    try {
      const res = await fetch(`${daemonUrl()}/api/agent/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoPath: target, kind: 'prompt', prompt: '' }),
        signal: AbortSignal.timeout(2000),
      })
      if (res.status === 404) {
        say(BAD, 'Daemon does not support agent hooks', 'It is running an older build. Rebuild and restart it.')
      } else {
        say(OK, 'Daemon accepts agent hook events')
      }
    } catch {
      say(WARN, 'Could not verify the agent hook endpoint')
    }
  }

  // 2. Is this a git repo, and is anything recording it?
  let repoPath: string | null = null
  try {
    repoPath = await G.repoRoot(path.resolve(target))
    say(OK, `Git repository: ${repoPath}`)
  } catch {
    say(BAD, `Not a git repository: ${path.resolve(target)}`)
  }

  if (daemonUp && repoPath) {
    try {
      const res = await fetch(`${daemonUrl()}/api/repo/info?path=${encodeURIComponent(repoPath)}`, {
        signal: AbortSignal.timeout(2000),
      })
      const body = (await res.json()) as { activeRunId?: string | null }
      if (body.activeRunId) {
        say(OK, `Recording is active (run ${body.activeRunId})`)
      } else {
        say(WARN, 'Nothing is recording this repository', 'Press Start Recording in the UI, then events will be captured.')
      }
    } catch {
      say(WARN, 'Could not read recording status')
    }
  }

  // 3. Are the Claude Code hooks wired up?
  if (repoPath) {
    const settingsPath = path.join(repoPath, '.claude', 'settings.json')
    if (!fsSync.existsSync(settingsPath)) {
      say(WARN, 'No .claude/settings.json in this repository', 'Install hooks with: ghostframe install-hooks')
    } else {
      const raw = await fs.readFile(settingsPath, 'utf8').catch(() => '')
      if (raw.includes('--id=ghostframe') || raw.includes('ghostframe hook')) {
        say(OK, `Claude Code hooks installed (${settingsPath})`)
      } else {
        say(WARN, 'Claude Code hooks are not installed here', 'Install them with: ghostframe install-hooks')
      }
    }
  }

  // 4. Is `ghostframe` actually on PATH? The hook command depends on it.
  const onPath = await which('ghostframe')
  if (onPath) {
    say(OK, `\`ghostframe\` on PATH (${onPath})`)
  } else {
    say(
      WARN,
      '`ghostframe` is not on your PATH',
      'install-hooks writes an absolute path instead, so hooks still work — but they will break if you move this checkout. `npm link` makes them portable.',
    )
  }

  process.stdout.write(`\nGhostFrame doctor\n\n${lines.join('\n')}\n\n`)
  process.stdout.write(failed ? 'Some checks failed — see the hints above.\n' : 'All good.\n')
  return failed ? 1 : 0
}

async function which(bin: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, bin)
    try {
      await fs.access(candidate, fsSync.constants.X_OK)
      return candidate
    } catch {
      // Not here; keep looking.
    }
  }
  return null
}
