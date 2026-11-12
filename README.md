# dsh-plan-gate

给 **DeepSeek Harness** 加一道执行前闸门：每一轮任务都先澄清真歧义、再提交方案，用户点「批准执行」之后才允许改文件、跑命令、操作电脑或生成内容。

软提示靠不住——模型会跳过。所以这里是硬拦截：`tools/pre-execute` 在未批准阶段直接拒绝执行类工具，返回 `PLAN_GATE_BLOCKED`，并告诉模型下一步该调什么。

```
模型想 write 文件  →  PLAN_GATE_BLOCKED（未批准）
模型调 plan_gate_propose  →  弹出方案卡片，阻塞等待
用户点「批准执行」  →  阶段 approved  →  执行类工具放行
```

## 特性

| 能力 | 说明 |
| --- | --- |
| 硬闸门 | 未批准时执行类工具被 deny，不是靠模型自觉 |
| 三档可调 | `off` / `detail` / `brief`，每轮对话独立 |
| 真确认 | 方案卡片走宿主原生 `askQuestion`，模型无法自报「用户同意了」 |
| 只读不拦 | 读文件、搜网页、看窗口照常放行，调研不受影响 |
| 移交新对话 | 一键把工作区事实写成交接文档，新会话直接接手 |
| 设置持久化 | 新对话的默认档在设置页里改，写入 `~/.dsh/plan-gate.json` |
| 零依赖 | 不依赖第三方包，只用 Node 内置模块与宿主注入的服务 |

## 安装

需要一个已经装好的 DeepSeek Harness（`dsh`）。三种装法，按需要挑一种：

### 方式一：插件管理器（推荐）

插件管理 → 安装 bundle → 规格填：

```
github:male404/dsh-plan-gate
```

安装器会 clone 仓库，并按 `package.json` 里的 `dsh.bundle.patch` 注册插件。本项目是纯 JS、没有构建步骤，git 安装不会被 `prepare` 卡住。

两点注意：

- 目录名按包名建（`@local/plan-gate`）：如果你之前用 link 装过同名包，会被顶掉。
- git 源不跟版本走：项目更新后要重装一次才拿到新代码。

装完重启 DSH，或在插件管理器里禁用再启用这个插件。

### 方式二：手动 link（自己改代码时用）

clone 到固定目录，例如 Windows 的 `C:\tools\plan-gate` 或 macOS / Linux 的 `~/tools/plan-gate`：

```bash
git clone https://github.com/male404/dsh-plan-gate.git ~/tools/plan-gate
```

