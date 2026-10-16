// Settings > Context: what each agent loads into its context before the
// user types anything, and what it costs in tokens, so the user sees why an
// agent starts heavy and what to turn off:
//   rules     its rules and memory files (rulesFiles.js);
//   skills    each skill's name and description, which the agent lists up
//             front (its SKILL.md is read only when the skill is used);
//   mcp       each MCP server's tool definitions, in every conversation,
//             once measured (starting the server is a click: Measure);
//   tessel    Tessel's team tools (their instructions and definitions) and
//             its task board rule in the memory file.
// Not counted: the agent's own system prompt and built-in tools.
// Counting (counts.js) runs in its own process or, for models with no public
// tokenizer, through the provider's count API, only on view or click.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { tokenCounterFor, TOKENIZERS } from '../../shared/tokenCounters'
import { readRules, createFileReader, findGitRoot, RULE_AGENTS } from './rulesFiles'
import { TOKENIZER_FILES } from './catalog'
import { ollamaName, ollamaCounter } from './ollama'

export const CONTEXT_AGENTS = RULE_AGENTS
export const TEAM_SERVER = 'tessel-team'
const MCP_RECORD_LIMIT = 2 * 1024 * 1024
const LIST_TTL_MS = 60 * 1000

const sha = (text) => createHash('sha256').update(text).digest('hex')
// A tool name an API takes: letters, digits, _ and -, 64 at most.
const toolName = (name) => String(name || 'tool').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool'

// A server's tools as the agent presents them (Claude Code names them
// mcp__<server>__<tool>), in the shape the counters take.
export function shapeTools(server, defs, agent) {
  const seen = new Set()
  return (defs || []).map((d, i) => {
    let name = toolName(agent === 'claude' ? `mcp__${server}__${d.name}` : d.name)
    if (seen.has(name)) name = toolName(`${name.slice(0, 58)}_${i}`)
    seen.add(name)
    const schema = d.inputSchema && typeof d.inputSchema === 'object' ? d.inputSchema : { type: 'object', properties: {} }
    return { name, description: String(d.description || ''), input_schema: schema.type ? schema : { type: 'object', ...schema } }
  })
}

// The line an agent lists a skill with.
export const skillLine = (skill) => `- ${skill.name}: ${skill.description || ''}`.trimEnd()

// The MCP servers listMcp found for an agent (agentTools.js), loaded ones.
export function agentServers(listed, agent) {
  if (!listed) return []
  const list = agent === 'claude' ? listed.claude : agent === 'codex' ? listed.codex : listed.others && listed.others[agent] && listed.others[agent].servers
  return (Array.isArray(list) ? list : []).filter((s) => s && typeof s.name === 'string')
}

// The totals of one agent's items (counted ones). -> { total, groups: { rules,
// skills, mcp, tessel }, exact: 'all' | 'some' | 'none', optional, pending }
export function summarize(items) {
  const groups = { rules: 0, skills: 0, mcp: 0, tessel: 0 }
  let total = 0
  let exactCount = 0
  let counted = 0
  let optional = 0
  let pending = 0
  for (const item of items) {
    if (!item.loaded) continue
    if (!item.result) {
      pending++
      continue
    }
    const n = item.result.tokens || 0
    groups[item.group] = (groups[item.group] || 0) + n
    total += n
    counted++
    if (item.result.exact) exactCount++
    if (item.optional) optional += n
  }
  return { total, groups, optional, pending, exact: !counted ? 'none' : exactCount === counted ? 'all' : exactCount ? 'some' : 'none' }
}

