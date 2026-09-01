import { doctorCommand } from './doctor.js'
import { execCommand } from './exec.js'
import { hookCommand } from './hook.js'
import { installHooksCommand } from './installHooks.js'

const HELP = `GhostFrame — time-travel debugging for coding agents

Usage:
  ghostframe                     Start the local daemon and UI
  ghostframe serve               Same as above
  ghostframe exec -- <command>   Run a command and record it on the active run
  ghostframe install-hooks [dir] Wire GhostFrame into Claude Code for a repo
  ghostframe hook                Internal: called by Claude Code hooks (stdin)
  ghostframe doctor [dir]        Diagnose why hooks or recording are not working
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
  if (command === 'hook') return hookCommand(rest)
  if (command === 'install-hooks') return installHooksCommand(rest)
  if (command === 'doctor') return doctorCommand(rest)

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`)
  return 2
}
