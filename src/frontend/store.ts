import { create } from 'zustand'
import type {
  RegressionAnalysis,
  RepoInfo,
  Run,
  RunDetail,
  RunEvent,
  StreamMessage,
} from '../../shared/types.js'
import { api } from './api.js'

export type InspectorTab = 'detail' | 'diff' | 'raw'

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  message: string
}

interface State {
  booted: boolean
  connected: boolean

  repo: RepoInfo | null
  repoBusy: boolean
  repoError: string | null

  runs: Run[]
  activeRunIds: string[]
  runsLoading: boolean

  selectedRunId: string | null
  detail: RunDetail | null
  detailLoading: boolean
  detailError: string | null

  selectedEventId: string | null
  tab: InspectorTab

  analysis: RegressionAnalysis | null
  busy: string | null
  toasts: Toast[]

  boot: () => Promise<void>
  openRepo: (path: string) => Promise<boolean>
  closeRepo: () => void
  startRecording: () => Promise<void>
  stopRecording: (runId: string) => Promise<void>
  selectRun: (runId: string | null) => Promise<void>
  selectEvent: (eventId: string | null) => void
  setTab: (tab: InspectorTab) => void
  refreshRuns: () => Promise<void>
  refreshDetail: () => Promise<void>
  restore: (checkpointId: string) => Promise<void>
  fork: (checkpointId: string) => Promise<void>
  deleteRun: (runId: string) => Promise<void>
  runCommand: (command: string) => Promise<void>
  importTrace: (file: File) => Promise<void>
  pushToast: (kind: Toast['kind'], message: string) => void
  dismissToast: (id: number) => void
}

let toastSeq = 0
const REPO_KEY = 'ghostframe.lastRepo'

