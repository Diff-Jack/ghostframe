import path from 'node:path'

/**
 * Paths that should make a reader stop and look.
 *
 * The point of surfacing these is not to accuse an agent of anything — it is
 * that "my agent read .env two turns before it made a network call" is exactly
 * the kind of thing a plain git diff can never tell you.
 */
const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.envrc',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.git-credentials',
  'credentials',
  'kubeconfig',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'known_hosts',
])

const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env(\.|$)/i, // .env.local, .env.production
  /(^|[._-])(secret|secrets|credential|credentials)([._-]|$)/i,
  /(^|[._-])(api[._-]?key|access[._-]?token|private[._-]?key)([._-]|$)/i,
  /^service[-_]?account.*\.json$/i,
  /^\.?aws[/\\]credentials$/i,
]

const SENSITIVE_DIRS = ['.ssh', '.gnupg', '.aws', '.kube', '.docker']

/** Key material is sensitive whatever it is called. */
const KEY_MATERIAL_EXT = /\.(pem|p12|pfx|jks|keystore|key)$/i

/**
 * Extensions that make a name-based match a false alarm.
 *
 * `credentials-guide.md` is documentation and `tokenizer.ts` is source. A
 * detector that flags those gets ignored within a day, which is worse than not
 * having one — so the word-based rules below never fire on these.
 */
const PROSE_OR_CODE_EXT = new Set([
  'md', 'mdx', 'rst', 'adoc', 'html', 'htm', 'css', 'scss', 'less',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'rb',
  'php', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'kt', 'kts', 'scala',
  'sql', 'lock', 'snap', 'map', 'svg', 'png', 'jpg', 'jpeg', 'gif',
])

/** Strips editor/backup suffixes so `notes.md.bak` is still judged as prose. */
const BACKUP_SUFFIX = /\.(bak|orig|tmp|save|swp|old|rej)$/i

function effectiveExtension(base: string): string {
  let name = base
  while (BACKUP_SUFFIX.test(name)) name = name.replace(BACKUP_SUFFIX, '')
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** True when a path looks like it holds a credential. */
export function isSensitivePath(filePath: string): boolean {
  if (!filePath) return false
  const normalised = filePath.split(path.sep).join('/')
  const base = normalised.split('/').pop() ?? ''
  const segments = normalised.split('/')

  // Unambiguous: an exact known name, key material, or a secrets directory.
  if (SENSITIVE_BASENAMES.has(base.toLowerCase())) return true
  if (KEY_MATERIAL_EXT.test(base)) return true
  if (segments.some((segment) => SENSITIVE_DIRS.includes(segment.toLowerCase()))) return true

  // Heuristic name matching, suppressed for prose and source files.
  if (PROSE_OR_CODE_EXT.has(effectiveExtension(base))) return false
  return SENSITIVE_PATTERNS.some((re) => re.test(base))
}

/** Filters a list of touched paths down to the ones worth flagging. */
export function flagSensitive(paths: (string | undefined)[]): string[] {
  const flagged = new Set<string>()
  for (const p of paths) {
    if (p && isSensitivePath(p)) flagged.add(p)
  }
  return [...flagged]
}

/**
 * Hosts an agent reached out to, pulled from a shell command.
 *
 * Deliberately simple: it reads the command text rather than intercepting
 * traffic. It will miss things, so it is presented as "these URLs appeared in
 * a command", never as a complete record of egress.
 */
export function extractHosts(command: string | undefined): string[] {
  if (!command) return []
  const hosts = new Set<string>()
  const re = /https?:\/\/([A-Za-z0-9._-]+(?::\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command)) !== null) {
    const host = m[1].toLowerCase()
    if (!host.startsWith('127.0.0.1') && !host.startsWith('localhost')) hosts.add(host)
  }
  return [...hosts]
}
