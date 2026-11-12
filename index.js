/**
 * plan-gate — 先澄清、再出方案、用户批准后才执行。
 *
 * 三层配合：
 *  1. 软引导  systemPrompt.section   说明闸门规则（开关关闭时换成一行放行说明）
 *  2. 硬闸门  tools/pre-execute      未批准阶段拒绝执行类工具
 *  3. 真确认  userQuestions.askTimed() 阻塞等用户点选（带超时兜底），模型无法自报“用户同意了”
 *
 * 状态按 Session 维护；`/plan-gate/state` 与 `/plan-gate/toggle` 供对话框按钮读写。
 */

import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const name = 'plan-gate'

export const inject = ['tools', 'systemPrompt', 'userQuestions', 'agents']

const PHASE = Object.freeze({
  IDLE: 'idle',
  CLARIFYING: 'clarifying',
  PROPOSED: 'proposed',
  APPROVED: 'approved',
})

const MODE_OFF = 'off'
const MODE_DETAIL = 'detail'
const MODE_BRIEF = 'brief'
const MODES = [MODE_OFF, MODE_DETAIL, MODE_BRIEF]

/** 方案卡片最长等待时长：超时后放弃等待，避免模型无限挂起。 */
const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000

const APPROVE_LABEL = '批准执行'
const REVISE_LABEL = '需要修改'
const CANCEL_LABEL = '取消'

/** 用户点完批准后，那条回答消息可能在同一请求系列里晚一步被 admit；这段时间内不把它当成新请求。 */
const APPROVAL_GRACE_MS = 90_000

/** 由提问产生的用户消息会带 source；据此区分「回答」与「用户新发的一句话」。 */
function looksLikeAnswer(message) {
  try {
    const source = message?.source ?? message?.meta?.source
    if (!source) return false
    return /question|answer|ask/i.test(JSON.stringify(source))
  } catch {
    return false
  }
}

/** 明确只读、无外部副作用的工具：闸门放行，避免把“先查资料”也变成审批流程。 */
const READONLY_TOOLS = new Set([
  'read', 'glob', 'grep', 'read_image', 'ui_elements',
  'web_search', 'web_fetch',
  'ask_user_question', 'skill', 'todo_write', 'present',
  'list_agents', 'list_granted_applications', 'list_subagent_models',
  'job_list', 'job_output',
  'get_goal',
  'schedule_list', 'schedule_view',
  'task_board_list', 'task_board_get',
  'cordis_inspect_list', 'cordis_inspect_query',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'plugin_market', 'switch_display',
  'blender_status', 'blender_scene_info', 'blender_object_info',
  'blender_validate_scene', 'blender_validate_export', 'blender_helper_catalog',
  'labview_info', 'labview_vi_info', 'labview_vi_summary', 'labview_describe',
  'labview_controls', 'labview_get', 'labview_status', 'labview_render',
  'labview_visualize', 'labview_docs', 'labview_explain_error',
  'labview_project_check', 'labview_project_items',
  'purge_status',
  'plan_gate_status', 'plan_gate_propose',
])

const READONLY_SUFFIXES = ['_status', '_list', '_get', '_info', '_view', '_catalog', '_summary', '_schema']
const READONLY_PREFIXES = ['mcp__lvkit__']

/**
 * shell 只读命令：按管道/分号切段后，每段首个 token 必须全在这张表里。
 * 刻意不收 ForEach-Object、Invoke-*、Start-Process、& 调用一类的写法——它们能把任意代码夹在只读外形里。
 */
const SHELL_READONLY_COMMANDS = new Set([
  'get-childitem', 'gci', 'dir', 'ls',
  'get-content', 'gc', 'cat', 'type',
  'get-item', 'gi', 'get-location', 'gl', 'pwd',
  'select-string', 'sls', 'select-object', 'where-object',
  'measure-object', 'sort-object', 'group-object',
  'format-table', 'ft', 'format-list', 'fl', 'format-wide', 'out-string',
  'test-path', 'resolve-path', 'get-filehash', 'get-date',
  'get-process', 'get-service', 'get-command', 'get-help', 'get-member',
  'get-acl', 'get-itemproperty', 'write-output', 'echo',
])

const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 写意图黑名单。shellMode='guard'（默认）下**不命中即放行**，所以这里要盖住会改状态的六类：
 * 文件写删、进程与解释器、网络、系统设置、权限、加载器/工具。
 */
const SHELL_GUARD_PATTERN = new RegExp(
  '(^|[\\s;|&(])('
  + [
    'set-content', 'add-content', 'clear-content', 'out-file', 'remove-item', 'rename-item',
    'move-item', 'copy-item', 'new-item', 'new-itemproperty', 'mkdir', 'md', 'rmdir', 'del',
    'erase', 'rm', 'tee-object', 'set-itemproperty', 'set-item', 'set-acl',
    'start-process', 'start-job', 'start-threadjob', 'invoke-expression', 'iex', 'invoke-command',
    'cmd', 'powershell', 'pwsh', 'python', 'python3', 'node', 'npm', 'npx', 'pnpm', 'yarn',
    'pip', 'pip3', 'dotnet', 'msbuild', 'java', 'javac', 'cargo', 'gcc',
    'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm', 'curl', 'wget', 'ftp',
    'test-netconnection', 'new-object',
    'reg', 'sc', 'schtasks', 'wmic', 'set-service', 'stop-service', 'restart-service',
    'stop-process', 'taskkill', 'kill', 'shutdown', 'restart-computer', 'bcdedit', 'diskpart',
    'format-volume', 'netsh', 'set-executionpolicy', 'import-module',
    'takeown', 'icacls', 'cacls', 'runas',
    'rundll32', 'regsvr32', 'certutil', 'bitsadmin', 'mshta', 'forfiles',
  ].join('|')
  + ')\\b',
  'i',
)

