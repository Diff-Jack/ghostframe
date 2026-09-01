import { useState } from 'react'
import type { Checkpoint, RunEvent } from '../../../shared/types.js'
import { useStore } from '../store.js'
import { DiffView } from './DiffView.js'
import { Modal } from './Modal.js'

function timeString(ts: number): string {
  return new Date(ts).toLocaleString()
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{value}</dd>
    </div>
  )
}

function CheckpointActions({ checkpoint }: { checkpoint: Checkpoint }) {
  const { restore, fork, busy, detail } = useStore()
  const [pending, setPending] = useState<'restore' | 'fork' | null>(null)
  const readOnly = detail?.run.readOnly

  return (
    <>
      <div className="cp-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!!busy || readOnly}
          onClick={() => setPending('restore')}
          title={readOnly ? 'The repository for this trace is not available on this machine.' : undefined}
        >
          Restore checkpoint
        </button>
        <button
          type="button"
          className="btn"
          disabled={!!busy || readOnly}
          onClick={() => setPending('fork')}
          title={readOnly ? 'The repository for this trace is not available on this machine.' : undefined}
        >
          Fork from here
        </button>
      </div>
      {readOnly && (
        <p className="hint">
          This trace was imported and its repository is not available here, so the workspace cannot be modified.
        </p>
      )}

      {pending === 'restore' && (
        <Modal
          title="Restore workspace?"
          confirmLabel="Restore"
          confirmKind="danger"
          busy={!!busy}
          onCancel={() => setPending(null)}
          onConfirm={async () => {
            setPending(null)
            await restore(checkpoint.id)
          }}
        >
          <p>This will modify your current working tree.</p>
          <p>Your current workspace state will be backed up before restoring.</p>
          <p className="mono small">
            {checkpoint.id} · {timeString(checkpoint.timestamp)}
          </p>
        </Modal>
      )}

      {pending === 'fork' && (
        <Modal
          title="Fork from this checkpoint?"
          confirmLabel="Fork"
          busy={!!busy}
          onCancel={() => setPending(null)}
          onConfirm={async () => {
            setPending(null)
            await fork(checkpoint.id)
          }}
        >
          <p>GhostFrame will back up your current workspace, restore this checkpoint, and start a new run from it.</p>
          <p>Re-run your coding agent afterwards to explore a different branch of history.</p>
          <p className="mono small">{checkpoint.id}</p>
        </Modal>
      )}
    </>
  )
}

