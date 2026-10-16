// Token counts of Settings > Context and the token tags (SkillTokenTag.vue,
// McpTokenTag.vue): how a count reads ("≈ 3.2k tokens" for an estimate,
// "3.2k tokens" for an exact one), where it comes from, and the shared
// counts of the Skills and MCP pages, read once per page for all its tags.
// The counts come from the main process (src/main/contextCost): no file's
// text ever reaches the window.
import { reactive } from 'vue'
import { t, intlLocale } from './i18n'
import { settings } from './settings'
import { TOKENIZERS, COUNT_APIS } from '../../shared/tokenCounters'

// "3.2k", "850", "1.2M" (and "3,2 k" in French).
export function compactTokens(n) {
  const value = Number.isFinite(n) ? Math.max(0, n) : 0
  try {
    // English writes thousands of tokens "3.2k", as token counters do.
    return new Intl.NumberFormat(intlLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(value).replace(/(\d)K$/, '$1k')
  } catch {
    return String(Math.round(value))
  }
}
export function fullTokens(n) {
  try {
    return new Intl.NumberFormat(intlLocale()).format(Number.isFinite(n) ? n : 0)
  } catch {
    return String(n)
  }
}

// "≈ 3.2k tokens" (estimate) or "3.2k tokens" (exact).
export function tokensText(result) {
  if (!result || !Number.isFinite(result.tokens)) return ''
  const n = compactTokens(result.tokens)
  return result.exact ? t('context.tokens.exact', '{{n}} tokens', { n }) : t('context.tokens.estimate', '≈ {{n}} tokens', { n })
}

// The agents Settings > Context covers, by name.
export const AGENT_LABELS = Object.freeze({
  claude: 'Claude Code', // i18n-ignore
  codex: 'Codex', // i18n-ignore
  gemini: 'Gemini CLI', // i18n-ignore
  antigravity: 'Antigravity CLI', // i18n-ignore
  qwen: 'Qwen Code', // i18n-ignore
  opencode: 'OpenCode', // i18n-ignore
  copilot: 'Copilot CLI', // i18n-ignore
  cursor: 'Cursor CLI', // i18n-ignore
  kimi: 'Kimi Code', // i18n-ignore
  cline: 'Cline' // i18n-ignore
})
export const agentLabel = (id) => AGENT_LABELS[id] || id

const apiName = (api) => (api === 'ollama' ? 'Ollama' : (COUNT_APIS[api] && COUNT_APIS[api].name) || api) // i18n-ignore
const tokenizerName = (id) => (TOKENIZERS[id] && TOKENIZERS[id].name) || id

// The short label beside a count: "exact · Anthropic count_tokens",
// "exact · Qwen 3", "estimate".
export function sourceLabel(result) {
  if (!result) return ''
  if (result.source === 'api') return t('context.source.apiShort', 'exact · {{api}}', { api: apiName(result.api) })
  if (result.source === 'local') return t('context.source.localShort', 'exact · {{tokenizer}}', { tokenizer: tokenizerName(result.tokenizer) })
  return t('context.source.estimateShort', 'estimate')
}

// Why a count is an estimate, in a few words.
export function reasonText(result) {
  if (!result || result.exact) return ''
  const api = apiName(result.api || result.wanted)
  switch (result.reason) {
    case 'offline':
      return t('context.reason.offline', "couldn't reach {{api}}", { api })
    case 'signedOut':
      return result.api === 'anthropic'
        ? t('context.reason.claudeRefused', 'Anthropic did not accept the key or sign-in')
        : t('context.reason.signedOut', '{{api}} did not accept the key or sign-in', { api })
    case 'noKey':
      if (result.api === 'anthropic') return t('context.reason.claudeNoKey', 'turn on "Count with my Claude sign-in", or set ANTHROPIC_API_KEY')
      if (result.api === 'google') return t('context.reason.googleNoKey', 'turn on "Count with my Gemini CLI sign-in", or set GEMINI_API_KEY')
      return t('context.reason.noKey', 'needs an API key ({{key}})', { key: (COUNT_APIS[result.api] && COUNT_APIS[result.api].key) || 'API key' }) // i18n-ignore
    case 'rateLimited':
      return t('context.reason.rateLimited', '{{api}} is limiting requests, try again later', { api })
    case 'refused':
      return t('context.reason.refused', '{{api}} refused this request', { api })
    case 'unavailable':
      return t('context.reason.unavailable', '{{api}} is unavailable', { api })
    case 'notCounted':
      return t('context.reason.notCounted', 'not counted yet')
    case 'noTokenizer':
      return t('context.reason.noTokenizer', 'download the {{tokenizer}} tokenizer for an exact count', { tokenizer: tokenizerName(result.tokenizer) })
    case 'noCounter':
      return t('context.reason.noCounter', 'this model has no public tokenizer')
    case 'otherProvider':
      return t('context.reason.otherProvider', "only the agent's own provider is asked to count, and {{api}} is not", { api })
    case 'worker':
      return t('context.reason.worker', 'the counting process did not answer')
    default:
      return ''
  }
}
// The sign-in switches of Settings > Context, sent with every request: the
// main process uses a sign-in only when its switch is on, and drops the
// counts still running with it once it is turned off.
export const signIns = () => ({ claudeSignIn: settings.contextClaudeSignIn === true, geminiSignIn: settings.contextGeminiSignIn === true })

// Reasons a click can fix: try the count API again.
export const retryable = (result) => !!result && !result.exact && ['offline', 'rateLimited', 'unavailable', 'signedOut', 'notCounted'].includes(result.reason)

// The whole story of a count, for its tooltip.
export function sourceTitle(result) {
  if (!result) return ''
  const n = fullTokens(result.tokens)
  const model = result.model || '?'
  if (result.source === 'api') return t('context.title.api', '{{n}} tokens, exact: {{api}} for {{model}}.', { n, api: apiName(result.api), model })
  if (result.source === 'local')
    return result.template
      ? t('context.title.localTemplate', "{{n}} tokens, exact: the {{tokenizer}} tokenizer of {{model}}, with the model's chat template, counted on this computer.", { n, tokenizer: tokenizerName(result.tokenizer), model })
      : t('context.title.local', '{{n}} tokens, exact: the {{tokenizer}} tokenizer of {{model}}, counted on this computer.', { n, tokenizer: tokenizerName(result.tokenizer), model })
  const factor = Number.isFinite(result.factor) ? result.factor.toLocaleString(intlLocale()) : '?'
  const how =
    result.base === 'chars'
      ? t('context.title.chars', 'characters ÷ 4')
      : result.calibrated
        ? t('context.title.calibrated', 'o200k_base × {{factor}}, calibrated from your own exact counts', { factor })
        : t('context.title.factor', 'o200k_base × {{factor}}', { factor })
  const why = reasonText(result)
  return why
    ? t('context.title.estimateWhy', '≈ {{n}} tokens, estimate ({{how}}): {{why}}.', { n, how, why })
    : t('context.title.estimate', '≈ {{n}} tokens, estimate ({{how}}).', { n, how })
}

// The counter a model gets, said in a few words (an agent's header).
export function counterText(counter) {
  if (!counter) return ''
  if (counter.kind === 'api') return t('context.counter.api', 'counted by {{api}}', { api: apiName(counter.api) })
  if (counter.kind === 'local') return t('context.counter.local', 'counted with {{tokenizer}}', { tokenizer: tokenizerName(counter.tokenizer) })
  return t('context.counter.estimate', 'estimated')
}

// ---------------------------------------------------------------- Shared counts
// The Skills page's and MCP page's counts, read once for all their tags.
export const contextCounts = reactive({ skills: {}, skillsCwd: undefined, skillsLoading: false, mcp: {}, mcpCwd: undefined, mcpLoading: false, measuring: {} })
const pending = { skills: null, mcp: null }
const api = () => (typeof window !== 'undefined' && window.shellApi && window.shellApi.context) || null
export const mcpKey = (agent, scope, name) => `${agent}:${scope || 'user'}:${name}`

// remote: count over the network now (the page is being looked at).
export function loadSkillCounts(cwd = null, { force = false } = {}) {
  const ctx = api()
  if (!ctx || !ctx.skills) return Promise.resolve(contextCounts.skills)
  if (!force && contextCounts.skillsCwd === cwd && Object.keys(contextCounts.skills).length) return Promise.resolve(contextCounts.skills)
  if (pending.skills && !force) return pending.skills
  contextCounts.skillsLoading = true
  pending.skills = ctx
    .skills({ cwd, remote: true, ...signIns() })
    .then((res) => {
      if (res && res.ok !== false) {
        contextCounts.skills = res
        contextCounts.skillsCwd = cwd
      }
      return contextCounts.skills
    })
    .catch(() => contextCounts.skills)
    .finally(() => {
      contextCounts.skillsLoading = false
      pending.skills = null
    })
  return pending.skills
}

// The MCP servers already measured (no server is started).
export function loadMcpCounts(cwd = null, { force = false } = {}) {
  const ctx = api()
  if (!ctx || !ctx.mcpMeasures) return Promise.resolve(contextCounts.mcp)
  if (!force && contextCounts.mcpCwd === cwd) return Promise.resolve(contextCounts.mcp)
  if (pending.mcp && !force) return pending.mcp
  contextCounts.mcpLoading = true
  pending.mcp = ctx
    .mcpMeasures({ cwd, ...signIns() })
    .then((res) => {
      if (res && res.ok !== false) {
        contextCounts.mcp = res
        contextCounts.mcpCwd = cwd
      }
      return contextCounts.mcp
    })
    .catch(() => contextCounts.mcp)
    .finally(() => {
      contextCounts.mcpLoading = false
      pending.mcp = null
    })
  return pending.mcp
}

// Measure: starts the server (or connects to it), on this click only.
// confirmed: the user saw the command of a project server Claude Code was
// not allowed to start, and said yes (else code 'needsConfirm', target).
export async function measureMcp({ agent, name, scope = 'user', cwd = null, model = null, confirmed = false }) {
  const key = mcpKey(agent, scope, name)
  contextCounts.measuring[key] = true
  try {
    const res = await window.shellApi.mcpMeasure({ agent, name, scope, cwd, model, confirmed, ...signIns() })
    if (res && res.ok) contextCounts.mcp = { ...contextCounts.mcp, [key]: { tools: res.tools, at: res.at, counter: res.counter, result: res.result } }
    return res
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  } finally {
    delete contextCounts.measuring[key]
  }
}

// ---------------------------------------------------------------- Pane card
// A pane header's hover card: what its agent loaded at start, read while the
// card is open, from what is kept (kept: no process started, no count API
// asked; nothing until Settings > Context listed the servers once), at most
// once a minute per agent, model and folder.
const startCache = new Map() // key -> { at, value, promise }
const START_TTL_MS = 60 * 1000
export const contextStart = reactive({}) // key -> { total, exact, groups } | null
export function startKey(info) {
  return info && info.contextAgent && AGENT_LABELS[info.contextAgent] ? `${info.contextAgent}|${info.contextModel || ''}|${info.contextCwd || ''}` : ''
}
export function loadContextStart(info) {
  const key = startKey(info)
  const ctx = api()
  if (!key || !ctx || !ctx.summary) return
  const seen = startCache.get(key)
  if (seen && (seen.promise || Date.now() - seen.at < START_TTL_MS)) return
  const entry = { at: Date.now(), promise: null }
  startCache.set(key, entry)
  entry.promise = ctx
    .summary({ cwd: info.contextCwd || null, agents: [{ id: info.contextAgent, model: info.contextModel || null }], remote: false, kept: true, ...signIns() })
    .then((res) => {
      const a = res && Array.isArray(res.agents) ? res.agents[0] : null
      contextStart[key] = a ? { total: a.summary.total, exact: a.summary.exact === 'all', groups: a.summary.groups } : null
    })
    .catch(() => {
      contextStart[key] = null
    })
    .finally(() => {
      entry.promise = null
      entry.at = Date.now()
    })
}
// "Rules 3.1k · Skills 2.4k · MCP 8k · Tessel 2.9k"
export function groupsText(groups) {
  const names = { rules: t('context.short.rules', 'Rules'), skills: t('context.short.skills', 'Skills'), mcp: t('context.short.mcp', 'MCP'), tessel: t('context.short.tessel', 'Tessel') }
  return Object.keys(names)
    .filter((g) => groups && groups[g])
    .map((g) => `${names[g]} ${compactTokens(groups[g])}`)
    .join(' · ')
}
