# `.ghost` Trace 格式

版本 **1**。

`.ghost` 文件就是一个普通 ZIP 归档，里面装着一条完整的 run：元数据、timeline、
以及它记录的全部 checkpoint。设计目标是可以直接 `unzip` 查看、可以在 review 里读懂 ——
不用二进制容器，也不用数据库。

## 归档结构

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
            └── <相对仓库根目录的路径>
```

本地磁盘上 `~/.ghostframe/runs/<runId>/` 的结构除了没有 manifest 之外完全一致，
所以导出基本上就是一次目录拷贝。

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

导入时会校验：`format` 必须是 `ghostframe`，`version` 不能高于当前构建支持的版本。

## `metadata.json` —— run 本身

```ts
interface Run {
  id: string
  repoPath: string
  repoName: string
  branch: string
  headCommit: string
  startedAt: number            // epoch 毫秒
  endedAt?: number
  status: 'recording' | 'completed' | 'failed'
  title?: string
  parentRunId?: string             // fork 时设置
  forkedFromCheckpointId?: string  // fork 时设置
  imported?: boolean
  readOnly?: boolean
}
```

`imported` 和 `readOnly` 由导入方赋值，不是导出方写的。导入时一律分配**新的 id**，
所以重复导入不会覆盖本地已有的 run。

## `events.json` —— timeline

按 `timestamp` 排序的事件数组。

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
  label: string                // timeline 上显示的一行文字
  files?: string[]             // 相对仓库根目录
  changes?: { path: string; kind: 'add' | 'change' | 'unlink' }[]
  diff?: string                // 真实的 unified git diff
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

一轮稳定下来的改动会产生一条 `file_change` 事件，紧跟着一条指向同一个 checkpoint 的
`checkpoint` 事件。

`restore` 事件在 GhostFrame 改写工作区之后写入。它的 `checkpointId` 指向
**safety 备份** —— 这正是 UI 上能一键撤销 restore 的原因。

## `checkpoints/cp_<id>/metadata.json`

```ts
interface CheckpointMetadata {
  id: string
  runId: string
  eventId: string
  timestamp: number
  gitHead: string       // patch 所基于的 commit；仓库没有 commit 时为 ''
  branch: string
  untrackedFiles: { path: string; contentPath: string; mode?: number }[]
  safety?: boolean      // restore 前自动生成的备份
  label?: string
}
```

`trackedPatch` **不在**这个文件里，它单独存放在同目录的 `working.patch`，
读取 checkpoint 时再合并回来。

## `working.patch`

即以下命令的输出：

```
git diff --binary --no-color --no-ext-diff <gitHead>
```

它覆盖已追踪文件的暂存与未暂存改动，包括删除和二进制文件。
当工作区与 base commit 一致、或仓库还没有任何 commit 时，这个文件为空。

## `untracked/`

抓取时刻所有未追踪且未被忽略的文件的原样副本
（来自 `git ls-files --others --exclude-standard`），按相对仓库根目录的路径存放。
metadata 里的 `contentPath` 相对于 checkpoint 目录，且始终使用 `/` 分隔符。

未追踪文件超过 2000 个或总量超过 64MB 时，抓取会直接报错而不是悄悄截断 ——
正确做法是把构建产物加进 .gitignore。

## 从 trace 恢复

要重建某个 checkpoint 记录的工作区：

1. 确认目标仓库里存在 `gitHead`，不存在就停止。
2. 对 patch 涉及的所有路径、以及当前与 `gitHead` 有差异的已追踪路径：
   从 `gitHead` 取回该文件；如果该 commit 里没有这个文件，则删除它。
3. 应用 `working.patch`。
4. 删除不在 `untrackedFiles` 列表里的未追踪文件。
5. 从 `untracked/` 写回 `untrackedFiles` 里的每一个文件。

GhostFrame 会在第 2 步之前写入 safety checkpoint，任何一步失败都会回滚到它。
过程中绝不改写提交历史，也绝不使用 `git reset --hard`。

## 兼容性

读取方遇到未知字段和未知事件类型时应当忽略，而不是报错。
任何会导致已有归档无法读取的改动，都必须提升 `version`。

---

[English](TRACE_FORMAT.md)
