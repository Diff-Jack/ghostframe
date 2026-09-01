import { spawn } from 'node:child_process'

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  timedOut: boolean
}

const MAX_OUTPUT = 512 * 1024
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Runs a user-typed command in the repository. GhostFrame does not intercept
 * an agent's shell in v0.2 — this is the manual path that produces shell/test
 * events on the timeline.
 */
export function runCommand(
  cwd: string,
  command: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ShellResult> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8')
    })

    const finish = (exitCode: number) => {
      clearTimeout(timer)
      resolve({
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        exitCode,
        durationMs: Date.now() - startedAt,
        timedOut,
      })
    }

    child.on('error', (err) => {
      stderr += `\n${err.message}`
      finish(127)
    })
    child.on('close', (code) => finish(code ?? (timedOut ? 124 : 1)))
  })
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text
  return `${text.slice(0, MAX_OUTPUT)}\n… output truncated at ${MAX_OUTPUT} bytes …`
}

/**
 * Conservative test detection: only well-known runners count, so an arbitrary
 * script is never mislabelled as a test result the regression check trusts.
 */
const TEST_PATTERNS = [
  /(^|\s|\/)(vitest|jest|mocha|ava|pytest|tox)(\s|$)/,
  /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?test(\s|:|$)/,
  /(^|\s)go\s+test(\s|$)/,
  /(^|\s)cargo\s+test(\s|$)/,
  /(^|\s)(python|python3)\s+-m\s+(pytest|unittest)(\s|$)/,
  /(^|\s)(rspec|phpunit|gradlew?\s+test|mvn\s+test|dotnet\s+test)(\s|$)/,
]

export function isTestCommand(command: string): boolean {
  const normalised = command.trim().toLowerCase()
  return TEST_PATTERNS.some((re) => re.test(normalised))
}
