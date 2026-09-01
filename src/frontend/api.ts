import type {
  Checkpoint,
  RegressionAnalysis,
  RepoInfo,
  RestoreResult,
  Run,
  RunDetail,
  RunEvent,
} from '../../shared/types.js'

export class ApiError extends Error {}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON content-type when we actually send a JSON body —
  // Fastify rejects an empty body that claims to be JSON.
  const isJsonBody = typeof init?.body === 'string'
  const res = await fetch(url, {
    ...init,
    headers: isJsonBody ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
  })
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = { error: text }
    }
  }
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String(body.error)
        : `Request failed with ${res.status}`
    throw new ApiError(message)
  }
  return body as T
}

export const api = {
  health: () => request<{ ok: boolean; version: string }>('/api/health'),

  openRepo: (repoPath: string) =>
    request<{ repo: RepoInfo; activeRunId: string | null }>('/api/repo/open', {
      method: 'POST',
      body: JSON.stringify({ path: repoPath }),
    }),

  repoInfo: (repoPath: string) =>
    request<{ repo: RepoInfo; activeRunId: string | null }>(`/api/repo/info?path=${encodeURIComponent(repoPath)}`),

  listRuns: () => request<{ runs: Run[]; activeRunIds: string[] }>('/api/runs'),

  startRun: (repoPath: string, title?: string) =>
    request<{ run: Run }>('/api/runs', { method: 'POST', body: JSON.stringify({ repoPath, title }) }),

  stopRun: (runId: string) => request<{ run: Run }>(`/api/runs/${runId}/stop`, { method: 'POST' }),

  getRun: (runId: string) => request<RunDetail>(`/api/runs/${runId}`),

  deleteRun: (runId: string) => request<{ ok: boolean }>(`/api/runs/${runId}`, { method: 'DELETE' }),

  analysis: (runId: string) => request<RegressionAnalysis>(`/api/runs/${runId}/analysis`),

  shell: (runId: string, command: string) =>
    request<{ event: RunEvent }>(`/api/runs/${runId}/shell`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    }),

  checkpoint: (runId: string, checkpointId: string) =>
    request<{ checkpoint: Checkpoint }>(`/api/runs/${runId}/checkpoints/${checkpointId}`),

  restore: (runId: string, checkpointId: string) =>
    request<RestoreResult>(`/api/runs/${runId}/checkpoints/${checkpointId}/restore`, { method: 'POST' }),

  fork: (runId: string, checkpointId: string) =>
    request<{ run: Run; safetyCheckpointId?: string; fromCheckpointId: string }>(
      `/api/runs/${runId}/checkpoints/${checkpointId}/fork`,
      { method: 'POST' },
    ),

  importTrace: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<{ run: Run; readOnly: boolean; message: string }>('/api/trace/import', {
      method: 'POST',
      body: form,
    })
  },

  exportUrl: (runId: string) => `/api/runs/${runId}/export`,
}
