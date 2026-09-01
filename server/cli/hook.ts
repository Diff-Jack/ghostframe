import path from 'node:path'
import fsSync from 'node:fs'
import * as G from '../git/index.js'
import { daemonUrl } from './exec.js'

/**
 * Shape of the JSON a Claude Code hook receives on stdin. Every field is
 * optional on purpose: hook payloads differ per event and across versions, and
 * a hook that throws on an unexpected shape would break the user's agent.
 */
interface HookPayload {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  prompt?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: Record<string, unknown>
}

interface AgentEvent {
  repoPath: string
  agent: string
  sessionId?: string
  kind: 'prompt' | 'tool'
  prompt?: string
  toolName?: string
  toolSummary?: string
  paths?: string[]
  command?: string
  exitCode?: number
}

/**
 * `ghostframe hook` — reads a hook payload on stdin and files it with the
 * daemon.
 *
 * Two hard rules, because this runs inside someone's agent loop:
 *   1. Always exit 0. A recorder must never be the reason a coding session
 *      breaks.
 *   2. Never write to stdout. Claude Code feeds a UserPromptSubmit hook's
 *      stdout back to the model as extra context.
 */
export async function hookCommand(argv: string[]): Promise<number> {
  try {
    const raw = await readStdin(2000)
    if (!raw.trim()) return 0

    let payload: HookPayload
    try {
      payload = JSON.parse(raw) as HookPayload
    } catch {
      return 0
    }

    const agent = argv[0]?.startsWith('--agent=') ? argv[0].slice('--agent='.length) : 'claude-code'
    const event = await toEvent(payload, agent)
    if (!event) return 0

    await post(event)
  } catch {
    // Swallow everything. See rule 1.
  }
  return 0
}

async function toEvent(payload: HookPayload, agent: string): Promise<AgentEvent | null> {
  const cwd = payload.cwd ?? process.cwd()
  let repoPath = cwd
  try {
    repoPath = await G.repoRoot(cwd)
  } catch {
    return null // Not a git repository; nothing GhostFrame can attach to.
  }

  const base = { repoPath, agent, sessionId: payload.session_id }
  const hookName = payload.hook_event_name ?? ''

  if (hookName === 'UserPromptSubmit' || (!payload.tool_name && payload.prompt)) {
    const prompt = (payload.prompt ?? '').trim()
    if (!prompt) return null
    return { ...base, kind: 'prompt', prompt }
  }

  if (!payload.tool_name) return null

  const input = payload.tool_input ?? {}
  const paths = collectPaths(input, repoPath)
  const command = typeof input.command === 'string' ? input.command : undefined

  return {
    ...base,
    kind: 'tool',
    toolName: payload.tool_name,
    toolSummary: summarise(payload.tool_name, input, paths, command),
    paths: paths.length ? paths : undefined,
    command,
    exitCode: readExitCode(payload.tool_response),
  }
}

/** Pulls file paths out of a tool's input, made repo-relative where possible. */
function collectPaths(input: Record<string, unknown>, repoPath: string): string[] {
  const found: string[] = []
  for (const key of ['file_path', 'path', 'notebook_path', 'filePath']) {
    const value = input[key]
    if (typeof value === 'string' && value) found.push(value)
  }
  const edits = input.edits
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const p = (edit as { file_path?: unknown })?.file_path
      if (typeof p === 'string') found.push(p)
    }
  }
  return found.map((p) => relativise(p, repoPath))
}

function relativise(target: string, repoPath: string): string {
  if (!path.isAbsolute(target)) return target
  // git reports the repo root as a real path, but an agent may hand us a path
  // through a symlink (/tmp -> /private/tmp on macOS). Compare real paths, or
  // every file would look like it lives outside the repository.
  const rel = path.relative(realpath(repoPath), realpath(target))
  // Keep the absolute path when the file genuinely lives outside the repo —
  // that is exactly the case a reader most wants to notice.
  return rel && !rel.startsWith('..') ? rel : target
}

/** Resolves symlinks, falling back to the input for paths that do not exist. */
function realpath(target: string): string {
  try {
    return fsSync.realpathSync.native(target)
  } catch {
    const dir = path.dirname(target)
    try {
      return path.join(fsSync.realpathSync.native(dir), path.basename(target))
    } catch {
      return target
    }
  }
}

function summarise(
  toolName: string,
  input: Record<string, unknown>,
  paths: string[],
  command: string | undefined,
): string {
  if (command) return command
  if (paths.length === 1) return paths[0]
  if (paths.length > 1) return `${paths.length} files`
  for (const key of ['pattern', 'query', 'url', 'description']) {
    const value = input[key]
    if (typeof value === 'string' && value) return value
  }
  return toolName
}

function readExitCode(response: Record<string, unknown> | undefined): number | undefined {
  if (!response) return undefined
  for (const key of ['exit_code', 'exitCode', 'returncode']) {
    const value = response[key]
    if (typeof value === 'number') return value
  }
  return undefined
}

async function post(event: AgentEvent): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1500)
  try {
    await fetch(`${daemonUrl()}/api/agent/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve(data)
    }
    const timer = setTimeout(done, timeoutMs)
    timer.unref?.()

    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      data += chunk
    })
    process.stdin.on('end', () => {
      clearTimeout(timer)
      done()
    })
    process.stdin.on('error', () => {
      clearTimeout(timer)
      done()
    })
  })
}
