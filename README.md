# GhostFrame

**Time-travel debugging for coding agents.**

See exactly when your AI broke the code.

GhostFrame watches a repository while a coding agent (Claude Code, Codex, Cursor,
Windsurf, your own harness) works in it, records every change as a checkpoint, and
lets you jump back to any point in that history — on disk, for real.

It is **not** an agent, a chat UI, or an IDE. It answers one question:

> *Which step broke my code, what exactly did it change, and how do I get back?*

`No account · No cloud · No telemetry`

---

## The loop

| Step | What it does |
| --- | --- |
| **Record** | Watch a repo while an agent edits it |
| **Inspect** | Every change as a timeline event with metadata |
| **Diff** | Real `git diff`, including untracked files |
| **Checkpoint** | A restorable snapshot after every settled change |
| **Restore** | Put the working tree back, safely |
| **Fork** | Branch a new run from any past checkpoint |

## Quick start

```bash
npm install
npm run build
npm start
```

```
GhostFrame running at:
  http://127.0.0.1:7331
```

For development with hot reload (UI on `:7330`, API on `:7331`):

```bash
npm run dev
```

## Using it

1. **Open Local Repository** — type an absolute path (`~` is expanded). Your browser
   cannot hand a real filesystem path to a web page, so the local daemon resolves and
   validates it. Non-git directories are rejected with a clear message.
2. **Start Recording** — GhostFrame writes a baseline checkpoint and starts watching.
3. **Let your agent work.** Every settled burst of edits becomes a `file_change` event
   plus a checkpoint. Bursts are debounced (~1s) so you get one checkpoint per logical
   change, not one per keystroke.
4. **Click any timeline event** to inspect it: `Detail`, `Diff` (real unified diff) and
   `Raw` (the event JSON).
5. **Run command** in the top bar executes a command in the repo and records its stdout,
   stderr and exit code. Known test runners are tagged as `test` events.
6. **Restore checkpoint** puts the working tree back to that moment.
7. **Fork from here** restores a checkpoint and starts a fresh run from it, so you can
   re-run your agent down a different path.
8. **Export .ghost / Import** moves a whole trace between machines.

## Recording your agent's test runs

Wrap any command so its result lands on the timeline automatically:

```bash
ghostframe exec -- npm test
```

It runs the command exactly as your shell would — same live output, same exit
code — and files the result against whichever run is currently recording this
repo. Known test runners become `test` events, which is what feeds first-bad-change
detection. If the daemon is down or nothing is recording, the command still runs
and still returns its own exit code; you just get a one-line notice.

Point your agent's test command at it and you never have to click `Run` again.

## Safety model

Restore rewrites files. GhostFrame treats losing your work as the one unacceptable
outcome, so:

- A **safety checkpoint** of the current tree is always written *before* a restore.
  It appears on the timeline attached to the restore event, so undoing a restore is
  one click.
- If the safety checkpoint cannot be created, the restore is **cancelled**, not attempted.
- If the restore fails halfway, GhostFrame **rolls the tree back** to the safety
  checkpoint and reports the error. Failures are never silent.
- `git reset --hard` is never used. Only paths that actually differ between the current
  tree and the checkpoint are touched, and **commit history is never rewritten**.
- Restoring also removes untracked files created after the checkpoint — they are in the
  safety checkpoint, so they are recoverable.
- Imported traces whose repository is not present on this machine are **read-only**.

The API is loopback-only, and additionally rejects requests carrying a non-local
`Origin` (a website you visit trying to drive it) or a non-local `Host` (DNS
rebinding). It does **not** try to defend against another process running as you —
that process can already do anything GhostFrame can.

## Where data lives

Everything is on your machine, as plain files:

```
~/.ghostframe/
  config/
  traces/
  runs/
    run_<id>/
      run.json
      events.json
      objects/               # content-addressed bodies, one copy per run
      checkpoints/
        cp_<id>/
          metadata.json
          working.patch        # git diff --binary against the base commit
          untracked/           # hard links into objects/
```

Every checkpoint captures the whole untracked set, and across a long run most of
those bytes repeat. Each `untracked/<path>` is a hard link into the run's object
store, so identical content is stored once — twenty checkpoints of an unchanged
file cost one copy. The layout still reads like plain files, in a `.ghost` archive
too.

Set `GHOSTFRAME_HOME` to relocate it. Other environment variables:
`GHOSTFRAME_PORT` (7331), `GHOSTFRAME_HOST` (127.0.0.1), `GHOSTFRAME_DEBOUNCE_MS` (1000).

A checkpoint is a git patch plus untracked-file copies — not a filesystem or VM
snapshot. That keeps it small, inspectable and reversible.

## First bad change

When a run contains a passing test event followed by a failing one, GhostFrame reports
the checkpoint the regression was introduced after and the first checkpoint observed in
a failing state, and highlights the suspects on the timeline.

This is purely deterministic — no model is involved, and nothing is reported when the
evidence is not there.

## Trace format

`.ghost` files are ZIP archives. See [docs/TRACE_FORMAT.md](docs/TRACE_FORMAT.md).

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Tests run against throwaway git repositories in a temp directory — never against a real
project.

## Layout

```
server/     local daemon: api, git, watcher, checkpoint, trace, storage, core
src/frontend/  React UI
shared/     types shared by both
docs/       trace format
tests/      vitest suite
```

## 中文文档

[README.zh-CN.md](README.zh-CN.md)
