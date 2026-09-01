import type { RegressionAnalysis, RunEvent } from '../../shared/types.js'

/**
 * Deterministic "first bad change" detection — no model involved.
 *
 * Looks for the earliest transition from a passing test event to a failing one
 * and reports the checkpoints recorded between them as the suspects. If the
 * timeline never contains both a pass and a later fail, we say so rather than
 * guessing.
 */
export function analyseRegression(events: RunEvent[]): RegressionAnalysis {
  const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp)

  let lastPassIndex = -1
  let firstFailIndex = -1
  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i]
    if (e.type !== 'test' || typeof e.exitCode !== 'number') continue
    if (e.exitCode === 0) {
      if (firstFailIndex === -1) lastPassIndex = i
    } else if (lastPassIndex !== -1 && firstFailIndex === -1) {
      firstFailIndex = i
    }
  }

  const anyTest = ordered.some((e) => e.type === 'test' && typeof e.exitCode === 'number')
  if (!anyTest) {
    return {
      suspects: [],
      summary: 'No test results recorded yet. Run a test command to let GhostFrame locate the first failing state.',
    }
  }

  if (firstFailIndex === -1) {
    const failedWithoutPass = ordered.find((e) => e.type === 'test' && (e.exitCode ?? 0) !== 0)
    if (failedWithoutPass) {
      return {
        firstBadCheckpointId: nearestCheckpointBefore(ordered, ordered.indexOf(failedWithoutPass)),
        suspects: [],
        summary:
          'Tests have only ever been observed failing in this run. GhostFrame has no passing state to compare against.',
      }
    }
    return { suspects: [], summary: 'All recorded test runs passed. No regression observed.' }
  }

  const lastGoodCheckpointId = nearestCheckpointBefore(ordered, lastPassIndex)
  const firstBadCheckpointId = nearestCheckpointBefore(ordered, firstFailIndex)

  const suspects: string[] = []
  for (let i = lastPassIndex + 1; i <= firstFailIndex; i++) {
    const e = ordered[i]
    if (e.type === 'checkpoint' && e.checkpointId) suspects.push(e.checkpointId)
  }

  const summary = lastGoodCheckpointId
    ? `Possible regression introduced after checkpoint ${lastGoodCheckpointId}. First observed failing state: ${firstBadCheckpointId ?? 'unknown'}.`
    : `First observed failing state: ${firstBadCheckpointId ?? 'unknown'}.`

  return { lastGoodCheckpointId, firstBadCheckpointId, suspects, summary }
}

/** Checkpoint in effect at (or immediately before) a given event index. */
function nearestCheckpointBefore(ordered: RunEvent[], index: number): string | undefined {
  for (let i = index; i >= 0; i--) {
    const e = ordered[i]
    if (e.type === 'checkpoint' && e.checkpointId) return e.checkpointId
    if (e.checkpointId) return e.checkpointId
  }
  return undefined
}
