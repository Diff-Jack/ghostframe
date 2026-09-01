import { useMemo } from 'react'
import type { RunEvent } from '../../../shared/types.js'
import { useStore } from '../store.js'

const ICONS: Record<RunEvent['type'], string> = {
  run_start: '▶',
  prompt: '💬',
  agent_tool: '⚙',
  file_change: '✎',
  checkpoint: '◆',
  shell: '$',
  test: '⏱',
  error: '!',
  restore: '↺',
  run_end: '■',
}

function offset(startedAt: number, timestamp: number): string {
  const total = Math.max(0, Math.round((timestamp - startedAt) / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function Timeline() {
  const { detail, detailLoading, detailError, selectedEventId, selectEvent, analysis } = useStore()

  const events = useMemo(
    () => [...(detail?.events ?? [])].sort((a, b) => a.timestamp - b.timestamp),
    [detail],
  )

  if (!detail) {
    return (
      <section className="panel timeline-panel">
        <header className="panel-head">
          <h2>Timeline</h2>
        </header>
        <div className="empty">{detailLoading ? 'Loading…' : 'Select a run to see its timeline.'}</div>
      </section>
    )
  }

  const suspects = new Set(analysis?.suspects ?? [])
  // A turn is only worth drawing as a group once its prompt has arrived.
  const turnsWithPrompt = new Set(
    events.filter((e) => e.type === 'prompt' && e.turnId).map((e) => e.turnId!),
  )

  return (
    <section className="panel timeline-panel">
      <header className="panel-head">
        <h2>Timeline</h2>
        <span className="count">{events.length}</span>
      </header>

      {detailError && <div className="alert alert-error">{detailError}</div>}

      {events.length === 0 && !detailError && (
        <div className="empty">Waiting for workspace changes…</div>
      )}

      <ol className="timeline">
        {events.map((event) => {
          const inTurn = !!event.turnId && turnsWithPrompt.has(event.turnId) && event.type !== 'prompt'
          const flagged = event.checkpointId ? suspects.has(event.checkpointId) : false
          const bad = analysis?.firstBadCheckpointId && event.checkpointId === analysis.firstBadCheckpointId
          return (
            <li key={event.id}>
              <button
                type="button"
                className={`tl-item tl-${event.type} ${selectedEventId === event.id ? 'is-selected' : ''} ${
                  flagged ? 'is-suspect' : ''
                } ${bad ? 'is-bad' : ''} ${inTurn ? 'is-in-turn' : ''}`}
                onClick={() => selectEvent(event.id)}
              >
                <span className="tl-time">{offset(detail.run.startedAt, event.timestamp)}</span>
                <span className="tl-icon" aria-hidden="true">
                  {ICONS[event.type] ?? '•'}
                </span>
                <span className="tl-body">
                  <span className="tl-label">{event.label}</span>
                  {event.files && event.files.length > 1 && (
                    <span className="tl-files">
                      {event.files.slice(0, 4).map((f) => (
                        <span key={f}>{f}</span>
                      ))}
                      {event.files.length > 4 && <span>+{event.files.length - 4} more</span>}
                    </span>
                  )}
                  {typeof event.exitCode === 'number' && (
                    <span className={`tl-exit ${event.exitCode === 0 ? 'ok' : 'fail'}`}>
                      exit {event.exitCode}
                    </span>
                  )}
                  {event.sensitivePaths && event.sensitivePaths.length > 0 && (
                    <span className="tl-flag" title={event.sensitivePaths.join(', ')}>
                      ⚠ credentials: {event.sensitivePaths.join(', ')}
                    </span>
                  )}
                  {event.hosts && event.hosts.length > 0 && (
                    <span className="tl-flag" title={event.hosts.join(', ')}>
                      ⚠ network: {event.hosts.join(', ')}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
