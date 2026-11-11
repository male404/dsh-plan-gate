window.__ModuleLoader__.load({
  id: '@local/plan-gate',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const NS = 'plan-gate'
    const MODES = ['off', 'detail', 'brief']
    const ARM_KEY = 'plangate-handoff-arm'
    const ARM_TTL_MS = 180_000

    const zh = {
      'mode.label': '先问后做',
      'mode.off': '先问后做 · 关闭',
      'mode.detail': '先问后做 · 详细',
      'mode.brief': '先问后做 · 精简',
      'mode.offHint': '不拦任何动作，直接执行。',
      'mode.detailHint': '执行前先出完整方案（目标/步骤/文件/验收/风险），点「批准执行」后才动手。',
      'mode.briefHint': '执行前只列改动的点（改哪个文件、改什么、怎么验），批准后动手。',
      'handoff.label': '移交新对话',
      'handoff.hint': '生成当前工作区的交接文档，新建一个会话并把文档预填进它的输入框。',
      'handoff.busy': '生成中…',
      'handoff.manual': '已填入本会话输入框：请新建会话后粘贴',
      'handoff.failed': '生成失败',
      'settings.title': '先问后做的默认档',
      'settings.hint': '新开的对话用这个档位；当前对话左侧下拉不受影响。',
      'settings.saved': '已保存',
      'settings.failed': '保存失败',
    }
    const en = {
      'mode.label': 'Plan gate',
      'mode.off': 'Plan gate · off',
      'mode.detail': 'Plan gate · detailed',
      'mode.brief': 'Plan gate · brief',
      'mode.offHint': 'No gating: actions run directly.',
      'mode.detailHint': 'Full plan first (goal / steps / files / acceptance / risks) before anything runs.',
      'mode.briefHint': 'Only the list of concrete changes before anything runs.',
      'handoff.label': 'Hand off',
      'handoff.hint': 'Build a workspace handoff document, open a new session and prefill its composer.',
      'handoff.busy': 'Building…',
      'handoff.manual': 'Filled into this composer: open a new session and paste it',
      'handoff.failed': 'Handoff failed',
      'settings.title': 'Default plan gate for new chats',
      'settings.hint': 'New conversations start in this mode; the picker in the current chat is unaffected.',
      'settings.saved': 'Saved',
      'settings.failed': 'Save failed',
    }

    const CSS = `
.plangate-select {
  height: 26px;
  max-width: 168px;
  padding: 0 6px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35));
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition: border-color .12s ease, color .12s ease, background .12s ease;
}
.plangate-select:hover {
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12));
  color: var(--dsw-alias-label-primary, #111827);
}
.plangate-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #247bbf); outline-offset: 1px; }
.plangate-select.is-on { border-color: var(--dsw-alias-brand-primary, #247bbf); color: var(--dsw-alias-brand-primary, #247bbf); }
.plangate-select:disabled { opacity: .6; cursor: default; }
.plangate-select option { background: var(--dsw-alias-bg-overlay, #ffffff); color: var(--dsw-alias-label-primary, #111827); }
.plangate-handoff {
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35));
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background .12s ease, border-color .12s ease, color .12s ease;
}
.plangate-handoff:hover {
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12));
  color: var(--dsw-alias-label-primary, #111827);
  border-color: var(--dsw-alias-border-l2, rgba(127,127,127,.55));
}
.plangate-handoff:disabled { opacity: .6; cursor: default; }
.plangate-note { font-size: 11px; color: var(--dsw-alias-state-warn-primary, #b45309); white-space: nowrap; }
.plangate-settings { display: flex; flex-direction: column; gap: 8px; padding: 4px 0 12px; }
.plangate-settings-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #111827); }
.plangate-settings-hint { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); }
.plangate-settings-row { display: flex; align-items: center; gap: 10px; }
`

    function readArm() {
      try {
        const raw = sessionStorage.getItem(ARM_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed.text !== 'string') return null
        if (Date.now() - Number(parsed.at || 0) > ARM_TTL_MS) {
          sessionStorage.removeItem(ARM_KEY)
          return null
        }
        return parsed
      } catch {
        return null
      }
    }

    function writeArm(text, fromSession) {
      try {
        sessionStorage.setItem(ARM_KEY, JSON.stringify({ text, at: Date.now(), fromSession }))
      } catch { /* ignore */ }
    }

    function clearArm() {
      try { sessionStorage.removeItem(ARM_KEY) } catch { /* ignore */ }
    }

    function fillDraft(host, sessionId, text, inputActions) {
      let filled = false
      try {
        if (inputActions && typeof inputActions.setDraft === 'function') {
          inputActions.setDraft(text)
          filled = true
        }
      } catch { /* ignore */ }
      try {
        const api = host && typeof host.get === 'function'
          ? host.get('conversation')?.input?.shell?.(sessionId)
          : undefined
        if (api && typeof api.setDraft === 'function') {
          api.setDraft(text)
          filled = true
        }
      } catch { /* ignore */ }
      return filled
    }

    async function requestJson(url, init) {
      const response = await fetch(url, {
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(init && init.body ? { 'content-type': 'application/json' } : {}) },
        ...init,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    function GateSelect(props) {
      const sessionId = props && props.sessionId
      const t = (props && props.t) || ((key) => key)
      const [mode, setMode] = useState('detail')
      const [known, setKnown] = useState(false)
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        if (!sessionId) return undefined
        let alive = true
        requestJson(`/plan-gate/state?sessionId=${encodeURIComponent(String(sessionId))}`)
          .then((value) => {
            if (!alive) return
            if (MODES.includes(value.mode)) setMode(value.mode)
            setKnown(true)
          })
          .catch(() => { if (alive) setKnown(false) })
        return () => { alive = false }
      }, [sessionId])

      const change = useCallback((event) => {
        const next = event && event.target ? event.target.value : mode
        if (!sessionId || busy || !MODES.includes(next)) return
        const previous = mode
        setMode(next)
        setBusy(true)
        requestJson('/plan-gate/toggle', {
          method: 'POST',
          body: JSON.stringify({ sessionId: String(sessionId), mode: next }),
        })
          .then((value) => { if (MODES.includes(value.mode)) setMode(value.mode) })
          .catch(() => setMode(previous))
          .finally(() => setBusy(false))
      }, [busy, mode, sessionId])

      if (!sessionId) return null

      return h(React.Fragment, null,
        h('style', { key: 'style' }, CSS),
        h('select', {
          key: 'select',
          className: 'plangate-select' + (mode === 'off' ? '' : ' is-on'),
          value: mode,
          title: t(`mode.${mode}Hint`),
          'aria-label': t('mode.label'),
          disabled: busy || !known,
          onChange: change,
        },
          MODES.map(item => h('option', { key: item, value: item }, t(`mode.${item}`)))))
    }

    function HandoffButton(props) {
      const sessionId = props && props.sessionId
      const t = (props && props.t) || ((key) => key)
      const host = props && props.host
      const inputActions = props && props.inputActions
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')

      // 新会话挂载后，把待填文档写进它的输入框（不依赖拿到新会话 id）
      useEffect(() => {
        if (!sessionId) return undefined
        const arm = readArm()
        if (!arm || arm.fromSession === String(sessionId)) return undefined
        let stopped = false
        const timers = []
        const attempt = () => {
          if (stopped) return
          if (fillDraft(host, String(sessionId), arm.text, inputActions)) {
            clearArm()
            stopped = true
          }
        }
        for (const ms of [200, 600, 1200, 2400, 4000, 6000, 8000, 10000]) timers.push(window.setTimeout(attempt, ms))
        return () => {
          stopped = true
          for (const timer of timers) { try { window.clearTimeout(timer) } catch { /* ignore */ } }
        }
      }, [sessionId, host, inputActions])

      const click = useCallback(async () => {
        if (!sessionId || busy) return
        setBusy(true)
        setNote('')
        try {
          const data = await requestJson('/plan-gate/handoff', {
            method: 'POST',
            body: JSON.stringify({ sessionId: String(sessionId) }),
          })
          if (!data || !data.text) throw new Error('empty handoff')
          writeArm(data.text, String(sessionId))
          const uiWorkspace = host && typeof host.get === 'function' ? host.get('uiWorkspace') : undefined
          if (uiWorkspace && typeof uiWorkspace.startSession === 'function') {
            uiWorkspace.startSession()
          } else {
            fillDraft(host, String(sessionId), data.text, inputActions)
            clearArm()
            setNote(t('handoff.manual'))
          }
        } catch {
          clearArm()
          setNote(t('handoff.failed'))
        } finally {
          setBusy(false)
        }
      }, [busy, sessionId, host, inputActions, t])

      if (!sessionId) return null

      return h(React.Fragment, null,
        h('style', { key: 'style' }, CSS),
        h('button', {
          key: 'button',
          type: 'button',
          className: 'plangate-handoff',
          title: t('handoff.hint'),
          disabled: busy,
          onClick: click,
        }, busy ? t('handoff.busy') : t('handoff.label')),
        note ? h('span', { key: 'note', className: 'plangate-note' }, note) : null)
    }

    function GateDefaultsSection(props) {
      const t = (props && props.t) || ((key) => key)
      const [mode, setMode] = useState('detail')
      const [known, setKnown] = useState(false)
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')

      useEffect(() => {
        let alive = true
        requestJson('/plan-gate/default-mode')
          .then((value) => {
            if (!alive) return
            if (MODES.includes(value.defaultMode)) setMode(value.defaultMode)
            setKnown(true)
          })
          .catch(() => { if (alive) setKnown(false) })
        return () => { alive = false }
      }, [])

      const change = useCallback((event) => {
        const next = event && event.target ? event.target.value : ''
        if (!MODES.includes(next) || busy) return
        const previous = mode
        setMode(next)
        setBusy(true)
        setNote('')
        requestJson('/plan-gate/default-mode', {
          method: 'POST',
          body: JSON.stringify({ mode: next }),
        })
          .then((value) => {
            if (MODES.includes(value.defaultMode)) setMode(value.defaultMode)
            setNote(t('settings.saved'))
          })
          .catch(() => {
            setMode(previous)
            setNote(t('settings.failed'))
          })
          .finally(() => setBusy(false))
      }, [busy, mode, t])

      return h(React.Fragment, null,
        h('style', { key: 'style' }, CSS),
        h('div', { key: 'body', className: 'plangate-settings' },
          h('div', { className: 'plangate-settings-title' }, t('settings.title')),
          h('div', { className: 'plangate-settings-hint' }, t('settings.hint')),
          h('div', { className: 'plangate-settings-row' },
            h('select', {
              className: 'plangate-select' + (mode === 'off' ? '' : ' is-on'),
              value: mode,
              disabled: busy || !known,
              onChange: change,
            }, MODES.map((item) => h('option', { key: item, value: item }, t(`mode.${item}`)))),
            note ? h('span', { className: 'plangate-note' }, note) : null)))
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plan-gate: dictionaries')
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'plan-gate-toggle',
        order: 18,
        label: () => ctx.locale.bind(NS)('mode.label'),
        inject: (sessionId) => ({ sessionId, t: ctx.locale.bind(NS), host: ctx }),
      }, GateSelect))
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'plan-gate-handoff',
        order: 19,
        label: () => ctx.locale.bind(NS)('handoff.label'),
        inject: (sessionId) => ({ sessionId, t: ctx.locale.bind(NS), host: ctx }),
      }, HandoffButton))
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'plan-gate',
        order: 17,
        label: () => ctx.locale.bind(NS)('settings.title'),
        locale: NS,
        inject: () => ({ t: ctx.locale.bind(NS) }),
      }, GateDefaultsSection))
    }

    return { name: NS, inject: ['slots', 'locale'], apply }
  },
})