编辑 profile 清单 `~/.dsh/profiles/<profile>/package.json`，把包名指向那个目录：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["…其它 bundle…", "@local/plan-gate"]
    }
  },
  "dependencies": {
    "@local/plan-gate": "link:~/tools/plan-gate"
  }
}
```

然后在同一个目录里安装依赖，再重启 DSH：

```bash
pnpm install
```

> 包名默认是 `@local/plan-gate`，供本地 link 安装。想换成自己的 scope，必须**同时**改三处：`package.json` 的 `name`、`cordis.patch.yml` 里的 `name`、`client.js` 第 2 行的模块 `id`——三处不一致插件会加载失败，而且要把 profile 里的键一起换掉。

### 方式三：从 npm

如果项目已发布到 npm（同时改掉 `@local/` 前缀，见上），直接装包名即可：

```bash
pnpm add <你的包名>
```

## 快速开始

1. 装好后，对话框左侧会出现一个下拉：`先问后做 · 关闭 / 详细 / 精简`，默认「详细」。
2. 随便让它做一件会写文件的事。它会先 `plan_gate_propose`，弹出一张方案卡片。
3. 点「批准执行」，它才开始动手；点「需要修改」，它会改方案再来一次。

## 三档

| 档位 | 闸门 | 方案形态 |
| --- | --- | --- |
| `off` 关闭 | 不拦任何动作 | — |
| `detail` 详细（默认） | 拦写文件 / 起进程 / 操作电脑 | 先用一句 `goal` 总结大概要做什么，再列目标、步骤、涉及文件、验收标准、风险与回滚 |
| `brief` 精简 | 同上，照拦 | 只有一句 `goal`（做什么）+ `files`（要改动的文件清单）；`changes` / 验收可选 |

档位按 Session 独立，切换不影响别的对话。精简档只是把呈现压短，**不减少确认次数**。

两个档位都要求先写一句 `goal`：批准的人先要知道「这事大概做什么」，再决定要不要看细节。精简档只到文件粒度——改哪些文件一目了然，但不再逐行解释每处怎么改。

## 工具

| 工具 | 用途 |
| --- | --- |
| `plan_gate_propose` | 提交方案并阻塞等待「批准执行」。详细档写 `goal` 总述 + 步骤 / 文件 / 验收 / 风险；精简档写 `goal` 一句话 + `files` 文件清单 |
| `plan_gate_status` | 查当前 `mode` / `phase` / `planTitle` |

**提问没有独立工具**：直接用宿主的 `ask_user_question`（它不受闸门拦截，卡片能点选）。插件的 `clarifying` 阶段只由「需要修改」这一分支置位。

## 配置

profile 的 `cordis.patch.yml` 里：

```yaml
- insert:
    - id: plan-gate
      name: dsh-plan-gate
      config:
        defaultMode: detail            # off / detail / brief
        shellMode: guard              # guard = 只拦写意图（默认）；allowlist = 只读白名单
        readonlyTools: []             # 额外放行的工具名
        guardedTools: []              # 额外强制拦截（覆盖所有放行判定）
        extraShellGuard: []           # 追加拦截词，如 ["Invoke-Sqlcmd"]
        extraReadonlyShell: []        # 仅 allowlist 模式生效
        # 交接文档的采集参数
        keyFiles: [README.md, package.json, cordis.patch.yml, AGENTS.md, SKILL.md, index.js, client.js]
        skipDirs: [node_modules, .git, dist, out, build, .next, .cache, coverage, .turbo, target, vendor]
        recentDepth: 2                # 「最近改动」下探层数，0–8
        treeDepth: 3                  # 目录树深度，1–8
        treeLimit: 200                # 目录树条目上限，20–2000
```

采集参数写错了不会炸：非数组或空数组回落默认，数字越界夹到区间。

### 换到别的技术栈

`keyFiles` / `skipDirs` 默认值是照 Node 仓库写的，别的语言自己补：

```yaml
config:
  keyFiles: [README.md, pyproject.toml, requirements.txt, Cargo.toml, go.mod]
  skipDirs: [node_modules, .git, dist, build, target, __pycache__, venv, bin, obj, .pytest_cache]
  recentDepth: 4
  treeDepth: 4
```

## 工作原理

三层配合，缺一层都不可靠：

| 层 | 扩展点 | 作用 |
| --- | --- | --- |
| 软引导 | `systemPrompt.section` | 每步注入规则；关档时换成一行「直接执行」说明 |
| 硬闸门 | `tools/pre-execute`（waterfall） | 未批准 → `{ kind: 'deny' }`，工具不落地 |
| 真确认 | `userQuestions.askTimed()` | 插件自己弹卡片并阻塞，带 15 分钟超时兜底 |

状态按 Session 独立：

```
idle ──plan_gate_propose──> proposed ──┬──「批准执行」──> approved ──新一轮用户消息──> idle
                                       ├──「需要修改」──> clarifying ──> plan_gate_propose
                                       └──「取消」──────> idle
```

`approved` 只对**当前这一轮**有效：用户发来下一条消息就回到 `idle`。子代理不是 root agent，不拦——但它只能在方案批准后由主代理派生，所以绕不过去。

### 只读判定：默认放行，只拦写意图

`shellMode: guard` 下，命令**剥掉注释后只要不命中写意图就放行**。判定从「证明你安全」变成「没查到你危险」。

放行的典型：列目录、读文件、过滤、算哈希、`git status`、`$s = Get-Content …`、带 `# 说明` 注释的多句命令、`2>$null` 丢弃输出。

拦截（命中任一组）：

