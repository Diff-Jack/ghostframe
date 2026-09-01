# GhostFrame

**为 Coding Agent 提供时间旅行式调试。**

看清 AI 究竟从哪一步开始把代码改坏。

GhostFrame 在 Coding Agent（Claude Code、Codex、Cursor、Windsurf、自研 Agent）
改动仓库时全程记录，把每一次稳定变更保存成 checkpoint，并且可以把工作区真正地
恢复到历史上的任意一点。

它**不是** Agent，不是聊天工具，不是 IDE。它只回答一个问题：

> *哪一步把代码改坏了？那次改动到底改了什么？怎么回到那个状态？*

`No account · No cloud · No telemetry`

---

## 核心循环

| 步骤 | 作用 |
| --- | --- |
| **Record** | Agent 改动仓库时持续记录 |
| **Inspect** | 每次改动都是一条带元数据的 timeline 事件 |
| **Diff** | 真实的 `git diff`，包含未追踪文件 |
| **Checkpoint** | 每次稳定变更后生成可恢复快照 |
| **Restore** | 安全地把工作区恢复回去 |
| **Fork** | 从任意历史 checkpoint 开一条新的 run |
| **Attribute** | 把每次改动归到造成它的那句 prompt 下面 |

## 快速开始

```bash
npm install
npm run build
npm start
```

```
GhostFrame running at:
  http://127.0.0.1:7331
```

开发模式（UI 在 `:7330`，API 在 `:7331`）：

```bash
npm run dev
```

## 使用方式

1. **Open Local Repository** —— 输入绝对路径（支持 `~`）。浏览器出于安全限制无法把
   真实文件系统路径交给网页，因此由本地 daemon 负责解析与校验。不是 git 仓库时会给出
   明确提示，不会崩溃。
2. **Start Recording** —— GhostFrame 先写入一个 baseline checkpoint，然后开始监听。
3. **让 Agent 干活。** 每一轮稳定下来的改动会生成一条 `file_change` 事件加一个
   checkpoint。变更做了防抖（约 1 秒），所以是「一次逻辑改动一个 checkpoint」，
   而不是每次按键都生成。
4. **点击任意 timeline 事件** 查看 `Detail`、`Diff`（真实 unified diff）、
   `Raw`（事件 JSON）。
5. **Run command** 在仓库里执行命令，记录 stdout、stderr 和 exit code。识别到常见测试
   命令时标记为 `test` 事件。
6. **Restore checkpoint** 把工作区恢复到那一刻。
7. **Fork from here** 恢复某个 checkpoint 并从它开一条新 run，方便重新跑 Agent 走另一条路。
8. **Export .ghost / Import** 在不同机器之间搬运完整 trace。

## Prompt 级历史(Claude Code)

**这是 git 做不到的部分。**

```bash
ghostframe install-hooks     # 在你的仓库里执行一次
```

之后 Claude Code 会把每一条指令、每一次工具调用报给 GhostFrame,
timeline 就不再是一串扁平的文件变化了:

```
▶ "重构结算逻辑,顺便把金额取整"
  │ ⚙ Read   src/cart.js
  │ ⚙ Edit   src/cart.js
  │ ✎ Modified src/cart.js
  │ ◆ Checkpoint cp_088aea7f
  │ ⏱ npm test → exit 0

▶ "顺手优化一下折扣的边界判断"                              ← 就是这句
  │ ⚙ Edit   src/cart.js
  │ ⚙ Read   .env                    ⚠ 凭据: .env
  │ ⚙ Bash   curl https://api.x.dev  ⚠ 外网: api.x.dev
  │ ✎ Modified src/cart.js
  │ ◆ Checkpoint cp_ee5e62fa
  │ ⏱ npm test → exit 1
```

你会拿到三样单看 diff 永远拿不到的东西:

- **哪句话造成了哪次改动。** 不是"哪一分钟",是"哪条指令"。
- **Agent 读了什么**,而不只是写了什么。像凭据的路径会被标出来;
  仓库之外的文件会保留绝对路径,一眼就能看见。
- **它连了哪里。** Agent 执行的命令里出现的域名会被列出来。
  这是从命令文本里读的,不是拦截流量 —— 所以它的含义是"命令里出现过这些 URL",
  **不等于**完整的出网记录。

