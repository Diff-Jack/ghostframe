import { useRef } from 'react'
import type { Run } from '../../../shared/types.js'
import { useStore } from '../store.js'
import { Timeline } from './Timeline.js'

function runLabel(run: Run): string {
  if (run.title) return run.title
  return `Run ${new Date(run.startedAt).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })}`
}

export function formatDuration(run: Run): string {
  const end = run.endedAt ?? Date.now()
  const seconds = Math.max(0, Math.round((end - run.startedAt) / 1000))
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export function Sidebar() {
  const {
    runs,
    runsLoading,
    activeRunIds,
    selectedRunId,
    selectRun,
    importTrace,
    busy,
  } = useStore()
  const fileInput = useRef<HTMLInputElement>(null)

  return (
    <aside className="sidebar">
      <section className="panel runs-panel">
        <header className="panel-head">
          <h2>Recent Runs</h2>
          <button
            type="button"
            className="btn btn-xs"
            disabled={!!busy}
            onClick={() => fileInput.current?.click()}
            title="Import a .ghost trace"
          >
            Import
          </button>
        </header>

        {runsLoading && runs.length === 0 && <div className="empty">Loading runs…</div>}
        {!runsLoading && runs.length === 0 && (
          <div className="empty">
            No runs yet.
            <br />
            Start recording to create your first trace.
          </div>
        )}

        <ul className="run-list">
          {runs.map((run) => (
            <li key={run.id}>
              <button
                type="button"
                className={`run-item ${selectedRunId === run.id ? 'is-selected' : ''}`}
                onClick={() => void selectRun(run.id)}
              >
                <span className="run-title">{runLabel(run)}</span>
                <span className="run-meta">
                  {activeRunIds.includes(run.id) && <span className="dot-rec" aria-label="recording" />}
                  <span>{formatDuration(run)}</span>
                  <span className="run-repo">{run.repoName}</span>
                </span>
                <span className="run-tags">
                  {run.imported && <span className="tag">imported</span>}
                  {run.readOnly && <span className="tag tag-warn">read-only</span>}
                  {run.parentRunId && <span className="tag">fork</span>}
                  {run.status === 'failed' && <span className="tag tag-warn">failed</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <Timeline />

      <input
        ref={fileInput}
        type="file"
        accept=".ghost,.zip"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) await importTrace(file)
        }}
      />
    </aside>
  )
}
