import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../shared/types.js'
import { analyseRegression } from '../server/core/analysis.js'

let t = 0
const at = () => (t += 1000)

function checkpoint(id: string): RunEvent {
  return { id: `evt_${id}`, runId: 'run_x', type: 'checkpoint', timestamp: at(), label: id, checkpointId: id }
}
function test(exitCode: number): RunEvent {
  return {
    id: `evt_test_${at()}`,
    runId: 'run_x',
    type: 'test',
    timestamp: t,
    label: 'npm test',
    command: 'npm test',
    exitCode,
  }
}

describe('first bad change detection', () => {
  it('says nothing when no tests have run', () => {
    const result = analyseRegression([checkpoint('cp_1')])
    expect(result.firstBadCheckpointId).toBeUndefined()
    expect(result.summary).toContain('No test results recorded')
  })

  it('reports no regression when every run passed', () => {
    t = 0
    const result = analyseRegression([checkpoint('cp_1'), test(0), checkpoint('cp_2'), test(0)])
    expect(result.summary).toContain('No regression observed')
  })

  it('locates the checkpoint after which tests started failing', () => {
    t = 0
    const events = [checkpoint('cp_1'), test(0), checkpoint('cp_2'), checkpoint('cp_3'), test(1)]
    const result = analyseRegression(events)
    expect(result.lastGoodCheckpointId).toBe('cp_1')
    expect(result.firstBadCheckpointId).toBe('cp_3')
    expect(result.suspects).toEqual(['cp_2', 'cp_3'])
    expect(result.summary).toContain('Possible regression introduced after checkpoint cp_1')
  })

  it('handles a run that only ever failed', () => {
    t = 0
    const result = analyseRegression([checkpoint('cp_1'), test(1)])
    expect(result.firstBadCheckpointId).toBe('cp_1')
    expect(result.summary).toContain('only ever been observed failing')
  })
})
