# Changelog

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