| 组 | 例子 |
| --- | --- |
| 文件写删 | `Set-Content` `Add-Content` `Out-File` `Remove-Item` `Move-Item` `Copy-Item` `New-Item` `mkdir` `del` `rm`、写到文件的 `>` |
| 进程与解释器 | `Start-Process` `Start-Job` `Invoke-Expression` `iex` `cmd` `powershell` `python` `node` `npm` `pnpm` `pip` `dotnet` `msbuild` `java` `cargo` `gcc` |
| 网络 | `Invoke-WebRequest` `Invoke-RestMethod` `iwr` `irm` `curl` `wget` `Test-NetConnection` `New-Object` |
| 系统设置 | `reg` `sc` `schtasks` `wmic` `Set-ItemProperty` `Set-Service` `Stop-Service` `Stop-Process` `taskkill` `Set-ExecutionPolicy` `bcdedit` `diskpart` `netsh` |
| 权限 | `takeown` `icacls` `cacls` `runas` |
| 加载器 | `rundll32` `regsvr32` `certutil` `bitsadmin` `mshta` `forfiles` |

代价是明确的：黑名单是「证据式」判定，拼字符串绕过会漏过去。要严格模式就设 `shellMode: allowlist`。

其它工具的放行规则：

| 类别 | 放行条件 |
| --- | --- |
| 只读工具 | `read` `glob` `grep` `read_image` `ui_elements` `web_search` `web_fetch` `ask_user_question` `todo_write` `present` 等；后缀 `*_status` `*_list` `*_get` `*_info` `*_view` `*_catalog` `*_summary` `*_schema`；前缀 `mcp__lvkit__*` |
| `computer` | 仅 `screenshot` / `zoom` / `cursor_position` / `wait` |
| `clipboard` | 仅 `read` |
| `windows` | 仅 `list` |

其余（`write` `edit` `terminal_*` `blender_python` `subagent` `plugin_manager` …）一律照拦。`subagent` 本身要拦，是因为派生子代理可能绕过闸门。

## 移交新对话

对话框里的「移交新对话」按钮：

1. `POST /plan-gate/handoff` 采集事实 → 生成 markdown → 写 `~/.dsh/handoffs/handoff-<时间戳>.md`
2. `uiWorkspace.startSession()` 新建会话
3. 文档暂存 sessionStorage（键 `plangate-handoff-arm`，3 分钟有效）；新会话挂载后，按 200/600/1200/2400/4000/6000/8000/10000 ms 重试把文档写进输入框

文档结构：

| 节 | 内容 |
| --- | --- |
| 头部 | 生成时间、工作目录、源会话 id、档位与阶段 |
| 1. 目录结构 | 深度 ≤3、最多 200 项，标题里标明是否截断 |
| 2. 关键文件摘要 | 最多 6 块，每块 20 行；候选目录 = 根目录 + 最近改动命中目录 + 一级子目录 |
| 3. 最近改动 | 最近 8 个文件：相对路径、相对时间、字节数 |
| 4. 上一轮会话留下的状态 | 会话标题、这一轮的起点请求、最近一条用户消息，加会话 id、档位、阶段 |
| 5. 待你补写 | 4 条引导 + 接续提示 |

语义事实来自 `~/.dsh/storages/session_projcache/sessions/<id>.json` 的 `title` / `titleInput`，以及 agent 上的消息列表。任一处读不到就留空，不阻塞交接。

> 第 5 节靠人补写：自动采集给得出事实，给不出意图。

## 设置

设置页里有一节「先问后做的默认档」，下拉三档，选中即写 `~/.dsh/plan-gate.json`：

```json
{ "defaultMode": "brief" }
```

优先级：`~/.dsh/plan-gate.json` > `cordis.patch.yml` 的 `defaultMode` > `detail`。只影响新开的对话；当前对话左侧下拉各自独立。删掉那个文件就回到 patch 里的值。

### HTTP 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/plan-gate/state?sessionId=…` | `{ mode, enabled, modes, phase, planTitle }` |
| `POST` | `/plan-gate/toggle` | body `{ sessionId, mode }` |
| `GET/POST` | `/plan-gate/default-mode` | 读取/写入新会话默认档 |
| `POST` | `/plan-gate/handoff` | 生成交接文档，返回 `{ text, path, root }` |

全部校验同源 Origin。

## 配套 Skill

`SKILL.md`（另存到 `~/.dsh/skills/plan-gate/`）教模型「什么算真歧义、方案要写什么、被拦了别换工具硬试」。没有它插件照样拦，只是模型可能不会问得那么准。

## 开发

```bash
node --check index.js
node --check client.js
```

改完源码要重载插件：插件管理器里禁用再启用，或重启 DSH。`client.js` 的改动另需刷新页面。