function DetailTab({ event, checkpoint }: { event: RunEvent; checkpoint: Checkpoint | null }) {
  const detail = useStore((s) => s.detail)
  return (
    <div className="tab-body">
      <dl className="kv-list">
        <Row label="Type" value={event.type} />
        <Row label="Time" value={timeString(event.timestamp)} />
        {event.files && event.files.length > 0 && (
          <Row
            label="Files changed"
            value={
              <ul className="file-list">
                {event.files.map((f) => (
                  <li key={f} className="mono">
                    {f}
                  </li>
                ))}
              </ul>
            }
          />
        )}
        {event.prompt && (
          <Row label="Prompt" value={<pre className="prompt-text">{event.prompt}</pre>} />
        )}
        {event.agent && <Row label="Agent" value={event.agent} />}
        {event.toolName && <Row label="Tool" value={event.toolName} mono />}
        {event.turnId && <Row label="Turn" value={event.turnId} mono />}
        {event.sensitivePaths && event.sensitivePaths.length > 0 && (
          <Row
            label="Credentials touched"
            value={
              <ul className="file-list warn">
                {event.sensitivePaths.map((p) => (
                  <li key={p} className="mono">
                    {p}
                  </li>
                ))}
              </ul>
            }
          />
        )}
        {event.hosts && event.hosts.length > 0 && (
          <Row
            label="Remote hosts"
            value={
              <ul className="file-list warn">
                {event.hosts.map((h) => (
                  <li key={h} className="mono">
                    {h}
                  </li>
                ))}
              </ul>
            }
          />
        )}
        {event.checkpointId && <Row label="Checkpoint ID" value={event.checkpointId} mono />}
        {event.restoredFromCheckpointId && (
          <Row label="Restored from" value={event.restoredFromCheckpointId} mono />
        )}
        {event.safetyCheckpointId && <Row label="Safety backup" value={event.safetyCheckpointId} mono />}
        <Row label="Git HEAD" value={event.gitHead ?? checkpoint?.gitHead ?? detail?.run.headCommit ?? '—'} mono />
        <Row label="Branch" value={event.branch ?? checkpoint?.branch ?? detail?.run.branch ?? '—'} />
        {event.command && <Row label="Command" value={event.command} mono />}
        {typeof event.exitCode === 'number' && (
          <Row
            label="Exit code"
            value={<span className={event.exitCode === 0 ? 'ok' : 'fail'}>{event.exitCode}</span>}
          />
        )}
        {typeof event.durationMs === 'number' && <Row label="Duration" value={`${event.durationMs} ms`} />}
        {event.message && <Row label="Message" value={event.message} />}
      </dl>

      {(event.stdout || event.stderr) && (
        <div className="output">
          {event.stdout && (
            <>
              <h4>stdout</h4>
              <pre>{event.stdout || '(empty)'}</pre>
            </>
          )}
          {event.stderr && (
            <>
              <h4>stderr</h4>
              <pre className="stderr">{event.stderr}</pre>
            </>
          )}
        </div>
      )}

      {checkpoint ? (
        <div className="cp-block">
          <h4>Checkpoint {checkpoint.id}</h4>
          <dl className="kv-list">
            <Row label="Captured" value={timeString(checkpoint.timestamp)} />
            <Row label="Base commit" value={checkpoint.gitHead ? checkpoint.gitHead.slice(0, 12) : '(no commits)'} mono />
            <Row label="Patch size" value={`${checkpoint.trackedPatch.length} bytes`} />
            <Row label="Untracked files" value={String(checkpoint.untrackedFiles.length)} />
            {checkpoint.safety && <Row label="Kind" value="Safety backup" />}
          </dl>
          <CheckpointActions checkpoint={checkpoint} />
        </div>
      ) : (
        event.type === 'checkpoint' && (
          <div className="alert alert-error">
            The checkpoint data for this event is missing from disk. Restore is unavailable.
          </div>
        )
      )}
    </div>
  )
}

export function Inspector() {
  const { detail, selectedEventId, tab, setTab, analysis } = useStore()

  if (!detail) {
    return (
      <section className="inspector">
        <div className="empty big">No run selected.</div>
      </section>
    )
  }

  const event = detail.events.find((e) => e.id === selectedEventId) ?? null
  const checkpoint = event?.checkpointId
    ? (detail.checkpoints.find((c) => c.id === event.checkpointId) ?? null)
    : null

  return (
    <section className="inspector">
      {analysis && (analysis.firstBadCheckpointId || analysis.lastGoodCheckpointId) && (
        <div className="alert alert-warn">
          <strong>First bad change</strong>
          <span>{analysis.summary}</span>
        </div>
      )}

      {!event ? (
        <div className="empty big">Select an event on the timeline to inspect it.</div>
      ) : (
        <>
          <header className="inspector-head">
            <div>
              <h2>{event.label}</h2>
              <p className="mono small">{event.id}</p>
            </div>
            <nav className="tabs">
              {(['detail', 'diff', 'raw'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`tab ${tab === t ? 'is-active' : ''}`}
                  onClick={() => setTab(t)}
                >
                  {t === 'detail' ? 'Detail' : t === 'diff' ? 'Diff' : 'Raw'}
                </button>
              ))}
            </nav>
          </header>

          {tab === 'detail' && <DetailTab event={event} checkpoint={checkpoint} />}

          {tab === 'diff' && (
            <div className="tab-body">
              {event.diff && event.diff.trim() ? (
                <DiffView diff={event.diff} />
              ) : (
                <div className="empty">No diff available for this event.</div>
              )}
            </div>
          )}

          {tab === 'raw' && <RawTab event={event} />}
        </>
      )}
    </section>
  )
}

function RawTab({ event }: { event: RunEvent }) {
  const [copied, setCopied] = useState(false)
  const json = JSON.stringify(event, null, 2)
  return (
    <div className="tab-body">
      <div className="raw-head">
        <button
          type="button"
          className="btn btn-xs"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(json)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            } catch {
              setCopied(false)
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="raw">{json}</pre>
    </div>
  )
}