export function createContextCost({
  userData,
  counter,
  worker,
  files,
  apis = {},
  listSkills,
  listMcp,
  testMcp,
  agentModel = () => null,
  claudeDir = async () => null,
  home = os.homedir(),
  env = () => process.env,
  request = globalThis.fetch,
  log = null
}) {
  const reader = createFileReader()
  // The skill and server lists, read again after LIST_TTL_MS or when counting
  // over the network (a page opened, a click): a pane card's hover reuses
  // them rather than walking the folders and running codex mcp list again.
  const lists = new Map() // `${kind}|${cwd}` -> { at, promise }
  function listed(kind, cwd, fresh, read) {
    const key = `${kind}|${cwd || ''}`
    const seen = lists.get(key)
    if (!fresh && seen && Date.now() - seen.at < LIST_TTL_MS) return seen.promise
    const promise = Promise.resolve()
      .then(read)
      .catch(() => null)
    lists.set(key, { at: Date.now(), promise })
    return promise
  }
  const skillsOf = (cwd, fresh) => listed('skills', cwd, fresh, () => listSkills({ cwd })).then((r) => (r && r.skills) || [])
  const mcpOf = (cwd, fresh) => listed('mcp', cwd, fresh, () => listMcp(cwd))
  const mcpDir = path.join(userData, 'context-cost', 'mcp')
  let tessel = null // { instructions, tools } from the counting process

  async function tesselContext() {
    if (tessel) return tessel
    const reply = await worker.request({ op: 'tessel' })
    if (reply && reply.tessel) tessel = reply.tessel
    return tessel
  }

  const mcpKey = (agent, s, cwd) => sha(JSON.stringify([agent, s.scope || 'user', s.name, s.scope === 'user' ? '' : String(cwd || '').toLowerCase(), s.target || '']))
  async function mcpRecord(agent, s, cwd) {
    try {
      return JSON.parse(await fs.readFile(path.join(mcpDir, `${mcpKey(agent, s, cwd)}.json`), 'utf8'))
    } catch {
      return null
    }
  }

  const modelOf = (agent, cwd, given) => {
    if (typeof given === 'string' && given) return given
    try {
      const found = agentModel({ agentId: agent, cwd })
      return found && found.model ? found.model : null
    } catch {
      return null
    }
  }

  // The counter for an agent's model; an Ollama model tokenCounters.js does
  // not place is asked about (ollama.js), else Ollama counts it itself.
  async function resolveCounter(agent, model) {
    const base = tokenCounterFor(model, agent)
    const name = ollamaName(agent, model)
    if (!name || base.kind !== 'estimate') return base
    const viaShow = await ollamaCounter(name, { request }).catch(() => null)
    if (viaShow) return { ...viaShow, defaulted: base.defaulted }
    return { kind: 'api', api: 'ollama', id: `ollama:${name}`, model: name, factor: base.factor, factorKey: 'other', defaulted: base.defaulted }
  }

  // One agent's items, before counting.
  async function itemsFor(agent, { cwd, skills, mcp }) {
    const items = []
    const dir = agent === 'claude' ? await claudeDir().catch(() => null) : null
    const rules = await readRules(agent, { cwd, home, env: env(), claudeDir: dir, gitRoot: cwd ? await findGitRoot(cwd) : null }, reader)
    for (const r of rules) {
      if (!r.text || !r.text.trim()) continue
      items.push({
        key: r.id,
        group: r.tessel ? 'tessel' : 'rules',
        type: r.tessel ? 'boardRule' : 'file',
        label: path.basename(r.path),
        path: r.path,
        scope: r.scope,
        note: r.note,
        loaded: r.loaded,
        optional: true,
        kind: 'text',
        text: r.text
      })
    }
    for (const s of skills) {
      if (!Array.isArray(s.seenBy) || !s.seenBy.includes(agent)) continue
      items.push({ key: `skill:${s.skillFile}`, group: 'skills', type: 'skill', label: s.name, path: s.skillFile, scope: s.scope, loaded: true, optional: true, kind: 'text', text: skillLine(s) })
    }
    const servers = agentServers(mcp, agent)
    for (const s of servers) {
      if (s.name === TEAM_SERVER) continue
      const off = s.enabled === false
      const record = off ? null : await mcpRecord(agent, s, cwd)
      const base = { key: `mcp:${agent}:${s.scope || 'user'}:${s.name}`, group: 'mcp', type: 'mcp', label: s.name, scope: s.scope || 'user', optional: true, ref: { agent, name: s.name, scope: s.scope || 'user' } }
      if (off) items.push({ ...base, loaded: false, note: 'off' })
      else if (record && Array.isArray(record.defs)) items.push({ ...base, loaded: true, kind: 'tools', tools: shapeTools(s.name, record.defs, agent), toolCount: record.defs.length, measuredAt: record.at })
      else items.push({ ...base, loaded: true, note: 'notMeasured' })
    }
    if (servers.some((s) => s.name === TEAM_SERVER && s.enabled !== false)) {
      const team = await tesselContext()
      if (team) {
        items.push({ key: 'tessel:instructions', group: 'tessel', type: 'teamInstructions', label: TEAM_SERVER, loaded: true, optional: true, kind: 'text', text: team.instructions })
        items.push({ key: 'tessel:tools', group: 'tessel', type: 'teamTools', label: TEAM_SERVER, loaded: true, optional: true, kind: 'tools', tools: shapeTools(TEAM_SERVER, team.tools.map((tl) => ({ ...tl, inputSchema: tl.inputSchema })), agent), toolCount: team.tools.length })
      }
    }
    return items
  }

  // What leaves this function: labels, paths, counts. Never a file's text.
  const publicItem = (item) => {
    const rest = { ...item }
    delete rest.text
    delete rest.tools
    return rest
  }

  async function countItems(items, counterInfo, remote) {
    const countable = items.filter((i) => i.kind && (i.kind === 'text' ? !!i.text : true))
    const results = countable.length ? await counter.count(countable, counterInfo, { remote }) : {}
    return items.map((item) => ({ ...item, result: results[item.key] || null }))
  }

  return {
    // agents: [{ id, model? }]. -> { agents: [{ id, model, counter, items, summary }] }
    async summary({ cwd = null, agents = [], remote = false } = {}) {
      const wanted = agents.filter((a) => a && CONTEXT_AGENTS.includes(a.id))
      const [skillList, mcp] = await Promise.all([skillsOf(cwd, remote), wanted.length ? mcpOf(cwd, remote) : null])
      const out = []
      for (const a of wanted) {
        const model = modelOf(a.id, cwd, a.model)
        const counterInfo = await resolveCounter(a.id, model)
        const items = await countItems(await itemsFor(a.id, { cwd, skills: skillList, mcp }), counterInfo, remote)
        out.push({ id: a.id, model: counterInfo.model, defaulted: counterInfo.defaulted, counter: counterInfo, items: items.map(publicItem), summary: summarize(items) })
      }
      return { agents: out }
    },

    // The Skills page's tags: each skill's up-front cost for the first agent
    // that reads it. -> { [skillFile]: { agent, counter, result } }
    async skills({ cwd = null, agents = null, remote = false } = {}) {
      const list = await skillsOf(cwd, remote)
      const order = CONTEXT_AGENTS
      const byAgent = new Map()
      for (const s of list) {
        const agent = order.find((a) => (s.seenBy || []).includes(a) && (!agents || agents.includes(a)))
        if (!agent) continue
        if (!byAgent.has(agent)) byAgent.set(agent, [])
        byAgent.get(agent).push(s)
      }
      const out = {}
      for (const [agent, skills] of byAgent) {
        const counterInfo = await resolveCounter(agent, modelOf(agent, cwd))
        const results = await counter.count(skills.map((s) => ({ key: s.skillFile, kind: 'text', text: skillLine(s) })), counterInfo, { remote })
        for (const s of skills) out[s.skillFile] = { agent, model: counterInfo.model, counter: counterInfo, result: results[s.skillFile] || null }
      }
      return out
    },

    // One skill's details: for each agent that reads it, the up-front cost
    // and its whole SKILL.md (read when the skill is used).
    async skillDetail({ cwd = null, skillFile, agents = null, remote = false } = {}) {
      const list = await skillsOf(cwd, false)
      const skill = list.find((s) => s.skillFile === skillFile)
      if (!skill) return { rows: [] }
      const md = await reader.read(skill.skillFile)
      const rows = []
      for (const agent of CONTEXT_AGENTS.filter((a) => (skill.seenBy || []).includes(a) && (!agents || agents.includes(a)))) {
        const counterInfo = await resolveCounter(agent, modelOf(agent, cwd))
        const items = [{ key: 'upfront', kind: 'text', text: skillLine(skill) }]
        if (md && md.text) items.push({ key: 'full', kind: 'text', text: md.text })
        const results = await counter.count(items, counterInfo, { remote })
        rows.push({ agent, model: counterInfo.model, counter: counterInfo, upfront: results.upfront || null, full: results.full || null })
      }
      return { rows }
    },

    // Settings > MCP servers' and Context's Measure: starts the server (or
    // connects to it) the way Test does, keeps its tool definitions, counts
    // them for the agent's model.
    async measureMcp({ agent, name, scope = 'user', cwd = null, model = null } = {}) {
      if (!CONTEXT_AGENTS.includes(agent) || typeof name !== 'string') return { ok: false, error: 'unknown server' } // i18n-ignore internal
      const servers = await mcpOf(cwd, true)
      const s = agentServers(servers, agent).find((x) => x.name === name && (x.scope || 'user') === scope)
      if (!s) return { ok: false, error: 'unknown server' } // i18n-ignore internal
      const res = await testMcp({ agent, name, scope, cwd }, { defs: true })
      if (!res || !res.ok || !Array.isArray(res.defs)) return { ok: false, status: res && res.status, error: (res && res.error) || null }
      const record = { at: Date.now(), defs: res.defs }
      const text = JSON.stringify(record)
      if (text.length <= MCP_RECORD_LIMIT) {
        await fs.mkdir(mcpDir, { recursive: true })
        await fs.writeFile(path.join(mcpDir, `${mcpKey(agent, s, cwd)}.json`), text)
      }
      const counterInfo = await resolveCounter(agent, modelOf(agent, cwd, model))
      const results = await counter.count([{ key: 'tools', kind: 'tools', tools: shapeTools(name, res.defs, agent) }], counterInfo, { remote: true })
      log?.info?.('context', `measured ${agent} MCP server ${name}: ${res.defs.length} tool(s)`) // i18n-ignore
      return { ok: true, tools: res.defs.length, counter: counterInfo, result: results.tools || null, at: record.at }
    },

    // The cached measurements of the MCP page's rows (no server started).
    async mcpMeasures({ cwd = null } = {}) {
      const all = await mcpOf(cwd, false)
      const out = {}
      for (const agent of CONTEXT_AGENTS) {
        const servers = agentServers(all, agent).filter((s) => s.name !== TEAM_SERVER)
        if (!servers.length) continue
        const counterInfo = await resolveCounter(agent, modelOf(agent, cwd))
        for (const s of servers) {
          const record = await mcpRecord(agent, s, cwd)
          if (!record || !Array.isArray(record.defs)) continue
          const results = await counter.count([{ key: 'tools', kind: 'tools', tools: shapeTools(s.name, record.defs, agent) }], counterInfo, { remote: false })
          out[`${agent}:${s.scope || 'user'}:${s.name}`] = { tools: record.defs.length, at: record.at, counter: counterInfo, result: results.tools || null }
        }
      }
      return out
    },

    // The downloadable tokenizers, with their size and licence.
    async tokenizers() {
      const status = await files.status()
      return Object.fromEntries(Object.keys(TOKENIZER_FILES).map((id) => [id, { ...status[id], name: (TOKENIZERS[id] && TOKENIZERS[id].name) || id }]))
    },
    downloadTokenizer: (id) => files.download(id),
    removeTokenizer: (id) => files.remove(id),
    // Retry: ask the count APIs again even after a rate limit or a refusal.
    retry() {
      for (const service of Object.values(apis)) service?.reset?.()
    }
  }
}
