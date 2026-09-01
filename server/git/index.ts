import { execFile } from 'node:child_process'
import path from 'node:path'
import type { RepoInfo } from '../../shared/types.js'

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Runs git with a fixed argv (never a shell string) so repository paths and
 * file names containing spaces or quotes cannot be reinterpreted.
 */
export function git(
  cwd: string,
  args: string[],
  opts: { input?: string | Buffer; allowFailure?: boolean; maxBuffer?: number } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout, stderr) => {
        const exitCode = error && typeof error.code === 'number' ? error.code : 0
        if (error && !opts.allowFailure) {
          reject(new GitError(`git ${args.join(' ')} failed: ${stderr || error.message}`, stderr, exitCode))
          return
        }
        resolve({ stdout, stderr, exitCode })
      },
    )
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input)
    }
  })
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const res = await git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true })
  return res.exitCode === 0 && res.stdout.trim() === 'true'
}

/** Resolves the repository root, so opening a subdirectory still works. */
export async function repoRoot(dir: string): Promise<string> {
  const res = await git(dir, ['rev-parse', '--show-toplevel'])
  return res.stdout.trim()
}

export async function currentBranch(dir: string): Promise<string> {
  const res = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true })
  const name = res.stdout.trim()
  if (res.exitCode !== 0 || !name) return 'HEAD'
  return name
}

export async function headCommit(dir: string): Promise<string> {
  const res = await git(dir, ['rev-parse', 'HEAD'], { allowFailure: true })
  return res.exitCode === 0 ? res.stdout.trim() : ''
}

export async function hasCommits(dir: string): Promise<boolean> {
  const res = await git(dir, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true })
  return res.exitCode === 0
}

/** Repo-relative paths of files git reports as modified/staged/deleted. */
export async function dirtyFiles(dir: string): Promise<string[]> {
  const res = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  return parsePorcelainZ(res.stdout)
}

function parsePorcelainZ(out: string): string[] {
  const files: string[] = []
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) continue
    const status = entry.slice(0, 2)
    const p = entry.slice(3)
    if (!p) continue
    // Renames carry the source path in the following NUL-separated field.
    if (status.includes('R') || status.includes('C')) {
      files.push(p)
      i++
      continue
    }
    files.push(p)
  }
  return files
}

/** Untracked, non-ignored files (repo-relative). */
export async function untrackedFiles(dir: string): Promise<string[]> {
  const res = await git(dir, ['ls-files', '--others', '--exclude-standard', '-z'])
  return res.stdout.split('\0').filter(Boolean)
}

/**
 * Unified diff of tracked files between `ref` (default HEAD) and the working
 * tree, including staged changes. `--binary` keeps the patch appliable when a
 * binary file changed.
 */
export async function trackedPatch(dir: string, ref = 'HEAD'): Promise<string> {
  if (!(await hasCommits(dir))) return ''
  const res = await git(dir, ['diff', '--binary', '--no-color', '--no-ext-diff', ref])
  return res.stdout
}

/** Human-readable diff (no binary blobs) used for display in the UI. */
export async function displayDiff(dir: string, ref = 'HEAD'): Promise<string> {
  const chunks: string[] = []
  if (await hasCommits(dir)) {
    const res = await git(dir, ['diff', '--no-color', '--no-ext-diff', ref])
    if (res.stdout.trim()) chunks.push(res.stdout)
  }
  // Untracked files never show up in `git diff`; render them as additions.
  const untracked = await untrackedFiles(dir)
  for (const rel of untracked) {
    const res = await git(
      dir,
      ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', devNull(), rel],
      { allowFailure: true },
    )
    if (res.stdout.trim()) chunks.push(res.stdout)
  }
  return chunks.join('\n')
}

function devNull(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null'
}

/** Paths touched by a unified diff, extracted from its `diff --git` headers. */
export function patchFilePaths(patch: string): string[] {
  const paths = new Set<string>()
  for (const line of patch.split('\n')) {
    if (!line.startsWith('diff --git ')) continue
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (m) {
      paths.add(m[1])
      paths.add(m[2])
    }
  }
  return [...paths]
}

/** True when the patch would apply cleanly to the current working tree. */
export async function canApplyPatch(dir: string, patch: string): Promise<boolean> {
  if (!patch.trim()) return true
  const res = await git(dir, ['apply', '--check', '--whitespace=nowarn', '-'], {
    input: patch,
    allowFailure: true,
  })
  return res.exitCode === 0
}

export async function applyPatch(dir: string, patch: string): Promise<void> {
  if (!patch.trim()) return
  const res = await git(dir, ['apply', '--whitespace=nowarn', '-'], {
    input: patch,
    allowFailure: true,
  })
  if (res.exitCode !== 0) {
    throw new GitError(`git apply failed: ${res.stderr.trim()}`, res.stderr, res.exitCode)
  }
}

export async function commitExists(dir: string, sha: string): Promise<boolean> {
  if (!sha) return false
  const res = await git(dir, ['cat-file', '-e', `${sha}^{commit}`], { allowFailure: true })
  return res.exitCode === 0
}

/** Files that exist in the given commit, limited to the supplied paths. */
export async function filesInCommit(dir: string, sha: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  const res = await git(dir, ['ls-tree', '-r', '--name-only', '-z', sha, '--', ...paths], {
    allowFailure: true,
  })
  if (res.exitCode !== 0) return new Set()
  return new Set(res.stdout.split('\0').filter(Boolean))
}

export async function getRepoInfo(dir: string): Promise<RepoInfo> {
  const root = await repoRoot(dir)
  const [branch, head, dirty, commits] = await Promise.all([
    currentBranch(root),
    headCommit(root),
    dirtyFiles(root),
    hasCommits(root),
  ])
  return {
    path: root,
    name: path.basename(root),
    isGitRepo: true,
    branch,
    headCommit: head,
    headCommitShort: head ? head.slice(0, 7) : '',
    status: dirty.length === 0 ? 'clean' : 'dirty',
    dirtyFileCount: dirty.length,
    warning: commits ? undefined : 'This repository has no commits yet. Checkpoints will only capture untracked files until you make the first commit.',
  }
}