export const useStore = create<State>((set, get) => ({
  booted: false,
  connected: false,

  repo: null,
  repoBusy: false,
  repoError: null,

  runs: [],
  activeRunIds: [],
  runsLoading: false,

  selectedRunId: null,
  detail: null,
  detailLoading: false,
  detailError: null,

  selectedEventId: null,
  tab: 'detail',

  analysis: null,
  busy: null,
  toasts: [],

  pushToast: (kind, message) => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }))
    if (kind !== 'error') {
      setTimeout(() => get().dismissToast(id), 5000)
    }
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  boot: async () => {
    await get().refreshRuns()
    const remembered = localStorage.getItem(REPO_KEY)
    if (remembered) {
      try {
        const { repo } = await api.repoInfo(remembered)
        set({ repo })
      } catch {
        localStorage.removeItem(REPO_KEY)
      }
    }
    connectStream(set, get)
    set({ booted: true })
  },

  openRepo: async (path) => {
    set({ repoBusy: true, repoError: null })
    try {
      const { repo, activeRunId } = await api.openRepo(path)
      localStorage.setItem(REPO_KEY, repo.path)
      set({ repo, repoBusy: false })
      if (activeRunId) await get().selectRun(activeRunId)
      return true
    } catch (err) {
      set({ repoBusy: false, repoError: (err as Error).message })
      return false
    }
  },

  closeRepo: () => {
    localStorage.removeItem(REPO_KEY)
    set({ repo: null, repoError: null })
  },

  startRecording: async () => {
    const repo = get().repo
    if (!repo) return
    set({ busy: 'Starting recording…' })
    try {
      const { run } = await api.startRun(repo.path)
      await get().refreshRuns()
      await get().selectRun(run.id)
      get().pushToast('success', 'Recording started.')
    } catch (err) {
      get().pushToast('error', (err as Error).message)
    } finally {
      set({ busy: null })
    }
  },

  stopRecording: async (runId) => {
    set({ busy: 'Stopping…' })
    try {
      await api.stopRun(runId)
      await get().refreshRuns()
      await get().refreshDetail()
      get().pushToast('info', 'Recording stopped.')
    } catch (err) {
      get().pushToast('error', (err as Error).message)
    } finally {
      set({ busy: null })
    }
  },

  refreshRuns: async () => {
    set({ runsLoading: true })
    try {
      const { runs, activeRunIds } = await api.listRuns()
      set({ runs, activeRunIds, runsLoading: false, connected: true })
    } catch (err) {
      set({ runsLoading: false, connected: false })
      get().pushToast('error', `Cannot reach the GhostFrame daemon: ${(err as Error).message}`)
    }
  },

  selectRun: async (runId) => {
    set({ selectedRunId: runId, selectedEventId: null, detail: null, analysis: null, detailError: null })
    if (!runId) return
    await get().refreshDetail()
  },

  refreshDetail: async () => {
    const runId = get().selectedRunId
    if (!runId) return
    set({ detailLoading: true })
    try {
      const detail = await api.getRun(runId)
      const previous = get().selectedEventId
      const stillThere = detail.events.some((e) => e.id === previous)
      set({
        detail,
        detailLoading: false,
        detailError: null,
        selectedEventId: stillThere ? previous : (detail.events[0]?.id ?? null),
      })
      const analysis = await api.analysis(runId)
      set({ analysis })
    } catch (err) {
      set({ detailLoading: false, detailError: (err as Error).message })
    }
  },

  selectEvent: (eventId) => set({ selectedEventId: eventId }),
  setTab: (tab) => set({ tab }),

  restore: async (checkpointId) => {
    const runId = get().selectedRunId
    if (!runId) return
    set({ busy: 'Restoring workspace…' })
    try {
      const result = await api.restore(runId, checkpointId)
      get().pushToast('success', result.message)
      await get().refreshDetail()
      const repo = get().repo
      if (repo) {
        const { repo: fresh } = await api.repoInfo(repo.path)
        set({ repo: fresh })
      }
    } catch (err) {
      get().pushToast('error', (err as Error).message)
    } finally {
      set({ busy: null })
    }
  },

  fork: async (checkpointId) => {
    const runId = get().selectedRunId
    if (!runId) return
    set({ busy: 'Forking…' })
    try {
      const result = await api.fork(runId, checkpointId)
      await get().refreshRuns()
      await get().selectRun(result.run.id)
      get().pushToast('success', `Fork created from ${result.fromCheckpointId}`)
    } catch (err) {
      get().pushToast('error', (err as Error).message)
    } finally {
      set({ busy: null })
    }
  },

  deleteRun: async (runId) => {
    set({ busy: 'Deleting run…' })
    try {
      await api.deleteRun(runId)
      if (get().selectedRunId === runId) await get().selectRun(null)
      await get().refreshRuns()
      get().pushToast('info', 'Run deleted.')
    } catch (err) {
      get().pushToast('error', (err as Error).message)
    } finally {
      set({ busy: null })
    }
  },

  runCommand: async (command) => {
    const runId = get().selectedRunId
    if (!runId) return
    set({ busy: `Running ${command}…` })
    try {
      const { event } = await api.shell(runId, command)
      await get().refreshDetail()
      set({ selectedEventId: event.id, tab: 'detail' })
      get().pushToast(event.exitCode === 0 ? 'success' : 'error', `${command} exited with ${event.exitCode}`)
    } catch (err) {
      get().pushToast('error', (err as Error).message)
    } finally {
      set({ busy: null })
    }
  },

  importTrace: async (file) => {
    set({ busy: 'Importing trace…' })
    try {
      const result = await api.importTrace(file)
      await get().refreshRuns()
      await get().selectRun(result.run.id)
      get().pushToast(result.readOnly ? 'info' : 'success', result.message)
    } catch (err) {
      get().pushToast('error', (err as Error).message)
    } finally {
      set({ busy: null })
    }
  },
}))

type Setter = (partial: Partial<State> | ((s: State) => Partial<State>)) => void

function connectStream(set: Setter, get: () => State): void {
  const source = new EventSource('/api/stream')

  source.onopen = () => set({ connected: true })
  source.onerror = () => set({ connected: false })
  source.onmessage = (raw) => {
    let message: StreamMessage
    try {
      message = JSON.parse(String(raw.data)) as StreamMessage
    } catch {
      return
    }
    if (message.type === 'hello') {
      set({ connected: true })
      return
    }
    if (message.type === 'runs-changed') {
      void get().refreshRuns()
      return
    }
    if (message.type === 'run') {
      set((s) => ({ runs: s.runs.map((r) => (r.id === message.run.id ? message.run : r)) }))
      if (get().selectedRunId === message.run.id) {
        set((s) => ({ detail: s.detail ? { ...s.detail, run: message.run } : s.detail }))
      }
      return
    }
    if (message.type === 'event') {
      appendEvent(set, get, message.runId, message.event)
    }
  }
}

function appendEvent(set: Setter, get: () => State, runId: string, event: RunEvent): void {
  if (get().selectedRunId !== runId) return
  const detail = get().detail
  if (!detail) return
  if (detail.events.some((e) => e.id === event.id)) return

  const events = [...detail.events, event]
  set({ detail: { ...detail, events } })
  // A new checkpoint needs its metadata pulled in so Restore stays available.
  if (event.type === 'checkpoint' || event.type === 'restore') {
    void get().refreshDetail()
  }
  if (!get().selectedEventId) set({ selectedEventId: event.id })
}