### 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 插件：闸门、两个工具、提示词段落、四个 HTTP 端点、交接文档生成 |
| `client.js` | Client 插件：对话框三档下拉、移交按钮、设置页一节 |
| `cordis.patch.yml` | bundle 补丁，插入 `plan-gate` 一行 |
| `locale/{zh,en}.json` | 插件管理页的标题/描述 |
| `icon.svg` | 插件图标 |

## 发布与投稿

### 发一个版本

改完代码、重载插件验证过之后：

```bash
git add -A
git commit -m "feat: 这次改了什么"
git push

git tag -a v1.1.0 -m "dsh-plan-gate 1.1.0"
git push origin v1.1.0
```

然后仓库 Releases → Draft a new release，选刚推的 tag，说明贴 `CHANGELOG.md` 对应段落。

> **tag 必须在最后一次代码推送之后打。** 如果打完 tag 又提交了代码，Release 发的就不是最新那份，只能删掉远程 tag 重推：`git push origin :refs/tags/<tag>`，再 `git tag -a <tag> -m "…"` 和 `git push origin <tag>`。

### 投到 dsh.so 插件市场

<https://www.dsh.so/submit/> → 粘仓库地址 → Run checks → 通过后点 **Submit to dsh.so**。六条验收条件与本项目的对应：

| 条件 | 本项目 |
| --- | --- |
| `dsh` 字段 | `package.json` 的 `dsh.bundle` + `dsh.client` |
| README 安装说明 | 就是这份 README |
| SPDX 许可证标识 | `package.json` 的 `license: "MIT"` |
| 合法 id | 仓库名 `dsh-plan-gate` 匹配合法 slug |
| 可扫描源码 | 纯 JS，扫描 8 个文件 |
| 安全扫描 | 0 严重 / 0 警告（两条「信息」级：设置页的 `fetch`、本地 `127.0.0.1` URL） |

三个实际踩过的坑：

1. **条目 JSON 里的 `license` 是 `NOASSERTION`。** GitHub 的许可证识别器认不出「MIT + Commons Clause」这套组合，所以喂给 dsh.so 的元数据是空的——尽管「格式验证」那一步读 `package.json` 能拿到 MIT。页面允许提交前修改 JSON，把那一行改成 `"MIT"` 再点提交。
2. **提交有限流。** 同一仓库 10 分钟内只允许几次。第一次失败后按钮旁的「GitHub 目前正在限制提交服务」提示会常驻，不代表之后每次点击都被拒，但也别连点——等十分钟再点一次。
3. **加 `dsh-plugin` topic 能被自动索引。** 不想手动投稿就把仓库 topic 加上 `dsh-plugin` 或 `dsh-pack`，registry 会自己扫到；代价是得等它扫。

## 许可

主体是 [MIT](LICENSE)，附加 [Commons Clause](https://commonsclause.com/) v1.0（全文见 [NOTICE.md](NOTICE.md)）。

为什么拆成两个文件：GitHub 的许可证识别器只比对 `LICENSE` 正文与 SPDX 许可证库，把附加条件写进去会让它认不出 MIT，仓库首页就显示「无法确定 SPDX 标识」。拆开后 `LICENSE` 是标准 MIT、识别正常，附加条件在 `NOTICE.md` 里同样有效。

`package.json` 的 `license` 字段写 `MIT`：SPDX 没有表达「MIT + 附加条件」的方式，以 `LICENSE` 与 `NOTICE.md` 为准。

一句话：**随便用，包括公司内部和商业项目；别把它本身拿去卖。**

| 允许 | 禁止 | 要求 |
| --- | --- | --- |
| 公司内部使用、私有部署 | 把本项目（或改个名字、改几个函数名的版本）作为收费产品出售 | 保留版权声明与这份许可副本 |
| 嵌进你自己的产品、二次开发、内部分发 | 把它包装成收费的托管 / SaaS 服务 | 分发时带上 Commons Clause 条件声明 |
| 分发原版或修改版 | 用一个"实质上就是它"的收费产品获利 | — |
| 卖你**在它之上**做的产品、提供咨询服务 | — | — |

也就是说：你做的产品可以卖、可以商用、可以作为 SaaS 提供——被限制的只是「把这个插件本身当成商品」。

> 这不是法律意见；真要大规模商业分发，按需咨询律师。

