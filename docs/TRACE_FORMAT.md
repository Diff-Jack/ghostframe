# The `.ghost` trace format

Version **1**.

A `.ghost` file is a plain ZIP archive containing one run: its metadata, its timeline,
and every checkpoint it captured. It is designed to be readable with `unzip` and
diffable in review — no binary container, no database.

## Archive layout

```
run.ghost
├── manifest.json
├── metadata.json
├── events.json
└── checkpoints/
    └── cp_<id>/
        ├── metadata.json
        ├── working.patch
        └── untracked/
            └── <repo-relative path>
```

The on-disk layout under `~/.ghostframe/runs/<runId>/` is identical apart from the
manifest, so exporting is a straight copy.

## `manifest.json`

```json
{
  "format": "ghostframe",
  "version": 1,
  "runId": "run_85c7f9cf17a1",
  "repoName": "demo-repo",
  "repoPath": "/Users/you/projects/demo-repo",
  "branch": "main",
  "headCommit": "778c03931164b47c41fc8793f843a9a52eef8a44",
  "createdAt": 1788288618393
}
```

Import rejects anything whose `format` is not `ghostframe` or whose `version` is greater
than the version this build understands.

## `metadata.json` — the run

```ts
interface Run {
  id: string
  repoPath: string
  repoName: string
  branch: string
  headCommit: string
  startedAt: number            // epoch ms
  endedAt?: number
  status: 'recording' | 'completed' | 'failed'
  title?: string
  parentRunId?: string             // set on forks
  forkedFromCheckpointId?: string  // set on forks
  imported?: boolean
  readOnly?: boolean
}
```

`imported` and `readOnly` are assigned by the importer, not by the exporter. A run is
imported under a **new id**, so re-importing never overwrites a local run.

## `events.json` — the timeline

An array of events, ordered by `timestamp`.

```ts
type EventType =
  | 'run_start'
  | 'file_change'
  | 'checkpoint'
  | 'shell'
  | 'test'
  | 'error'
  | 'restore'
  | 'run_end'

interface RunEvent {
  id: string
  runId: string
  type: EventType
  timestamp: number
  label: string                // one-line timeline text
  files?: string[]             // repo-relative
  changes?: { path: string; kind: 'add' | 'change' | 'unlink' }[]
  diff?: string                // real unified git diff
  checkpointId?: string
  gitHead?: string
  branch?: string

  // shell / test
  command?: string
  stdout?: string
  stderr?: string
  exitCode?: number
  durationMs?: number

  // error / restore
  message?: string
  restoredFromCheckpointId?: string
  safetyCheckpointId?: string
}
```

A settled burst of edits produces a `file_change` event immediately followed by a
`checkpoint` event referencing the same checkpoint.

`restore` is emitted after GhostFrame rewrites the working tree. Its `checkpointId`
points at the **safety backup**, which is what makes a restore undoable from the UI.

## `checkpoints/cp_<id>/metadata.json`

```ts
interface CheckpointMetadata {
  id: string
  runId: string
  eventId: string
  timestamp: number
  gitHead: string       // base commit the patch applies to; '' if the repo has no commits
  branch: string
  untrackedFiles: { path: string; contentPath: string; mode?: number; sha256?: string }[]
  safety?: boolean      // written automatically before a restore
  label?: string
}
```

`trackedPatch` is **not** in this file — it lives in `working.patch` beside it, and is
merged back in when the checkpoint is loaded.

## `working.patch`

The output of:

```
git diff --binary --no-color --no-ext-diff <gitHead>
```

This covers staged and unstaged changes to tracked files, including deletions and
binary files. It is empty when the tree matches the base commit, or when the repository
has no commits yet.

## `untracked/`

Verbatim copies of every untracked, non-ignored file at capture time (`git ls-files
--others --exclude-standard`), stored under their repo-relative path. `contentPath` in
the metadata is relative to the checkpoint directory and always uses `/` separators.
`sha256` is the content hash (optional, added within v1): on local disk it lets one
run store identical bodies once, and readers may use it to verify integrity or
ignore it entirely.

Capture refuses to proceed beyond 2000 untracked files or 64 MB rather than silently
truncating — the fix is to gitignore build output.

## Restoring from a trace

To reconstruct the workspace a checkpoint recorded:

1. Verify `gitHead` exists in the target repository. If not, stop.
2. For every path in the patch, and every tracked path currently differing from
   `gitHead`: restore it from `gitHead`, or delete it if it does not exist there.
3. Apply `working.patch`.
4. Delete untracked files not listed in `untrackedFiles`.
5. Write every file in `untrackedFiles` from `untracked/`.

GhostFrame writes a safety checkpoint before step 2 and rolls back to it if any step
fails. Commit history is never rewritten and `git reset --hard` is never used.

## Compatibility

Readers should ignore unknown fields and unknown event types rather than failing.
Any change that makes existing archives unreadable requires bumping `version`.

---

[中文版](TRACE_FORMAT.zh-CN.md)
