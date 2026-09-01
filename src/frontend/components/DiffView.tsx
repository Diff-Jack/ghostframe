import { useMemo } from 'react'

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'
  text: string
}

interface DiffFile {
  header: string
  lines: DiffLine[]
  additions: number
  deletions: number
}

/** Splits real `git diff` output into per-file blocks for rendering. */
function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | null = null

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw)
      const name = m ? (m[2] === '/dev/null' ? m[1] : m[2]) : raw.slice('diff --git '.length)
      current = { header: name, lines: [], additions: 0, deletions: 0 }
      files.push(current)
      continue
    }
    if (!current) {
      // `git diff --no-index` output for untracked files starts at `--- /dev/null`.
      if (raw.startsWith('--- ') || raw.startsWith('+++ ')) {
        current = { header: raw.replace(/^\+\+\+ b?\//, '').trim(), lines: [], additions: 0, deletions: 0 }
        files.push(current)
      }
      continue
    }
    if (raw.startsWith('@@')) {
      current.lines.push({ kind: 'hunk', text: raw })
    } else if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity ') || raw.startsWith('rename ') || raw.startsWith('old mode') || raw.startsWith('new mode') || raw.startsWith('GIT binary patch') || raw.startsWith('Binary files')) {
      current.lines.push({ kind: 'meta', text: raw })
    } else if (raw.startsWith('+')) {
      current.additions++
      current.lines.push({ kind: 'add', text: raw })
    } else if (raw.startsWith('-')) {
      current.deletions++
      current.lines.push({ kind: 'del', text: raw })
    } else if (raw.length > 0 || current.lines.length > 0) {
      current.lines.push({ kind: 'ctx', text: raw })
    }
  }

  return files.filter((f) => f.lines.length > 0)
}

export function DiffView({ diff }: { diff: string }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff])

  if (files.length === 0) {
    return <div className="empty">This event recorded an empty diff.</div>
  }

  return (
    <div className="diff">
      {files.map((file, i) => (
        <div className="diff-file" key={`${file.header}-${i}`}>
          <div className="diff-file-head">
            <span className="diff-file-name">{file.header}</span>
            <span className="diff-stat">
              <span className="add">+{file.additions}</span>
              <span className="del">−{file.deletions}</span>
            </span>
          </div>
          <pre className="diff-body">
            {file.lines.map((line, j) => (
              <div className={`dl dl-${line.kind}`} key={j}>
                {line.text || ' '}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  )
}