const READONLY_COMPUTER_ACTIONS = new Set(['screenshot', 'zoom', 'cursor_position', 'wait'])
const READONLY_CLIPBOARD_ACTIONS = new Set(['read'])
const READONLY_WINDOWS_ACTIONS = new Set(['list'])

function normalizeShellToken(raw) {
  let token = String(raw ?? '').trim()
  if (!token) return ''
  token = token.replace(/^[('"`$@&.]+/, '').replace(/['"`()]+$/, '')
  const cut = token.search(/[\\/:]/)
  if (cut > 0) token = token.slice(0, cut)
  return token.toLowerCase()
}

/** 引号感知地剥掉 <# … #> 与行内 # 注释，免得注释里的字样误伤判定。 */
function stripShellComments(command) {
  const text = String(command ?? '').replace(/<#[\s\S]*?#>/g, ' ')
  let out = ''
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      out += char
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      out += char
      continue
    }
    if (char === '#' && (index === 0 || /[\s;|&(]/.test(text[index - 1]))) {
      while (index < text.length && text[index] !== '\n') index += 1
      out += '\n'
      continue
    }
    out += char
  }
  return out
}

/** guard 模式：不命中写意图即放行。返回 true 表示这次调用要先经用户批准。 */
function shellNeedsApproval(command, extraGuards) {
  const raw = String(command ?? '')
  if (!raw.trim()) return false
  const text = stripShellComments(raw)
  if (!text.trim()) return false
  if (SHELL_GUARD_PATTERN.test(text)) return true
  for (const word of extraGuards) {
    if (new RegExp(`(^|[\\s;|&(])${escapeRegExp(word)}\\b`, 'i').test(text)) return true
  }
  // >$null / 2>$null / 2>&1 是丢弃输出，不算写盘
  const withoutNullSink = text.replace(/[*\d]?>&\d/g, ' ').replace(/[*\d]?>\s*\$null\b/gi, ' ')
  return />>?/.test(withoutNullSink)
}

/** allowlist 模式：每段首个 token 都必须在只读表里（旧的严格行为）。 */
function isReadonlyShellCommand(command, extraCommands) {
  if (shellNeedsApproval(command, [])) return false
  const text = stripShellComments(command)
  if (!text.trim()) return false
  const segments = text.split(/\r?\n|;|\|\||&&|\|/)
  let sawCommand = false
  for (const segment of segments) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    if (/^(if|foreach|for|while|switch|function|try|begin|process|end|class)\b/i.test(trimmed)) return false
    const name = normalizeShellToken(trimmed.split(/\s+/)[0])
    if (!name) continue
    sawCommand = true
    if (!SHELL_READONLY_COMMANDS.has(name) && !extraCommands.has(name)) return false
  }
  return sawCommand
}

function readonlyByArgument(toolName, args) {
  const action = String(args?.action ?? '')
  if (toolName === 'computer') return READONLY_COMPUTER_ACTIONS.has(action)
  if (toolName === 'clipboard') return READONLY_CLIPBOARD_ACTIONS.has(action)
  if (toolName === 'windows') return READONLY_WINDOWS_ACTIONS.has(action)
  return false
}

const RULES_TEXT = `# Plan Gate（先问后做）

本会话开启了「先澄清 → 出方案 → 用户批准 → 才执行」的闸门。规则：

1. 先用只读手段把事实查清：read / grep / glob / web_search，以及 pwsh 里不带写意图的命令（列目录、读文件、过滤、算哈希、git status）都不受拦截。会写文件、删改、起进程、跑解释器（python / node / npm）、联网（iwr / curl）、改系统设置（reg / sc / schtasks）的命令，以及操作电脑（点击、输入）会被闸门拒绝并返回 \`PLAN_GATE_BLOCKED\`。
2. 只有真歧义才提问：目标或对象不清、范围不清、交付格式不清、验收标准不清、多个方案代价差别大。自己能查清的事不要问用户。
3. 提问用宿主的 \`ask_user_question\`（它不受闸门拦截，卡片可直接点选）：1–4 个问题，每个给选项，推荐项放第一个并标注「（推荐）」。用户答完后按答案收敛，不要重复问同一件事。
4. 没有真歧义时不要提问，直接 \`plan_gate_propose\`：先用一句话总结「这次大概要做什么、做到什么程度」（写进 \`goal\`），再给标题、步骤、涉及文件或工具、验收标准、风险与回滚；\`summary\` 用来补做法与取舍。该工具会阻塞到用户点选。
5. 只有用户点了「批准执行」，阶段才进入 approved，执行类工具放行；此时一次把方案做完，不要擅自扩大范围。
6. 用户选择「需要修改」或直接写了新要求：调整方案后再次 \`plan_gate_propose\`，不要先执行再解释。
7. 纯问答、闲聊、只读调研可以直接回答，不必走闸门。

被拒时不要换工具硬试：立刻用 \`ask_user_question\` 澄清，或直接 \`plan_gate_propose\`。`

const RULES_TEXT_OFF = `# Plan Gate：已关闭

本轮按正常流程直接执行：不必先提问，也不必先提交方案等待批准；执行类工具不被拦截。
如果用户明确要求「先给方案再动手」，仍然照办——用 plan_gate_propose 征求确认。`

const RULES_TEXT_BRIEF = `# Plan Gate（精简）

本会话要「先问后做」，但方案只给概要：一句话说清做什么，再列出要改的文件，不写长篇。

1. 只读手段（read / grep / glob / web_search、pwsh 里的读操作）直接用来查清事实，不受拦截。
2. 只有真歧义才提问，最多 2 个，每个给选项、推荐项放第一。
3. 出方案用 \`plan_gate_propose\`，压到最小：
   - \`goal\`：一句话总结大概要做什么（必写）；
   - \`files\`：要改动的文件或目录清单（必写，一行一个路径）；
   - \`changes\`、\`acceptance\` 可选，只在某处改动必须说清时才补一两行。
   步骤、目标背景、动机、风险段落不要写——除非某一处会毁数据。
4. 批准后才动手；未批准时写文件、起进程、操作电脑会被拦并返回 \`PLAN_GATE_BLOCKED\`。
5. 用户要改方案时，重新提交一份「一句话 + 文件清单」，不要先执行。`

function blockReason(toolName, phase, mode) {
  const briefHint = mode === MODE_BRIEF
    ? '\n当前是精简档：方案只写 goal 一句话（大概要做什么）+ files 文件清单，其余可省，不要写目标与风险段落。'
    : ''
  return `PLAN_GATE_BLOCKED：本轮请求还没有获得方案批准，工具「${toolName}」没有执行（当前阶段：${phase}）。\n`
    + '按顺序处理，不要换别的工具硬试：\n'
    + (mode === MODE_BRIEF
      ? '1) 存在真歧义 → 用 ask_user_question 提问（最多 2 个，带选项，推荐项放第一个）。\n'
        + '2) 无歧义 → plan_gate_propose 提交改动点清单，它会阻塞等用户点「批准执行」。\n'
      : '1) 存在真歧义 → 用 ask_user_question 提问（1–4 个，带选项，推荐项放第一个）。\n'
        + '2) 无歧义或已问清 → plan_gate_propose 提交方案（目标 / 步骤 / 涉及文件 / 验收标准 / 风险与回滚），它会阻塞等用户点「批准执行」。\n')
    + '3) 用户批准后，同一个工具即可正常调用。\n'
    + '不受拦截的：read / grep / glob / web_search，以及 pwsh 里不带写意图的命令（列目录、读文件、过滤、查哈希、git status 之类）。只有会写文件、删改、起进程、跑解释器、联网、改系统设置的命令才会被拦。'
    + briefHint
}

function renderPlan(plan) {
  const lines = [`## 方案：${plan.title}`]
  if (plan.goal) lines.push('', `**目标**：${plan.goal}`)
  if (plan.summary) lines.push('', plan.summary)
  if (plan.steps?.length) {
    lines.push('', '**步骤**')
    plan.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`))
  }
  if (plan.files?.length) {
    lines.push('', '**涉及文件 / 产物**')
    plan.files.forEach(file => lines.push(`- ${file}`))
  }
  if (plan.acceptance?.length) {
    lines.push('', '**验收标准**')
    plan.acceptance.forEach(item => lines.push(`- ${item}`))
  }
  if (plan.risks?.length) {
    lines.push('', '**风险与回滚**')
    plan.risks.forEach(risk => lines.push(`- ${risk}`))
  }
  if (plan.notes) lines.push('', `**补充**：${plan.notes}`)
  return lines.join('\n')
}

function renderPlanBrief(plan) {
  const lines = [`**${plan.title}**`]
  const goal = plan.goal || plan.summary
  if (goal) lines.push('', `一句话：${goal}`)
  if (Array.isArray(plan.changes) && plan.changes.length) {
    plan.changes.forEach(item => lines.push(`- ${item}`))
  }
  if (plan.files?.length) lines.push('', `改到：${plan.files.join('、')}`)
  else if (!goal && plan.steps?.length) plan.steps.forEach(item => lines.push(`- ${item}`))
  if (plan.acceptance?.length) lines.push(`验收：${plan.acceptance.join('；')}`)
  if (plan.notes) lines.push(`备注：${plan.notes}`)
  return lines.join('\n')
}

function rulesFor(mode) {
  if (mode === MODE_OFF) return RULES_TEXT_OFF
  if (mode === MODE_BRIEF) return RULES_TEXT_BRIEF
  return RULES_TEXT
}

function affirmative(text) {
  return /^(批准|批准执行|同意|同意执行|可以|开始|执行|继续|好|行|ok|okay|yes|y|go|approve|proceed|do it)$/i.test(text.trim())
}

function describeAnswer(answer) {
  const item = answer?.answers?.[0]
  if (!item) return { approved: false, cancelled: true, text: '（没有得到回答）' }
  const selected = Array.isArray(item.selected) ? item.selected : []
  const custom = String(item.custom ?? '').trim()
  const approved = selected.includes(APPROVE_LABEL) || (selected.length === 0 && affirmative(custom))
  const cancelled = selected.includes(CANCEL_LABEL)
  const parts = []
  if (selected.length) parts.push(selected.join(' / '))
  if (custom) parts.push(`补充：${custom}`)
  return { approved, cancelled, selected, custom, text: parts.join('；') || '（空回答）' }
}

/** 采集默认值：与开放 config 之前的行为逐项一致。 */
const COLLECT_DEFAULTS = Object.freeze({
  keyFiles: ['README.md', 'package.json', 'cordis.patch.yml', 'AGENTS.md', 'SKILL.md', 'index.js', 'client.js'],
  skipDirs: ['node_modules', '.git', 'dist', 'out', 'build', '.next', '.cache', 'coverage', '.turbo', 'target', 'vendor'],
  recentDepth: 2,
  treeDepth: 3,
  treeLimit: 200,
})
const KEY_DIR_LIMIT = 12
const KEY_BLOCK_LIMIT = 6
const KEY_BLOCK_LINES = 20
const KEY_BLOCK_CHARS = 1200
const FACT_TEXT_LIMIT = 800
const HANDOFF_KEEP = 20

const clampInt = (value, fallback, min, max) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.round(parsed), min), max)
}

const pickList = (value, fallback) => {
  const list = Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : []
  return list.length ? list : fallback.slice()
}

/** config → 采集参数：非数组或空数组回落默认，数字越界夹到区间。 */
export function collectOptions(config = {}) {
  return {
    keyFiles: pickList(config.keyFiles, COLLECT_DEFAULTS.keyFiles),
    skipDirs: pickList(config.skipDirs, COLLECT_DEFAULTS.skipDirs),
    recentDepth: clampInt(config.recentDepth, COLLECT_DEFAULTS.recentDepth, 0, 8),
    treeDepth: clampInt(config.treeDepth, COLLECT_DEFAULTS.treeDepth, 1, 8),
    treeLimit: clampInt(config.treeLimit, COLLECT_DEFAULTS.treeLimit, 20, 2000),
  }
}

async function readHead(file, maxLines = KEY_BLOCK_LINES, maxChars = KEY_BLOCK_CHARS) {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    const all = raw.split(/\r?\n/)
    let body = all.slice(0, maxLines).join('\n')
    let cut = all.length > maxLines
    if (body.length > maxChars) {
      body = body.slice(0, maxChars)
      cut = true
    }
    return cut ? `${body}\n…（共 ${all.length} 行，已截断）` : body
  } catch {
    return ''
  }
}

async function walkTree(root, options = COLLECT_DEFAULTS) {
  const skipDirs = new Set(options.skipDirs)
  const treeLimit = options.treeLimit
  const treeDepth = options.treeDepth
  const lines = []
  let truncated = false
  let depthCut = false
  const walk = async (dir, depth, prefix) => {
    if (lines.length >= treeLimit) { truncated = true; return }
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (lines.length >= treeLimit) { truncated = true; return }
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) { lines.push(`${prefix}${entry.name}/ · skipped`); continue }
        lines.push(`${prefix}${entry.name}/`)
        if (depth < treeDepth) await walk(path.join(dir, entry.name), depth + 1, `${prefix}  `)
        else depthCut = true
      } else {
        lines.push(`${prefix}${entry.name}`)
      }
    }
  }
  await walk(root, 1, '')
  return { lines, truncated, depthCut }
}

async function recentFiles(root, options = COLLECT_DEFAULTS, limit = 8) {
  const skipDirs = new Set(options.skipDirs)
  const found = []
  const walk = async (dir, depth) => {
    if (depth > options.recentDepth || found.length > 500) return
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || skipDirs.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { await walk(full, depth + 1); continue }
      try {
        const stat = await fsp.stat(full)
        found.push({ full, mtime: stat.mtimeMs, size: stat.size })
      } catch { /* ignore */ }
    }
  }
  await walk(root, 0)
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
}

/** 关键文件候选目录：根目录、最近改动命中文件所在目录、一级子目录。 */
async function keyFileCandidates(root, recents, options = COLLECT_DEFAULTS) {
  const skipDirs = new Set(options.skipDirs)
  const resolvedRoot = path.resolve(root)
  const dirs = [resolvedRoot]
  const seen = new Set([resolvedRoot])
  const push = (dir) => {
    const resolved = path.resolve(dir)
    if (seen.has(resolved)) return
    if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) return
    seen.add(resolved)
    dirs.push(resolved)
  }
  for (const file of recents.slice(0, 6)) push(path.dirname(file.full))
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.') || skipDirs.has(entry.name) || !entry.isDirectory()) continue
      push(path.join(root, entry.name))
    }
  } catch { /* ignore */ }
  return dirs.slice(0, KEY_DIR_LIMIT)
}

function truncateText(text, limit = FACT_TEXT_LIMIT) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean
}

function extractText(message) {
  const content = message?.content ?? message?.text ?? message?.parts
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const pieces = []
    for (const part of content) {
      if (!part) continue
      if (typeof part === 'string') pieces.push(part)
      else if (typeof part.text === 'string') pieces.push(part.text)
    }
    return pieces.join(' ')
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

/** 尽力从 agent 上取最近一条用户消息；不同版本的宿主把消息放在不同字段。 */
function lastUserText(agent) {
  const holders = [agent?.messages, agent?.history, agent?.transcript?.messages, agent?.transcript, agent?.conversation]
  for (const holder of holders) {
    const list = Array.isArray(holder) ? holder : (Array.isArray(holder?.messages) ? holder.messages : null)
    if (!list || !list.length) continue
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index]
      const role = String(message?.role ?? message?.kind ?? '')
      if (role !== 'user') continue
      const text = truncateText(extractText(message))
      if (text) return text
    }
  }
  return ''
}

function findEntry(node, key, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return undefined
  if (Object.prototype.hasOwnProperty.call(node, key)) return node[key]
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const hit = findEntry(value, key, depth + 1)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

async function readProjCache(sessionId) {
  const file = path.join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** 会话语义事实：标题、起点请求、最近一条用户消息。取不到的项留空，不阻塞交接。 */
async function collectSessionFacts(sessionId, getAgents) {
  const facts = { title: '', firstRequest: '', lastMessage: '' }
  if (!sessionId) return facts
  try {
    const cached = await readProjCache(sessionId)
    if (cached) {
      const title = findEntry(cached, 'title')
      if (typeof title?.val === 'string') facts.title = truncateText(title.val, 120)
      const titleInput = findEntry(cached, 'titleInput')
      const first = titleInput?.val?.first ?? titleInput?.first
      if (typeof first?.text === 'string') facts.firstRequest = truncateText(first.text)
    }
  } catch { /* ignore */ }
  try {
    const agents = typeof getAgents === 'function' ? getAgents() : undefined
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    if (agent) facts.lastMessage = lastUserText(agent)
  } catch { /* ignore */ }
  return facts
}

function ago(ms) {
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
  return `${Math.round(diff / 86_400_000)} 天前`
}

async function buildHandoff({ root, sessionId, mode, phase, planTitle, facts, options }) {
  const opts = options && typeof options === 'object' ? options : COLLECT_DEFAULTS
  const tree = await walkTree(root, opts)
  const recents = await recentFiles(root, opts)
  const keyBlocks = []
  for (const dir of await keyFileCandidates(root, recents, opts)) {
    if (keyBlocks.length >= KEY_BLOCK_LIMIT) break
    const picked = []
    for (const name of opts.keyFiles) {
      const head = await readHead(path.join(dir, name))
      if (head) picked.push({ name, head })
      if (picked.length >= 2) break
    }
    for (const item of picked) {
      if (keyBlocks.length >= KEY_BLOCK_LIMIT) break
      keyBlocks.push({ name: path.relative(root, path.join(dir, item.name)) || item.name, head: item.head })
    }
  }

  const treeNotes = [`深度 ≤${opts.treeDepth}`, `最多 ${opts.treeLimit} 项`, '已跳过依赖与构建产物']
  if (tree.truncated) treeNotes.push('条目已达上限，其余未列出')
  if (tree.depthCut) treeNotes.push(`${opts.treeDepth} 层以下的目录未展开`)
  const known = facts && typeof facts === 'object' ? facts : {}
  const parts = [
    `# 工作区交接 · ${path.basename(path.resolve(root)) || root}`,
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 工作目录：\`${root}\``,
    `- 源会话：\`${sessionId}\``,
    `- Plan Gate：档位 \`${mode}\`，阶段 \`${phase}\`${planTitle ? `，方案「${planTitle}」` : ''}`,
    '',
    '> 这份文档由 Plan Gate 自动采集事实生成。新会话请先读完第 1–4 节，再补写第 5 节。',
    '',
    `## 1. 目录结构（${treeNotes.join('，')}）`,
    '',
    '```',
    ...(tree.lines.length ? tree.lines : ['（空目录）']),
    '```',
    '',
    '## 2. 关键文件摘要',
    '',
  ]
  if (keyBlocks.length) {
    for (const block of keyBlocks) {
      parts.push(`### ${block.name}`, '', '````', block.head, '````', '')
    }
  } else {
    parts.push('（这些位置都没有 README / package.json / cordis.patch.yml 一类关键文件）', '')
  }
  parts.push('## 3. 最近改动', '')
  if (recents.length) {
    for (const file of recents) {
      parts.push(`- \`${path.relative(root, file.full)}\` · ${ago(file.mtime)} · ${file.size} B`)
    }
  } else {
    parts.push('（没有可读文件）')
  }
  parts.push('', '## 4. 上一轮会话留下的状态', '')
  if (known.title) parts.push(`- 会话标题：${known.title}`)
  if (known.firstRequest) parts.push(`- 这一轮的起点请求：${known.firstRequest}`)
  parts.push(
    `- 会话 id：\`${sessionId}\``,
    `- 闸门档位：\`${mode}\`（off = 不拦 / detail = 完整方案 / brief = 一句话 + 文件清单）`,
    `- 闸门阶段：\`${phase}\``,
  )
  if (known.lastMessage) parts.push(`- 最近一条用户消息：${known.lastMessage}`)
  parts.push(
    '',
    '## 5. 待你补写',
    '',
    '读完上面的事实后，补上这几段再开始干活：',
    '',
    '1. **这个工作区在做什么**：一句话目标。',
    '2. **已完成 / 进行中 / 待办**：按状态分组，每条能对上具体文件。',
    '3. **踩过的坑**：哪些尝试被否决、为什么；哪些缺陷已修、哪些还留着。',
    '4. **下一步建议**：先从哪件事开始，为什么。',
    '',
    '> 把上面这份文档当成任务背景，接着做：____',
  )
  return parts.join('\n')
}

/** 只保留最近 HANDOFF_KEEP 份交接文档；清理失败不影响响应。 */
async function pruneHandoffs(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      if (!entry.isFile() || !/^handoff-.*\.md$/.test(entry.name)) continue
      const full = path.join(dir, entry.name)
      try {
        files.push({ full, mtime: (await fsp.stat(full)).mtimeMs })
      } catch { /* ignore */ }
    }
    files.sort((a, b) => b.mtime - a.mtime)
    for (const file of files.slice(HANDOFF_KEEP)) {
      try { await fsp.unlink(file.full) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  return JSON.parse(raw)
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

export function apply(ctx, config = {}) {
  const defaultMode = MODES.includes(config.defaultMode)
    ? config.defaultMode
    : (config.defaultEnabled === false ? MODE_OFF : MODE_DETAIL)
  const readonlyExtra = new Set(Array.isArray(config.readonlyTools) ? config.readonlyTools : [])
  const guardedExtra = new Set(Array.isArray(config.guardedTools) ? config.guardedTools : [])
  const shellMode = config.shellMode === 'allowlist' ? 'allowlist' : 'guard'
  const extraReadonlyShell = new Set(
    (Array.isArray(config.extraReadonlyShell) ? config.extraReadonlyShell : [])
      .map(name => String(name).toLowerCase()),
  )
  const extraShellGuard = (Array.isArray(config.extraShellGuard) ? config.extraShellGuard : [])
    .filter(Boolean)
    .map(String)
  const options = collectOptions(config)

  /** 新会话默认档：设置页写下的值优先于 cordis.patch.yml 的 defaultMode。 */
  const settingsFile = path.join(homedir(), '.dsh', 'plan-gate.json')
  let savedMode = null
  const effectiveDefault = () => (MODES.includes(savedMode) ? savedMode : defaultMode)
  const loadSettings = async () => {
    try {
      const raw = await fsp.readFile(settingsFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (MODES.includes(parsed?.defaultMode)) savedMode = parsed.defaultMode
    } catch { /* 没有设置文件就沿用 config */ }
  }
  void loadSettings()

  /** @type {Map<string, { enabled: boolean, phase: string, plan: unknown, awaitingAnswer: boolean }>} */
  const states = new Map()

  const stateOf = (sessionId) => {
    let state = states.get(sessionId)
    if (!state) {
      state = { mode: effectiveDefault(), phase: PHASE.IDLE, plan: null, awaitingAnswer: false, approvedAt: 0 }
      states.set(sessionId, state)
    }
    return state
  }

  /** 工具名 + 本次实参共同决定是否放行：只读工具、只读 shell 命令、只读 computer 动作。 */
  const isExempt = (toolName, args) => {
    if (guardedExtra.has(toolName)) return false
    if (readonlyExtra.has(toolName)) return true
    if (READONLY_TOOLS.has(toolName)) return true
    if (READONLY_PREFIXES.some(prefix => toolName.startsWith(prefix))) return true
    if (READONLY_SUFFIXES.some(suffix => toolName.endsWith(suffix))) return true
    if (toolName === 'pwsh' || toolName === 'bash' || toolName === 'shell') {
      const command = args?.command ?? args?.cmd ?? args?.script
      if (typeof command !== 'string') return false
      return shellMode === 'allowlist'
        ? isReadonlyShellCommand(command, extraReadonlyShell)
        : !shellNeedsApproval(command, extraShellGuard)
    }
    return readonlyByArgument(toolName, args)
  }

  const isRootAgent = (agent) => {
    try {
      return ctx.agents.roots().some(root => root.id === agent.id)
    } catch {
      return false
    }
  }

  // ── 1. 提示词：开关状态随 session 变化 ──────────────────────────────
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plan-gate.rules',
    order: 620,
    text: (assembly) => {
      const scope = assembly?.scope
      const sessionId = scope && typeof scope === 'object' ? scope.id : undefined
      if (!sessionId) return RULES_TEXT
      const state = stateOf(String(sessionId))
      return rulesFor(state.mode)
    },
  }), 'plan-gate: prompt section')

  // ── 2. 硬闸门 ────────────────────────────────────────────────────
  ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = String(exec?.name ?? '')
    if (!toolName) return next()
    if (isExempt(toolName, exec?.arguments)) return next()

    const agent = exec?.agent
    if (!agent || !isRootAgent(agent)) return next()

    const state = stateOf(String(agent.id))
    if (state.mode === MODE_OFF) return next()
    if (state.phase === PHASE.APPROVED) return next()

    return { kind: 'deny', reason: blockReason(toolName, state.phase, state.mode) }
  })

  // ── 3. 新一轮用户请求 → 回到待批准 ────────────────────────────────
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (!agent) return
    const state = stateOf(String(agent.id))
    if (state.awaitingAnswer || looksLikeAnswer(message)) {
      // 这条正是闸门自己那次提问的回答（可能晚一步 admit），别把状态清掉
      state.awaitingAnswer = false
      return
    }
    if (state.phase === PHASE.APPROVED && Date.now() - state.approvedAt < APPROVAL_GRACE_MS) return
    if (state.mode === MODE_OFF) return
    state.phase = PHASE.IDLE
    state.plan = null
    state.approvedAt = 0
  })

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent) states.delete(String(agent.id))
  })

  // ── 4. 模型可调用的三个工具 ───────────────────────────────────────
  ctx.tools.register({
    name: 'plan_gate_status',
    description: '查看本会话 Plan Gate 的状态：开关是否开启、当前阶段（idle/clarifying/proposed/approved）、最近一次方案标题。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(_args, exec) {
      const agent = exec?.agent
      if (!agent) return { text: 'PLAN_GATE：没有可用的会话上下文（工具不在 agent 作用域内调用）。' }
      const state = stateOf(String(agent.id))
      const plan = state.plan && typeof state.plan === 'object' ? state.plan : null
      return {
        text: JSON.stringify({
          mode: state.mode,
          enabled: state.mode !== MODE_OFF,
          phase: state.phase,
          planTitle: plan?.title ?? null,
          hint: state.mode === MODE_OFF
            ? '已关闭，不做拦截。'
            : (state.phase === PHASE.APPROVED
              ? '已批准，执行类工具放行。'
              : (state.mode === MODE_BRIEF
                ? '未批准：方案按精简格式提交（goal 一句话 + files 文件清单）。'
                : '未批准：执行类工具会被拦截，先 plan_gate_propose（必要时先用 ask_user_question 问清）。')),
        }, null, 2),
      }
    },
  })


  ctx.tools.register({
    name: 'plan_gate_propose',
    description: '提交执行方案并阻塞等待用户点「批准执行」。批准后执行类工具才放行。详细档：先用 goal 一句话总结打算做什么，再给步骤、涉及文件/产物、验收标准、风险与回滚；精简档：goal 一句话 + files 要改动的文件清单即可，changes / acceptance 可选。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '一句话方案名' },
        goal: { type: 'string', description: '一句话总结大概要做什么（两个档位都写）' },
        files: { type: 'array', items: { type: 'string' }, description: '要改动的文件、目录或产物路径（精简档主字段，一行一个）' },
        changes: { type: 'array', items: { type: 'string' }, description: '可选：一行一条改动，写清改哪个文件 / 哪一处 / 改成什么' },
        summary: { type: 'string', description: '可选：一段话说清做法与取舍' },
        steps: { type: 'array', items: { type: 'string' }, description: '按顺序的执行步骤' },
        acceptance: { type: 'array', items: { type: 'string' }, description: '怎么算做完（可验证的判据），精简档可省' },
        risks: { type: 'array', items: { type: 'string' }, description: '风险与回滚办法' },
        notes: { type: 'string', description: '其他需要用户知道的（依赖、成本、时间）' },
      },
      required: ['title'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' }, approved: { type: 'boolean' } },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args, exec) {
      const agent = exec?.agent
      if (!agent) return { text: 'PLAN_GATE：没有可用的会话上下文，无法发起方案确认。', approved: false }
      const state = stateOf(String(agent.id))
      const plan = {
        title: String(args?.title ?? '未命名方案'),
        changes: Array.isArray(args?.changes) ? args.changes.map(String) : undefined,
        goal: args?.goal,
        summary: args?.summary,
        steps: Array.isArray(args?.steps) ? args.steps.map(String) : undefined,
        files: Array.isArray(args?.files) ? args.files.map(String) : undefined,
        acceptance: Array.isArray(args?.acceptance) ? args.acceptance.map(String) : undefined,
        risks: Array.isArray(args?.risks) ? args.risks.map(String) : undefined,
        notes: args?.notes,
      }
      const brief = state.mode === MODE_BRIEF
      const markdown = brief ? renderPlanBrief(plan) : renderPlan(plan)
      state.plan = plan
      state.phase = PHASE.PROPOSED
      state.awaitingAnswer = true
      try {
        const result = await ctx.userQuestions.askTimed(
          {
            questions: [{
              id: 'approve',
              header: '方案确认',
              question: brief
                ? `按这 ${(plan.files ?? plan.changes ?? plan.steps ?? []).length} 个文件 / 改动执行？`
                : `是否按「${plan.title}」执行？`,
              detail: markdown,
              multiSelect: false,
              options: [
                { label: APPROVE_LABEL, description: '按方案开始动手' },
                { label: REVISE_LABEL, description: '先改方案，再确认' },
                { label: CANCEL_LABEL, description: '不做这件事了' },
              ],
              intent: { kind: 'plan-review', approve: APPROVE_LABEL },
            }],
            agent,
            signal: exec.signal,
            wait: { callId: exec.callId },
          },
          exec.callId,
          APPROVAL_TIMEOUT_MS,
        )
        if (result && result.pending === true) {
          state.phase = PHASE.IDLE
          state.plan = null
          state.approvedAt = 0
          return {
            approved: false,
            text: `PLAN_GATE：方案确认超时（${Math.round(APPROVAL_TIMEOUT_MS / 60000)} 分钟没有回答），已回到 idle，不要继续等待。\n需要方向时用 ask_user_question 提问，或等用户下一条消息再重新 plan_gate_propose。`,
          }
        }
        const verdict = describeAnswer(result)
        if (verdict.approved) {
          state.phase = PHASE.APPROVED
          state.approvedAt = Date.now()
          return {
            approved: true,
            text: `用户已批准方案「${plan.title}」（${verdict.text}）。阶段已进入 approved：执行类工具现在放行。\n按方案一次做完，不要擅自扩大范围；有偏差先说明。`,
          }
        }
        if (verdict.cancelled) {
          state.phase = PHASE.IDLE
          state.plan = null
          state.approvedAt = 0
          return { approved: false, text: `用户取消了「${plan.title}」。不要执行任何执行类动作；如需继续，问清方向后重新 plan_gate_propose。` }
        }
        state.phase = PHASE.CLARIFYING
        return {
          approved: false,
          text: `用户没有批准，回复是：${verdict.text}\n按这个要求调整方案，再次调用 plan_gate_propose；不要先执行。`,
        }
      } catch (error) {
        state.phase = PHASE.PROPOSED
        return { approved: false, text: `PLAN_GATE：方案确认没有完成（${error?.message ?? error}）。不要执行执行类动作。` }
      } finally {
        state.awaitingAnswer = false
      }
    },
  })

  // ── 5. 对话框按钮的读写端点 ──────────────────────────────────────
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = []
      if (typeof host.webServer?.register === 'function') {
        disposers.push(host.webServer.register({
          kind: 'exact',
          path: '/plan-gate/state',
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              res.writeHead(405, { allow: 'GET' })
              res.end()
              return
            }
            if (!sameOrigin(req)) {
              sendJson(res, 403, { error: 'origin not allowed' })
              return
            }
            try {
              const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
              const sessionId = url.searchParams.get('sessionId') ?? ''
              if (!sessionId) {
                sendJson(res, 400, { error: 'sessionId required' })
                return
              }
              const state = stateOf(sessionId)
              sendJson(res, 200, {
                mode: state.mode,
                enabled: state.mode !== MODE_OFF,
                modes: MODES,
                phase: state.phase,
                planTitle: state.plan && typeof state.plan === 'object' ? state.plan.title ?? null : null,
              })
            } catch (error) {
              sendJson(res, 500, { error: String(error?.message ?? error) })
            }
          },
        }))

        disposers.push(host.webServer.register({
          kind: 'exact',
          path: '/plan-gate/toggle',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              res.writeHead(405, { allow: 'POST' })
              res.end()
              return
            }
            if (!sameOrigin(req)) {
              sendJson(res, 403, { error: 'origin not allowed' })
              return
            }
            try {
              const body = await readJsonBody(req)
              const sessionId = String(body?.sessionId ?? '')
              if (!sessionId) {
                sendJson(res, 400, { error: 'sessionId required' })
                return
              }
              const state = stateOf(sessionId)
              const requested = typeof body?.mode === 'string' && MODES.includes(body.mode)
                ? body.mode
                : (body?.enabled === undefined ? null : (body.enabled ? MODE_DETAIL : MODE_OFF))
              if (requested) state.mode = requested
              if (state.mode === MODE_OFF) {
                state.phase = PHASE.IDLE
                state.plan = null
                state.approvedAt = 0
              }
              sendJson(res, 200, { mode: state.mode, enabled: state.mode !== MODE_OFF, phase: state.phase })
            } catch (error) {
              sendJson(res, 500, { error: String(error?.message ?? error) })
            }
          },
        }))
        disposers.push(host.webServer.register({
          kind: 'exact',
          path: '/plan-gate/handoff',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              res.writeHead(405, { allow: 'POST' })
              res.end()
              return
            }
            if (!sameOrigin(req)) {
              sendJson(res, 403, { error: 'origin not allowed' })
              return
            }
            try {
              const body = await readJsonBody(req)
              const sessionId = String(body?.sessionId ?? '')
              let root = String(body?.cwd ?? '')
              if (!root && sessionId) {
                // 优先用这条会话自己的 cwd，而不是 Host 进程的默认目录
                try {
                  const agent = ctx.get('agents')?.get(sessionId)
                  const workingDirectory = ctx.get('workingDirectory')
                  if (agent && workingDirectory) root = await workingDirectory.ensure(agent)
                } catch { /* fall through */ }
              }
              if (!root) root = ctx.get('workingDirectory')?.defaultDirectory || process.cwd()
              const state = sessionId
                ? stateOf(sessionId)
                : { mode: MODE_DETAIL, phase: PHASE.IDLE, plan: null }
              const planTitle = state.plan && typeof state.plan === 'object' ? state.plan.title ?? null : null
              const facts = sessionId
                ? await collectSessionFacts(sessionId, () => ctx.get('agents'))
                : null
              const text = await buildHandoff({
                root,
                sessionId: sessionId || '(unknown)',
                mode: state.mode,
                phase: state.phase,
                planTitle,
                facts,
                options,
              })
              const dir = path.join(homedir(), '.dsh', 'handoffs')
              await fsp.mkdir(dir, { recursive: true })
              const name = `handoff-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
              const file = path.join(dir, name)
              await fsp.writeFile(file, text, 'utf8')
              await pruneHandoffs(dir)
              sendJson(res, 200, { text, path: file, root })
            } catch (error) {
              sendJson(res, 500, { error: String(error?.message ?? error) })
            }
          },
        }))

        disposers.push(host.webServer.register({
          kind: 'exact',
          path: '/plan-gate/default-mode',
          handler: async (req, res) => {
            if (req.method !== 'GET' && req.method !== 'POST') {
              res.writeHead(405, { allow: 'GET, POST' })
              res.end()
              return
            }
            if (!sameOrigin(req)) {
              sendJson(res, 403, { error: 'origin not allowed' })
              return
            }
            try {
              if (req.method === 'POST') {
                const body = await readJsonBody(req)
                const next = String(body?.mode ?? '')
                if (!MODES.includes(next)) {
                  sendJson(res, 400, { error: `mode must be one of ${MODES.join(', ')}` })
                  return
                }
                savedMode = next
                await fsp.mkdir(path.dirname(settingsFile), { recursive: true })
                await fsp.writeFile(settingsFile, `${JSON.stringify({ defaultMode: next }, null, 2)}\n`, 'utf8')
              }
              sendJson(res, 200, {
                defaultMode: effectiveDefault(),
                modes: MODES,
                source: MODES.includes(savedMode) ? 'settings' : 'config',
              })
            } catch (error) {
              sendJson(res, 500, { error: String(error?.message ?? error) })
            }
          },
        }))
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      }
    }, 'plan-gate: web routes')
  })
}
