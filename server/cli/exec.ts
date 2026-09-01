import { spawn } from 'node:child_process'
import * as G from '../git/index.js'
import { isTestCommand } from '../core/shell.js'

const MAX_CAPTURE = 512 * 1024

export function daemonUrl(): string {
  const host = process.env.GHOSTFRAME_HOST ?? '127.0.0.1'
  const port = process.env.GHOSTFRAME_PORT ?? '7331'
  return `http://${host}:${port}`
}

/**
 * `ghostframe exec -- <command>`
 *
 * Runs a command exactly as the shell would — same stdout, same stderr, same
 * exit code — and additionally files the result as an event on whichever run is
 * currently recording this repository. This is how test results reach the
 * timeline without GhostFrame having to intercept an agent's shell.
 *
 * It is deliberately transparent: if the daemon is down or nothing is
 * recording, the command still runs and the exit code is still yours.
 */
export async function execCommand(rawArgs: string[]): Promise<number> {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
  if (args.length === 0) {
    process.stderr.write('Usage: ghostframe exec -- <command> [args…]\n')
    return 2
  }
  const command = args.join(' ')

  let repoPath = process.cwd()
  try {
    repoPath = await G.repoRoot(repoPath)
  } catch {
    // Not a git repo — still run the command, just do not record it.
  }

  const runId = await findActiveRun(repoPath)
  const startedAt = Date.now()
  const captured = await run(command, repoPath)
  const durationMs = Date.now() - startedAt

  if (runId) {
    await record(runId, {
      command,
      stdout: captured.stdout,
      stderr: captured.stderr,
      exitCode: captured.exitCode,
      durationMs,
    })
  } else {
    process.stderr.write('ghostframe: no active recording for this repository — not recorded.\n')
  }

  return captured.exitCode
}

async function findActiveRun(repoPath: string): Promise<string | null> {
  try {
    const res = await fetch(`${daemonUrl()}/api/repo/info?path=${encodeURIComponent(repoPath)}`)
    if (!res.ok) return null
    const body = (await res.json()) as { activeRunId: string | null }
    return body.activeRunId
  } catch {
    process.stderr.write(`ghostframe: daemon not reachable at ${daemonUrl()} — not recorded.\n`)
    return null
  }
}

interface RecordPayload {
  command: string
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

async function record(runId: string, payload: RecordPayload): Promise<void> {
  try {
    const res = await fetch(`${daemonUrl()}/api/runs/${runId}/record-shell`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      process.stderr.write(`ghostframe: could not record this command (HTTP ${res.status}).\n`)
    }
  } catch (err) {
    process.stderr.write(`ghostframe: could not record this command: ${(err as Error).message}\n`)
  }
}

interface Captured {
  stdout: string
  stderr: string
  exitCode: number
}

/** Runs the command, teeing output to this terminal while capturing a copy. */
function run(command: string, cwd: string): Promise<Captured> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true })
    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk)
      if (stdout.length < MAX_CAPTURE) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
      if (stderr.length < MAX_CAPTURE) stderr += chunk.toString('utf8')
    })

    child.on('error', (err) => {
      process.stderr.write(`${err.message}\n`)
      resolve({ stdout, stderr: `${stderr}\n${err.message}`, exitCode: 127 })
    })
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }))
  })
}

export { isTestCommand }
