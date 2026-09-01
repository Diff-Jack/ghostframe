import { useState } from 'react'
import { api } from '../api.js'
import { useStore } from '../store.js'
import { Modal } from './Modal.js'

export function TopBar() {
  const {
    repo,
    closeRepo,
    runs,
    activeRunIds,
    selectedRunId,
    startRecording,
    stopRecording,
    deleteRun,
    runCommand,
    busy,
    connected,
  } = useStore()

  const [command, setCommand] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null
  const recordingRunId = repo ? (activeRunIds.find((id) => runs.find((r) => r.id === id)?.repoPath === repo.path) ?? null) : null
  const canRunCommand = !!selectedRun && !selectedRun.readOnly

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="brand-mark small" aria-hidden="true" />
        <span className="brand-name">GhostFrame</span>
        {repo ? (
          <div className="repo-chip">
            <strong>{repo.name}</strong>
            <span className="mono">{repo.branch}</span>
            <span className="mono">{repo.headCommitShort || 'no commits'}</span>
            <span className={repo.status === 'clean' ? 'ok' : 'warn'}>{repo.status}</span>
            <button type="button" className="link" onClick={closeRepo} title={repo.path}>
              change
            </button>
          </div>
        ) : (
          <span className="muted">No repository opened.</span>
        )}
      </div>

      <div className="topbar-right">
        {selectedRun && (
          <form
            className="cmd-form"
            onSubmit={async (e) => {
              e.preventDefault()
              const c = command.trim()
              if (!c) return
              await runCommand(c)
              setCommand('')
            }}
          >
            <input
              spellCheck={false}
              placeholder="Run command (e.g. npm test)"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              disabled={!canRunCommand || !!busy}
              title={canRunCommand ? undefined : 'This trace is read-only.'}
            />
            <button type="submit" className="btn btn-xs" disabled={!canRunCommand || !!busy || !command.trim()}>
              Run
            </button>
          </form>
        )}

        {selectedRun && (
          <a className="btn btn-xs" href={api.exportUrl(selectedRun.id)} download>
            Export .ghost
          </a>
        )}

        {selectedRun && !activeRunIds.includes(selectedRun.id) && (
          <button type="button" className="btn btn-xs" disabled={!!busy} onClick={() => setConfirmDelete(true)}>
            Delete run
          </button>
        )}

        {repo &&
          (recordingRunId ? (
            <button
              type="button"
              className="btn btn-danger"
              disabled={!!busy}
              onClick={() => void stopRecording(recordingRunId)}
            >
              <span className="dot-rec" /> Stop Recording
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void startRecording()}>
              Start Recording
            </button>
          ))}

        <span className={`conn ${connected ? 'ok' : 'fail'}`} title={connected ? 'Connected to local daemon' : 'Daemon unreachable'}>
          {connected ? 'local' : 'offline'}
        </span>
      </div>

      {confirmDelete && selectedRun && (
        <Modal
          title="Delete this run?"
          confirmLabel="Delete"
          confirmKind="danger"
          busy={!!busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            setConfirmDelete(false)
            await deleteRun(selectedRun.id)
          }}
        >
          <p>The trace and all of its checkpoints will be removed from disk.</p>
          <p>Your repository is not touched.</p>
          <p className="mono small">{selectedRun.id}</p>
        </Modal>
      )}
    </header>
  )
}
