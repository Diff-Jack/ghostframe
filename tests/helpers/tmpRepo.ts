import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd })
  return stdout
}

/** Creates a throwaway git repository with one commit. */
export async function makeTempRepo(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `gf-${label}-`))
  const real = await fs.realpath(dir)
  await git(real, ['init', '-q', '-b', 'main'])
  await git(real, ['config', 'user.email', 'test@ghostframe.local'])
  await git(real, ['config', 'user.name', 'GhostFrame Test'])
  await git(real, ['config', 'commit.gpgsign', 'false'])
  await fs.writeFile(path.join(real, 'README.md'), '# fixture\n')
  await fs.writeFile(path.join(real, 'src.txt'), 'original line\n')
  await git(real, ['add', '.'])
  await git(real, ['commit', '-q', '-m', 'initial'])
  return real
}

export async function makeTempHome(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `gf-home-${label}-`))
  return fs.realpath(dir)
}

export async function makeTempDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `gf-dir-${label}-`))
  return fs.realpath(dir)
}

export async function cleanup(...dirs: string[]): Promise<void> {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Polls until `check` returns true or the deadline passes. */
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await wait(100)
  }
  throw new Error('Timed out waiting for condition')
}
