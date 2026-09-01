import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import type { FastifyInstance } from 'fastify'
import type { RunDetail } from '../shared/types.js'
import { cleanup, makeTempDir, makeTempHome, makeTempRepo, until } from './helpers/tmpRepo.js'

let app: FastifyInstance
let repo: string
let home: string
let tmp: string
let runId: string
let ghostPath: string

beforeAll(async () => {
  home = await makeTempHome('trace')
  process.env.GHOSTFRAME_HOME = home
  process.env.GHOSTFRAME_DEBOUNCE_MS = '300'
  repo = await makeTempRepo('trace')
  tmp = await makeTempDir('trace-out')
  const { buildApp } = await import('../server/app.js')
  app = await buildApp()

  runId = (await app.inject({ method: 'POST', url: '/api/runs', payload: { repoPath: repo } })).json().run.id
  await fs.writeFile(path.join(repo, 'src.txt'), 'original line\nexported change\n')
  await fs.writeFile(path.join(repo, 'extra.txt'), 'untracked payload\n')
  await until(async () => {
    const d = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json() as RunDetail
    return d.checkpoints.some((c) => c.untrackedFiles.some((f) => f.path === 'extra.txt'))
  })
  await app.inject({ method: 'POST', url: `/api/runs/${runId}/stop` })
})

afterAll(async () => {
  const { stopAll } = await import('../server/core/recorder.js')
  await stopAll()
  await app?.close()
  await cleanup(home, repo, tmp)
})

describe('.ghost export / import', () => {
  it('exports a real zip archive with the documented layout', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/export` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/zip')
    expect(String(res.headers['content-disposition'])).toContain('.ghost')

    const buffer = res.rawPayload
    ghostPath = path.join(tmp, 'run.ghost')
    await fs.writeFile(ghostPath, buffer)

    const zip = await JSZip.loadAsync(buffer)
    expect(zip.file('manifest.json')).toBeTruthy()
    expect(zip.file('events.json')).toBeTruthy()
    expect(zip.file('metadata.json')).toBeTruthy()

    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    expect(manifest.format).toBe('ghostframe')
    expect(manifest.version).toBe(1)
    expect(manifest.runId).toBe(runId)

    const names = Object.keys(zip.files)
    expect(names.some((n) => /^checkpoints\/cp_[^/]+\/metadata\.json$/.test(n))).toBe(true)
    expect(names.some((n) => /^checkpoints\/cp_[^/]+\/working\.patch$/.test(n))).toBe(true)
    expect(names.some((n) => n.endsWith('untracked/extra.txt'))).toBe(true)
  })

  it('re-imports the archive as a new run with its timeline intact', async () => {
    const original = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json() as RunDetail

    await app.inject({ method: 'DELETE', url: `/api/runs/${runId}` })
    expect((await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).statusCode).toBe(404)

    const res = await app.inject({
      method: 'POST',
      url: '/api/trace/import-path',
      payload: { path: ghostPath },
    })
    expect(res.statusCode).toBe(200)
    const imported = res.json()
    expect(imported.run.imported).toBe(true)
    expect(imported.run.id).not.toBe(runId)
    expect(imported.readOnly).toBe(false)

    const detail = (await app.inject({ method: 'GET', url: `/api/runs/${imported.run.id}` })).json() as RunDetail
    expect(detail.events.length).toBe(original.events.length)
    expect(detail.checkpoints.length).toBe(original.checkpoints.length)
    expect(detail.events.every((e) => e.runId === imported.run.id)).toBe(true)

    const withDiff = detail.events.find((e) => e.type === 'file_change')!
    expect(withDiff.diff).toContain('exported change')

    const cp = detail.checkpoints.find((c) => c.untrackedFiles.some((f) => f.path === 'extra.txt'))!
    const stored = path.join(home, 'runs', imported.run.id, 'checkpoints', cp.id, 'untracked', 'extra.txt')
    expect(await fs.readFile(stored, 'utf8')).toBe('untracked payload\n')
  })

  it('imports read-only when the original repository is missing', async () => {
    const zip = await JSZip.loadAsync(await fs.readFile(ghostPath))
    const meta = JSON.parse(await zip.file('metadata.json')!.async('string'))
    meta.repoPath = path.join(tmp, 'a-repo-that-does-not-exist')
    zip.file('metadata.json', JSON.stringify(meta))
    const moved = path.join(tmp, 'moved.ghost')
    await fs.writeFile(moved, await zip.generateAsync({ type: 'nodebuffer' }))

    const res = await app.inject({ method: 'POST', url: '/api/trace/import-path', payload: { path: moved } })
    expect(res.statusCode).toBe(200)
    expect(res.json().readOnly).toBe(true)
    expect(res.json().message).toContain('read-only')

    // A read-only trace must refuse restore rather than touching anything.
    const detail = (await app.inject({ method: 'GET', url: `/api/runs/${res.json().run.id}` })).json() as RunDetail
    const cp = detail.checkpoints[0]
    const restoreRes = await app.inject({
      method: 'POST',
      url: `/api/runs/${detail.run.id}/checkpoints/${cp.id}/restore`,
    })
    expect(restoreRes.statusCode).toBe(400)
    expect(restoreRes.json().error).toContain('read-only')
  })

  it('rejects a file that is not a ghost archive', async () => {
    const junk = path.join(tmp, 'not-a-trace.ghost')
    await fs.writeFile(junk, 'this is definitely not a zip')
    const res = await app.inject({ method: 'POST', url: '/api/trace/import-path', payload: { path: junk } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('not a valid .ghost archive')
  })

  it('rejects a zip without a GhostFrame manifest', async () => {
    const zip = new JSZip()
    zip.file('hello.txt', 'hi')
    const junk = path.join(tmp, 'plain.ghost')
    await fs.writeFile(junk, await zip.generateAsync({ type: 'nodebuffer' }))
    const res = await app.inject({ method: 'POST', url: '/api/trace/import-path', payload: { path: junk } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('no manifest.json')
  })

  it('rejects a future trace version', async () => {
    const zip = await JSZip.loadAsync(await fs.readFile(ghostPath))
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    manifest.version = 999
    zip.file('manifest.json', JSON.stringify(manifest))
    const future = path.join(tmp, 'future.ghost')
    await fs.writeFile(future, await zip.generateAsync({ type: 'nodebuffer' }))

    const res = await app.inject({ method: 'POST', url: '/api/trace/import-path', payload: { path: future } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('Unsupported trace version')
  })
})
