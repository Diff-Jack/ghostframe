import { useRef, useState } from 'react'
import { useStore } from '../store.js'

export function Onboarding() {
  const { openRepo, repoBusy, repoError, importTrace, busy } = useStore()
  const [path, setPath] = useState('')
  const [showPathInput, setShowPathInput] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!path.trim()) return
    await openRepo(path)
  }

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <h1>GhostFrame</h1>
        </div>
        <p className="tagline">Time-travel debugging for coding agents.</p>
        <p className="subtagline">See exactly when your AI broke the code.</p>

        {!showPathInput ? (
          <div className="onboarding-actions">
            <button type="button" className="btn btn-primary btn-lg" onClick={() => setShowPathInput(true)}>
              Open Local Repository
            </button>
            <button
              type="button"
              className="btn btn-lg"
              disabled={!!busy}
              onClick={() => fileInput.current?.click()}
            >
              Import .ghost Trace
            </button>
          </div>
        ) : (
          <form className="path-form" onSubmit={submit}>
            <label htmlFor="repo-path">Enter repository path</label>
            <input
              id="repo-path"
              autoFocus
              spellCheck={false}
              placeholder="/Users/you/projects/my-app"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
            <div className="onboarding-actions">
              <button type="submit" className="btn btn-primary" disabled={repoBusy || !path.trim()}>
                {repoBusy ? 'Opening…' : 'Open Repository'}
              </button>
              <button type="button" className="btn" onClick={() => setShowPathInput(false)} disabled={repoBusy}>
                Back
              </button>
            </div>
            <p className="hint">
              Your browser cannot hand GhostFrame a real filesystem path, so the local daemon resolves it for you.
              <code>~</code> is expanded.
            </p>
          </form>
        )}

        {repoError && <div className="alert alert-error">{repoError}</div>}

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

        <p className="footnote">No account · No cloud · No telemetry</p>
      </div>
    </div>
  )
}
