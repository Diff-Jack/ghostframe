import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { FastifyInstance } from 'fastify'
import type { Run, RunDetail, StreamMessage } from '../../shared/types.js'
import * as G from '../git/index.js'
import { RestoreAbortedError, restoreCheckpoint } from '../checkpoint/index.js'
import { analyseRegression } from '../core/analysis.js'
import { bus } from '../core/bus.js'
import * as recorder from '../core/recorder.js'
import { isTestCommand, runCommand } from '../core/shell.js'
import { exportRun, importTrace, TraceError } from '../trace/index.js'
import {
  deleteRun,
  findCheckpoint,
  listCheckpoints,
  listRuns,
  loadEvents,
  loadRun,
  newId,
  appendEvent,
  saveRun,
} from '../storage/index.js'

/** Expands `~` and relative input the way a user typing a path expects. */
function normalisePath(input: string): string {
  let p = input.trim()
  if (!p) return p
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1))
  return path.resolve(p)
}

function httpError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, status: number, message: string) {
  return reply.code(status).send({ error: message })
}

async function decorateRun(run: Run): Promise<Run> {
  const exists = recorder.repoExists(run.repoPath)
  return { ...run, readOnly: run.readOnly || !exists }
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true, version: '0.2.0', home: process.env.GHOSTFRAME_HOME ?? null }))

  // --- Repository ----------------------------------------------------------
  app.post<{ Body: { path?: string } }>('/api/repo/open', async (req, reply) => {
    const raw = req.body?.path
    if (!raw || !raw.trim()) return httpError(reply, 400, 'Enter a repository path.')
    const target = normalisePath(raw)

    if (!fsSync.existsSync(target)) {
      return httpError(reply, 404, `No such directory: ${target}`)
    }
    const stat = await fs.stat(target)
    if (!stat.isDirectory()) {
      return httpError(reply, 400, `${target} is a file, not a directory.`)
    }
    if (!(await G.isGitRepo(target))) {
      return httpError(reply, 400, 'This directory is not a Git repository.')
    }

    const info = await G.getRepoInfo(target)
    const active = recorder.activeSessionForRepo(info.path)
    return { repo: info, activeRunId: active?.id ?? null }
  })

  app.get<{ Querystring: { path?: string } }>('/api/repo/info', async (req, reply) => {
    const raw = req.query.path
    if (!raw) return httpError(reply, 400, 'Missing path.')
    const target = normalisePath(raw)
    if (!fsSync.existsSync(target)) return httpError(reply, 404, `No such directory: ${target}`)
    if (!(await G.isGitRepo(target))) return httpError(reply, 400, 'This directory is not a Git repository.')
    const info = await G.getRepoInfo(target)
    const active = recorder.activeSessionForRepo(info.path)
    return { repo: info, activeRunId: active?.id ?? null }
  })

  // --- Runs ----------------------------------------------------------------
  app.get('/api/runs', async () => {
    const runs = await listRuns()
    return { runs: await Promise.all(runs.map(decorateRun)), activeRunIds: recorder.activeRuns().map((r) => r.id) }
  })

  app.post<{ Body: { repoPath?: string; title?: string } }>('/api/runs', async (req, reply) => {
    const raw = req.body?.repoPath
    if (!raw) return httpError(reply, 400, 'Missing repoPath.')
    const target = normalisePath(raw)
    if (!(await G.isGitRepo(target))) return httpError(reply, 400, 'This directory is not a Git repository.')
    try {
      const run = await recorder.startRun({ repoPath: target, title: req.body?.title })
      return { run }
    } catch (err) {
      return httpError(reply, 409, (err as Error).message)
    }
  })

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const run = await loadRun(req.params.id)
    if (!run) return httpError(reply, 404, `Unknown run: ${req.params.id}`)
    const detail: RunDetail = {
      run: await decorateRun(run),
      events: await loadEvents(run.id),
      checkpoints: await listCheckpoints(run.id),
    }
    return detail
  })

  app.post<{ Params: { id: string } }>('/api/runs/:id/stop', async (req, reply) => {
    const run = await loadRun(req.params.id)
    if (!run) return httpError(reply, 404, `Unknown run: ${req.params.id}`)
    return { run: await recorder.stopRun(run.id) }
  })

  app.delete<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    if (recorder.isRecording(req.params.id)) {
      return httpError(reply, 409, 'Stop the recording before deleting this run.')
    }
    const removed = await deleteRun(req.params.id)
    if (!removed) return httpError(reply, 404, `Unknown run: ${req.params.id}`)
    bus.publish({ type: 'runs-changed' })
    return { ok: true }
  })

  app.get<{ Params: { id: string } }>('/api/runs/:id/analysis', async (req, reply) => {
    const run = await loadRun(req.params.id)
    if (!run) return httpError(reply, 404, `Unknown run: ${req.params.id}`)
    return analyseRegression(await loadEvents(run.id))
  })

  // --- Shell / test commands ----------------------------------------------
  app.post<{ Params: { id: string }; Body: { command?: string } }>(
    '/api/runs/:id/shell',
    async (req, reply) => {
      const run = await loadRun(req.params.id)
      if (!run) return httpError(reply, 404, `Unknown run: ${req.params.id}`)
      const command = req.body?.command?.trim()
      if (!command) return httpError(reply, 400, 'Enter a command to run.')
      if (!recorder.repoExists(run.repoPath)) {
        return httpError(reply, 400, `The repository path no longer exists: ${run.repoPath}`)
      }

      const result = await runCommand(run.repoPath, command)
      const event = {
        id: newId('evt'),
        runId: run.id,
        type: isTestCommand(command) ? ('test' as const) : ('shell' as const),
        timestamp: Date.now(),
        label: `${command} → exit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}`,
        command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      }
      await appendEvent(run.id, event)
      bus.publish({ type: 'event', runId: run.id, event })
      return { event }
    },
  )

  // --- Checkpoints ---------------------------------------------------------
  app.get<{ Params: { runId: string; id: string } }>(
    '/api/runs/:runId/checkpoints/:id',
    async (req, reply) => {
      const found = await findCheckpoint(req.params.id, req.params.runId)
      if (!found) return httpError(reply, 404, `Unknown checkpoint: ${req.params.id}`)
      return { checkpoint: found.checkpoint }
    },
  )

  app.post<{ Params: { runId: string; id: string } }>(
    '/api/runs/:runId/checkpoints/:id/restore',
    async (req, reply) => {
      const found = await findCheckpoint(req.params.id, req.params.runId)
      if (!found) return httpError(reply, 404, `Unknown checkpoint: ${req.params.id}`)
      const { run, checkpoint } = found
      if (run.readOnly || !recorder.repoExists(run.repoPath)) {
        return httpError(
          reply,
          400,
          `This trace is read-only: the repository ${run.repoPath} is not available on this machine.`,
        )
      }

      try {
        const result = await recorder.withWatcherSuppressed(run.repoPath, () =>
          restoreCheckpoint({ checkpoint, repoPath: run.repoPath, safetyRunId: run.id }),
        )
        await recorder.recordRestoreEvent(run.id, {
          checkpointId: checkpoint.id,
          safetyCheckpointId: result.safetyCheckpointId,
          message: result.message,
          files: [...result.restoredTracked, ...result.restoredUntracked],
        })
        return result
      } catch (err) {
        if (err instanceof RestoreAbortedError) return httpError(reply, 409, err.message)
        return httpError(reply, 500, `Restore failed: ${(err as Error).message}`)
      }
    },
  )

  app.post<{ Params: { runId: string; id: string }; Body: { title?: string } }>(
    '/api/runs/:runId/checkpoints/:id/fork',
    async (req, reply) => {
      const found = await findCheckpoint(req.params.id, req.params.runId)
      if (!found) return httpError(reply, 404, `Unknown checkpoint: ${req.params.id}`)
      const { run, checkpoint } = found
      if (run.readOnly || !recorder.repoExists(run.repoPath)) {
        return httpError(reply, 400, `This trace is read-only: ${run.repoPath} is not available.`)
      }

      try {
        const result = await recorder.withWatcherSuppressed(run.repoPath, () =>
          restoreCheckpoint({ checkpoint, repoPath: run.repoPath, safetyRunId: run.id }),
        )
        if (recorder.isRecording(run.id)) await recorder.stopRun(run.id)

        const forked = await recorder.startRun({
          repoPath: run.repoPath,
          title: req.body?.title ?? `Fork of ${run.title ?? run.repoName} @ ${checkpoint.id}`,
          parentRunId: run.id,
          forkedFromCheckpointId: checkpoint.id,
        })
        return {
          run: forked,
          safetyCheckpointId: result.safetyCheckpointId,
          fromCheckpointId: checkpoint.id,
        }
      } catch (err) {
        if (err instanceof RestoreAbortedError) return httpError(reply, 409, err.message)
        return httpError(reply, 500, `Fork failed: ${(err as Error).message}`)
      }
    },
  )

  // --- Trace import / export ----------------------------------------------
  app.get<{ Params: { id: string } }>('/api/runs/:id/export', async (req, reply) => {
    try {
      const { filename, buffer } = await exportRun(req.params.id)
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(buffer)
    } catch (err) {
      if (err instanceof TraceError) return httpError(reply, 404, err.message)
      throw err
    }
  })

  app.post('/api/trace/import', async (req, reply) => {
    const file = await req.file()
    if (!file) return httpError(reply, 400, 'No file uploaded.')
    const buffer = await file.toBuffer()
    try {
      const result = await importTrace(buffer)
      bus.publish({ type: 'runs-changed' })
      return result
    } catch (err) {
      if (err instanceof TraceError) return httpError(reply, 400, err.message)
      throw err
    }
  })

  /** Import by absolute path — used by tests and by `curl`-style workflows. */
  app.post<{ Body: { path?: string } }>('/api/trace/import-path', async (req, reply) => {
    const raw = req.body?.path
    if (!raw) return httpError(reply, 400, 'Missing path.')
    const target = normalisePath(raw)
    if (!fsSync.existsSync(target)) return httpError(reply, 404, `No such file: ${target}`)
    try {
      const result = await importTrace(await fs.readFile(target))
      bus.publish({ type: 'runs-changed' })
      return result
    } catch (err) {
      if (err instanceof TraceError) return httpError(reply, 400, err.message)
      throw err
    }
  })

  // --- Live updates --------------------------------------------------------
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const send = (message: StreamMessage) => {
      reply.raw.write(`data: ${JSON.stringify(message)}\n\n`)
    }
    send({ type: 'hello', serverStartedAt: Date.now() })

    const unsubscribe = bus.subscribe(send)
    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)

    req.raw.on('close', () => {
      clearInterval(keepAlive)
      unsubscribe()
    })
  })

  // Marks a run failed — used when the user wants to flag a bad trace.
  app.post<{ Params: { id: string } }>('/api/runs/:id/mark-failed', async (req, reply) => {
    const run = await loadRun(req.params.id)
    if (!run) return httpError(reply, 404, `Unknown run: ${req.params.id}`)
    const updated: Run = { ...run, status: 'failed' }
    await saveRun(updated)
    bus.publish({ type: 'run', run: updated })
    return { run: updated }
  })
}
