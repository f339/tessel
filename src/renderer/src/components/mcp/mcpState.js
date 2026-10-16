// The state of Settings > MCP servers, shared by its tabs (McpDialog.vue
// makes one and hands it to McpInstalled, McpCatalog and McpCustom): every
// agent's servers, the tests, and the actions that change an agent's
// settings. Claude Code and Codex stdio servers are changed through their own
// CLI; Codex HTTP servers and the other agents in their settings file, in the
// format each expects (src/main/jsonAgents.js, codexMcpConfig.js).
import { ref, reactive, computed, inject } from 'vue'
import { t } from '../../i18n'
import { MCP_CATALOG } from '../../mcpCatalog'
import { ALL_AGENTS, AGENT_NAME, agentList, testState } from './mcpShared'

export function useMcpState(props, emit) {
  // One (empty until read) list per agent: the page draws before the lists
  // arrive, so every agent it names must have one.
  const lists = reactive(Object.fromEntries(ALL_AGENTS.map((a) => [a, []])))
  const listOf = (agent) => (Array.isArray(lists[agent]) ? lists[agent] : [])
  const listErrors = reactive({}) // agent -> why its servers could not be read
  const loadError = ref('') // the whole read failed
  const loading = ref(true)
  const loaded = ref(false) // a first read has answered
  const busy = ref('') // key of the action in progress
  const message = reactive({ text: '', kind: 'ok', detail: '' })
  const tests = reactive({}) // "agent:scope:name" -> result
  const haveCmd = reactive({}) // 'node' / 'uvx' -> bool

  const installed = computed(() =>
    Object.fromEntries(ALL_AGENTS.map((id) => [id, !!props.agents.find((a) => a.id === id && a.available)]))
  )
  // The agents shown: installed here, or already holding servers (Claude Code
  // and Codex when nothing is detected, so the page is never empty).
  const AGENTS = computed(() => {
    const shown = ALL_AGENTS.filter((a) => installed.value[a] || listOf(a).length)
    return shown.length ? shown : ['claude', 'codex']
  })
  // The agents installed here (the add bars' chips), and those a server can
  // be added to: not one whose settings could not be read (a write would
  // fail, or worse).
  const addable = computed(() => AGENTS.value.filter((a) => installed.value[a]))
  const writable = computed(() => addable.value.filter((a) => !listErrors[a]))

  const catalogById = Object.fromEntries(MCP_CATALOG.map((e) => [e.id, e]))

  // One row per server name: which agents have it, and what they run.
  const rows = computed(() => {
    const map = new Map()
    for (const agent of AGENTS.value) {
      for (const s of listOf(agent)) {
        if (!map.has(s.name)) {
          map.set(s.name, { name: s.name, target: s.target, type: s.type, by: {}, agents: [], types: [], envKeys: [], headerKeys: [], entry: catalogById[s.name] || null })
        }
        const row = map.get(s.name)
        row.by[agent] = s
        row.agents.push(agent)
        if (!row.types.includes(s.type)) row.types.push(s.type)
        for (const k of s.envKeys || []) if (!row.envKeys.includes(k)) row.envKeys.push(k)
        for (const k of s.headerKeys || []) if (!row.headerKeys.includes(k)) row.headerKeys.push(k)
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  })

  function say(text, kind = 'ok', detail = '') {
    message.text = text
    message.kind = kind
    message.detail = detail || ''
  }

  async function refresh() {
    loading.value = true
    try {
      const res = await window.shellApi.mcpList(props.cwd)
      loadError.value = ''
      lists.claude = (res && res.claude) || []
      lists.codex = (res && res.codex) || []
      if (res && res.codexError) listErrors.codex = res.codexError
      else delete listErrors.codex
      for (const [agent, r] of Object.entries((res && res.others) || {})) {
        lists[agent] = (r && r.servers) || []
        if (r && r.error) listErrors[agent] = r.error
        else delete listErrors[agent]
      }
    } catch (err) {
      loadError.value = (err && err.message) || String(err)
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  // Whether node / uvx are installed (a catalog server may need one). Never
  // throws: a failed check leaves the warning out.
  async function checkTools() {
    if (!window.shellApi.checkTools) return
    try {
      Object.assign(haveCmd, (await window.shellApi.checkTools(['node', 'uvx'])) || {})
    } catch {
      // unknown: no warning
    }
  }

  const testKey = (agent, s) => `${agent}:${s.scope}:${s.name}`
  const testOf = (agent, s) => (s ? tests[testKey(agent, s)] : null)

  async function test(agent, s) {
    const key = testKey(agent, s)
    tests[key] = { status: 'testing' }
    try {
      tests[key] = await window.shellApi.mcpTest({ agent, name: s.name, scope: s.scope, cwd: props.cwd })
    } catch (err) {
      tests[key] = { status: 'error', error: err.message }
    }
  }
  const testServer = (row) => Promise.all(row.agents.map((a) => test(a, row.by[a])))
  const testAll = () => Promise.all(rows.value.map(testServer))

  // A server's dot: the worst of its last tests (none until one ran).
  function rowState(row) {
    const states = row.agents.map((a) => testState(testOf(a, row.by[a]))).filter(Boolean)
    if (!states.length) return null
    for (const s of ['testing', 'error', 'auth']) if (states.includes(s)) return s
    return 'ok'
  }

  async function copyTo(row, to) {
    // From an agent that has it (the first one shown).
    const from = row.agents.find((a) => a !== to)
    if (!from) return
    busy.value = `copy:${row.name}:${to}` // i18n-ignore
    try {
      const res = await window.shellApi.mcpCopy({ from, to, name: row.name, scope: row.by[from].scope, cwd: props.cwd })
      if (res && res.ok) {
        say(
          t('mcp.copy.added', 'Added "{{name}}" to {{agent}}.{{note}} Restart running {{agent}} panes to load it.', {
            name: row.name,
            agent: AGENT_NAME[to],
            note: res.note ? ' ' + res.note : ''
          })
        )
      } else {
        say(t('mcp.copy.failedFor', 'Could not add "{{name}}" to {{agent}}.', { name: row.name, agent: AGENT_NAME[to] }), 'error', res && res.error)
      }
    } catch (err) {
      say(t('mcp.copy.failedFor', 'Could not add "{{name}}" to {{agent}}.', { name: row.name, agent: AGENT_NAME[to] }), 'error', err && err.message)
    } finally {
      busy.value = ''
    }
    refresh()
  }

  // Tessel's own confirmation (falls back to the system one outside the app).
  const askConfirm = inject('askConfirm', (o) => Promise.resolve(window.confirm(o.title)))

  async function remove(agent, s) {
    const ok = await askConfirm({
      title: t('mcp.remove.confirm', 'Remove "{{name}}" from {{agent}}?', { name: s.name, agent: AGENT_NAME[agent] }),
      confirmLabel: t('mcp.remove.button', 'Remove'),
      danger: true
    })
    if (!ok) return
    busy.value = `rm:${agent}:${s.name}` // i18n-ignore
    try {
      const res = await window.shellApi.mcpRemove({ agent, name: s.name, scope: s.scope, cwd: props.cwd })
      if (res && res.ok) say(t('mcp.remove.done', 'Removed "{{name}}" from {{agent}}.', { name: s.name, agent: AGENT_NAME[agent] }))
      else say(t('mcp.remove.failedFor', 'Could not remove "{{name}}" from {{agent}}.', { name: s.name, agent: AGENT_NAME[agent] }), 'error', res && res.error)
    } catch (err) {
      say(t('mcp.remove.failedFor', 'Could not remove "{{name}}" from {{agent}}.', { name: s.name, agent: AGENT_NAME[agent] }), 'error', err && err.message)
    } finally {
      busy.value = ''
    }
    delete tests[testKey(agent, s)]
    refresh()
  }

  // Signing in opens a browser and waits for its redirect: it runs in a pane
  // the user sees (never in a hidden process), for the CLIs that have a
  // command for it. Names are letters, digits, - and _ (checked when added).
  function signIn(agent, name) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(name))) return
    if (agent === 'codex') {
      emit('run', { label: t('mcp.signIn.pane', 'Sign in: {{name}}', { name }), command: `codex mcp login ${name}` }) // i18n-ignore
    } else if (agent === 'opencode') {
      emit('run', { label: t('mcp.signIn.pane', 'Sign in: {{name}}', { name }), command: `opencode mcp auth ${name}` }) // i18n-ignore
    } else if (agent === 'gemini' || agent === 'qwen') {
      say(t('mcp.signIn.gemini', 'In a {{agent}} pane, type /mcp auth {{name}}. Your browser opens to sign in.', { name, agent: AGENT_NAME[agent] }))
    } else if (agent !== 'claude') {
      say(t('mcp.signIn.other', 'Sign in to "{{name}}" from a {{agent}} pane (its own MCP command), or set the server\'s API key.', { name, agent: AGENT_NAME[agent] }))
    } else {
      say(t('mcp.signIn.claude', 'In a Claude Code pane, type /mcp, pick "{{name}}" and choose Authenticate. Your browser opens to sign in.', { name }))
    }
  }

  // The agents that already have a server of this name.
  const addedTo = (name) => AGENTS.value.filter((a) => listOf(a).some((s) => s.name === name))
  // "Added" only when every agent it can be added to has it.
  function fullyAdded(name) {
    const has = addedTo(name)
    return writable.value.length > 0 && writable.value.every((a) => has.includes(a))
  }
  // agent -> why the add bars cannot choose it ({} when all can).
  const unwritable = computed(() =>
    Object.fromEntries(addable.value.filter((a) => listErrors[a]).map((a) => [a, t('mcp.addbar.unreadable', 'Its MCP settings could not be read')]))
  )

  // Each chosen agent in turn; one failing never stops the others.
  //   -> { agent: { state: 'added'|'failed', error } }
  async function addToAgents(chosen, specFor) {
    const out = {}
    for (const agent of chosen) {
      let res
      try {
        res = await window.shellApi.mcpAdd(specFor(agent))
      } catch (err) {
        res = { ok: false, error: err && err.message }
      }
      out[agent] = res && res.ok ? { state: 'added' } : { state: 'failed', error: (res && res.error) || t('mcp.addFailed', 'failed') }
    }
    return out
  }
  const addedNames = (out) =>
    Object.keys(out)
      .filter((a) => out[a].state !== 'failed')
      .map((a) => AGENT_NAME[a])
  const failuresText = (out) =>
    Object.entries(out)
      .filter(([, r]) => r.state === 'failed')
      .map(([a, r]) => `${AGENT_NAME[a]}: ${r.error}`)
      .join('\n')

  // After adding: test the server for each agent that has it; one that
  // answers only after a sign-in shows "Needs sign-in" (with Sign in).
  async function checkAdded(name, out) {
    await refresh()
    await Promise.all(
      Object.keys(out)
        .filter((a) => out[a].state === 'added')
        .map(async (agent) => {
          const s = listOf(agent).find((x) => x.name === name)
          if (!s) {
            out[agent] = { state: 'failed', error: t('mcp.addNotListed', '{{agent}} does not list it.', { agent: AGENT_NAME[agent] }) }
            return
          }
          await test(agent, s)
          const r = tests[testKey(agent, s)]
          if (r && r.status === 'auth') out[agent] = { state: 'auth', error: r.error }
        })
    )
  }

  // reactive(): its refs read as plain values in the tabs' templates.
  return reactive({
    lists,
    listOf,
    listErrors,
    loadError,
    loading,
    loaded,
    busy,
    message,
    tests,
    haveCmd,
    installed,
    AGENTS,
    addable,
    writable,
    unwritable,
    rows,
    catalogById,
    say,
    refresh,
    checkTools,
    testKey,
    testOf,
    test,
    testServer,
    testAll,
    rowState,
    copyTo,
    remove,
    signIn,
    addedTo,
    fullyAdded,
    addToAgents,
    addedNames,
    failuresText,
    checkAdded,
    agentList
  })
}
