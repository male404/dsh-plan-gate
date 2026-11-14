# Changelog

## 1.2.0

新增 git 护栏：本会话不许模型动 git。

### git 护栏

- 新配置 `gitMode`：`block`（默认）/ `off`。`block` 下命令里的 git 写操作被拒绝，返回 `GIT_BLOCKED`。
- 这道拦截**先于**只读判定、也**先于**批准状态：方案批准不等于允许提交推送。
- 覆盖 `pwsh` / `bash` / `shell` / `terminal_send`；能识别多段命令（`;` `&&` `||` `|` 换行）、`git -C <path> …`、`git -c k=v …`、绝对路径的 `git.exe`。
- 拦：`add` `commit` `push` `pull` `fetch` `merge` `rebase` `reset` `checkout` `switch` `restore` `clean` `stash` `tag` `branch` `remote` `config` 的写形态，以及未列出的子命令（保守拦）。
- 放：`status` `log` `diff` `show` `blame` `shortlog` `describe` `rev-parse` `ls-files` `ls-tree` `cat-file` `show-ref` `merge-base` `grep` `lfs ls-files`，和 `branch` / `tag` / `remote` / `config` 的查询形态。
- 实测 34 条用例全通过（放行 16、拦截 18）。

### 提示词与状态

- `detail` / `brief` / `off` 三档提示词各加一条「不要动 git」；`off` 档明说护栏不随之关闭。
- `plan_gate_status` 返回值新增 `gitMode`。

## 1.1.0

方案先说人话，精简档只列文件。

### 详细档

- `goal` 升为必写：`plan_gate_propose` 时先用一句话总结「这次大概要做什么、做到什么程度」，再展开步骤、涉及文件、验收标准与风险。

### 精简档

- 方案主体改为 `goal`（一句话）+ `files`（要改动的文件清单）；`changes`、`acceptance` 降为可选，步骤与风险段落不再要求。
- 卡片渲染同步：`标题` / `一句话：…` / `改到：…`；确认按钮改为按文件数提问。

### 附带

- `plan_gate_status` 的 hint、`PLAN_GATE_BLOCKED` 的精简档提示、工具 schema 描述同步新语义。

## 1.0.0

首次公开发布。

### 闸门

- 三档：`off` / `detail` / `brief`，按 Session 独立
- `tools/pre-execute` 硬拦截：未批准时 `write` / `edit` / `pwsh` / `computer` / `blender_python` 等执行类工具直接返回 `PLAN_GATE_BLOCKED`
- `plan_gate_propose` 弹原生方案卡片并阻塞等待「批准执行 / 需要修改 / 取消」，15 分钟无响应自动回落 `idle`
- 用户发来新一轮消息时，已批准的窗口自动收回

### 只读判定

- `shellMode: guard`（默认）按「写意图黑名单」放行：不命中就放行
- `shellMode: allowlist` 切回严格模式：每一段命令的首个 token 必须在只读表里
- `computer` / `clipboard` / `windows` 按动作白名单放行

### 工作区交接

- 「移交新对话」生成 `~/.dsh/handoffs/handoff-<时间戳>.md`：目录树、关键文件摘要、最近改动、会话标题与起点请求、闸门状态
- 采集参数全部可配置：`keyFiles` / `skipDirs` / `recentDepth` / `treeDepth` / `treeLimit`
- 交接文档只保留最近 20 份

### 设置

- 设置页新增「先问后做的默认档」，写入 `~/.dsh/plan-gate.json`
- 优先级：设置文件 > `cordis.patch.yml` 的 `defaultMode` > 内置 `detail`

### 附带

- 配套 Skill：`~/.dsh/skills/plan-gate/SKILL.md`，教模型「什么算真歧义、方案要写什么」

### 许可

MIT + Commons Clause v1.0：公司内部、商业项目、私有部署都能用，也能修改与再分发；不得把本项目本身（或改名版本）作为收费产品或托管服务出售。
