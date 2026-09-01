import { useEffect } from 'react'
import { Inspector } from './components/Inspector.js'
import { Onboarding } from './components/Onboarding.js'
import { Sidebar } from './components/Sidebar.js'
import { TopBar } from './components/TopBar.js'
import { useStore } from './store.js'

export function App() {
  const { booted, boot, repo, runs, busy, toasts, dismissToast } = useStore()

  useEffect(() => {
    void boot()
  }, [boot])

  if (!booted) {
    return <div className="splash">Connecting to the local GhostFrame daemon…</div>
  }

  const showOnboarding = !repo && runs.length === 0

  return (
    <div className="app">
      {showOnboarding ? (
        <Onboarding />
      ) : (
        <>
          <TopBar />
          <main className="layout">
            <Sidebar />
            <Inspector />
          </main>
          {!repo && (
            <div className="floating-hint">
              <span>No repository opened — you can browse existing traces, or</span>
              <OpenRepoInline />
            </div>
          )}
        </>
      )}

      {busy && <div className="busy-bar">{busy}</div>}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <pre>{t.message}</pre>
            <button type="button" className="link" onClick={() => dismissToast(t.id)}>
              dismiss
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function OpenRepoInline() {
  const { openRepo, repoBusy, repoError } = useStore()
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        const input = (e.currentTarget.elements.namedItem('path') as HTMLInputElement | null)?.value ?? ''
        if (input.trim()) await openRepo(input)
      }}
    >
      <input name="path" placeholder="/path/to/repo" spellCheck={false} />
      <button type="submit" className="btn btn-xs" disabled={repoBusy}>
        {repoBusy ? 'Opening…' : 'Open Repository'}
      </button>
      {repoError && <span className="fail small">{repoError}</span>}
    </form>
  )
}