用 `ghostframe install-hooks --uninstall` 移除。它只往
`.claude/settings.json` 里追加,已有的配置一律不动。

如果没反应,跑 `ghostframe doctor` —— hook 被刻意设计成绝不出声(它绝不能成为
你编码会话崩掉的原因),所以 `doctor` 是唯一会告诉你哪里不对的地方。

## 自动记录 Agent 的测试结果

用它包一层，命令结果就会自动出现在 timeline 上：

```bash
ghostframe exec -- npm test
```

它会像普通 shell 一样执行命令 —— 输出实时透传、exit code 原样返回 —— 同时把结果记到
当前正在录制这个仓库的 run 上。识别到常见测试命令时会记成 `test` 事件，
这正是 first-bad-change 判断所依赖的数据。

daemon 没启动或当前没有在录制时，命令照常执行、exit code 照常返回，
只会多一行提示。

把 Agent 的测试命令指向它，就再也不用手动点 `Run` 了。

## 安全模型

Restore 会真的改写文件。GhostFrame 认为「弄丢用户的工作」是唯一不可接受的结果，所以：

- 每次 restore 之前**一定**先写一个 **safety checkpoint**。它会挂在 timeline 的 restore
  事件上，撤销一次 restore 只需要点一下。
- 如果 safety checkpoint 创建失败，restore 会被**取消**，而不是硬着头皮执行。
- 如果 restore 中途失败，GhostFrame 会**回滚**到 safety checkpoint 并报错。
  绝不静默失败。
- 绝不使用 `git reset --hard`。只处理当前工作区与 checkpoint 之间真正有差异的路径，
  **绝不改写提交历史**。
- Restore 会删除 checkpoint 之后新建的未追踪文件 —— 它们已在 safety checkpoint 中，
  可以找回。
- 导入的 trace 如果在本机找不到对应仓库，则为**只读**，不允许 restore。

API 只监听 loopback，并且会额外拒绝携带非本地 `Origin` 的请求（你访问的某个网站试图
驱动它）和非本地 `Host` 的请求（DNS rebinding）。它**不**试图防御以你的身份运行的其他
本机进程 —— 那个进程本来就能做 GhostFrame 能做的一切。

## 数据存放位置

全部在本机，都是普通文件：

```
~/.ghostframe/
  config/
  traces/
  runs/
    run_<id>/
      run.json
      events.json
      objects/               # 内容寻址存储，每个 run 内同内容只存一份
      checkpoints/
        cp_<id>/
          metadata.json
          working.patch        # 相对 base commit 的 git diff --binary
          untracked/           # 指向 objects/ 的硬链接
```

每个 checkpoint 都会抓取全部未追踪文件，而一条长 run 里这些字节大部分是重复的。
每个 `untracked/<path>` 都是指向该 run object store 的硬链接，所以相同内容只存一份 ——
二十个 checkpoint 里没变过的文件只占一份空间。对外看起来仍然就是普通文件，
`.ghost` 归档里也一样。

用 `GHOSTFRAME_HOME` 可以改位置。其他环境变量：
`GHOSTFRAME_PORT`（7331）、`GHOSTFRAME_HOST`（127.0.0.1）、`GHOSTFRAME_DEBOUNCE_MS`（1000）。

checkpoint 是「git patch + 未追踪文件副本」，不是文件系统快照，也不是 VM 快照。
这样体积小、可读、可逆。

## First Bad Change

当一条 run 里出现「测试通过 → 之后测试失败」时，GhostFrame 会指出回归是在哪个
checkpoint 之后引入的、第一个观察到的失败状态是哪个 checkpoint，并在 timeline 上
高亮嫌疑区间。

这一步完全是确定性判断，不使用 LLM；证据不足时不会给结论。

## Trace 格式

`.ghost` 是 ZIP 归档。见 [docs/TRACE_FORMAT.zh-CN.md](docs/TRACE_FORMAT.zh-CN.md)。

## 开发

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

想让 `ghostframe` 进 PATH(这样即使挪动目录 hook 也不会失效):

```bash
npm link
```

测试全部在临时目录里的一次性 git 仓库上运行，绝不会拿真实工程做破坏性恢复测试。

## 目录结构

```
server/        本地 daemon：api / git / watcher / checkpoint / trace / storage / core
src/frontend/  React UI
shared/        前后端共用类型
docs/          trace 格式
tests/         vitest 测试
```
