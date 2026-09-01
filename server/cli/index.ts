import { execCommand } from './exec.js'

const HELP = `GhostFrame — time-travel debugging for coding agents

Usage:
  ghostframe                     Start the local daemon and UI
  ghostframe serve               Same as above
  ghostframe exec -- <command>   Run a command and record it on the active run
  ghostframe --help              Show this message

Environment:
  GHOSTFRAME_HOME          Data directory (default ~/.ghostframe)
  GHOSTFRAME_HOST          Bind address (default 127.0.0.1)
  GHOSTFRAME_PORT          Port (default 7331)
  GHOSTFRAME_DEBOUNCE_MS   Change coalescing window (default 1000)
`

/** Returns an exit code, or null when the caller should start the daemon. */
export async function runCli(argv: string[]): Promise<number | null> {
  const [command, ...rest] = argv

  if (!command || command === 'serve') return null

  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP)
    return 0
  }

  if (command === '--version' || command === '-v') {
    process.stdout.write('0.2.0\n')
    return 0
  }

  if (command === 'exec') return execCommand(rest)

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`)
  return 2
}
