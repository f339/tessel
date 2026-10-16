<script setup>
// Settings > Context: what each agent loads into its context before you type
// anything, and what it costs in tokens (src/main/contextCost): its rules
// and memory files, its skills (name and description, listed up front), its
// MCP servers' tool definitions (once measured) and Tessel's team tools.
// A first read shows the kept counts at once (and estimates for the rest),
// then the page counts what is missing, with each model's own tokenizer or
// its provider's count API: each number says whether it is exact (and from
// where) or an estimate, and why. Everything listed is optional, with a link
// to where it is turned off. A page of the Settings shell (README.md): the
// counting runs only while the page is open.
import { ref, reactive, computed, watch, inject } from 'vue'
import BrandIcon from '../BrandIcon.vue'
import McpTokenTag from '../mcp/McpTokenTag.vue'
import { t, intlLocale } from '../../i18n'
import { settings } from '../../settings'
import { TOKENIZERS } from '../../../../shared/tokenCounters'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'
import { AGENT_LABELS, agentLabel, tokensText, compactTokens, fullTokens, sourceTitle, signIns, reasonText, retryable, counterText } from '../../contextCost'

const props = defineProps({
  // The current workspace's project folder (its project files and servers).
  projectCwd: { type: String, default: null },
  // Built-in and custom agents, with `available` (found on the PATH).
  agents: { type: Array, default: () => [] }
})
const { page, searching, shown, go, emit } = useSettingsShell()
const open = computed(() => page.value === 'context' && !searching.value)
// Open: a rules file in Tessel's own editor (text, never run), Settings
// closed to show it; without the editor (a test), its folder.
const panelCtx = inject('panelCtx', null)
function openFile(file) {
  if (panelCtx && typeof panelCtx.openInEditor === 'function') {
    panelCtx.openInEditor({ file, preview: false })
    emit('close')
  } else window.shellApi.chatFiles?.reveal?.(file)
}

const GROUPS = ['rules', 'skills', 'mcp', 'tessel']
const groupTitle = (g) =>
  ({
    rules: t('context.group.rules', 'Rules and memory files'),
    skills: t('context.group.skills', 'Skills, listed up front'),
    mcp: t('context.group.mcp', 'MCP servers, tool definitions'),
    tessel: t('context.group.tessel', "Tessel's team tools and task board rule")
  })[g]
const groupShort = (g) =>
  ({ rules: t('context.short.rules', 'Rules'), skills: t('context.short.skills', 'Skills'), mcp: t('context.short.mcp', 'MCP'), tessel: t('context.short.tessel', 'Tessel') })[g]
// Where each group is turned off.
const groupLink = (g) =>
  ({
    skills: { page: 'skills', label: t('context.link.skills', 'Manage skills') },
    mcp: { page: 'mcp', label: t('context.link.mcp', 'Manage MCP servers') },
    tessel: { page: 'orchestration', label: t('context.link.tessel', 'Orchestration settings') }
  })[g] || null

const shownAgents = computed(() => props.agents.filter((a) => a && a.available && AGENT_LABELS[a.id]).map((a) => ({ id: a.id, name: a.name || agentLabel(a.id) })))
const data = ref(null) // { agents: [...] }
const loading = ref(false)
const counting = ref(false)
const error = ref('')
const openId = ref(null)
const tokenizers = ref({})
const busy = reactive({}) // tokenizer id -> 'download' | 'remove'
const tokenizerErrors = reactive({})

const query = (remote) => ({
  cwd: props.projectCwd,
  agents: shownAgents.value.map((a) => ({ id: a.id })),
  remote,
  ...signIns()
})

let seq = 0
// First the kept counts (fast), then everything counted (the page is being
// looked at: count APIs are asked now).
async function refresh(remoteOnly = false) {
  const api = window.shellApi && window.shellApi.context
  if (!api) return
  const mine = ++seq
  error.value = ''
  try {
    if (!remoteOnly) {
      loading.value = !data.value
      const first = await api.summary(query(false))
      if (mine !== seq) return
      if (first && first.ok === false) throw new Error(first.error)
      data.value = first
      loading.value = false
      if (!openId.value && first && first.agents && first.agents.length) openId.value = first.agents[0].id
    }
    counting.value = true
    const full = await api.summary(query(true))
    if (mine !== seq) return
    if (full && full.ok === false) throw new Error(full.error)
    data.value = full
  } catch (err) {
    if (mine === seq) error.value = (err && err.message) || String(err)
  } finally {
    if (mine === seq) {
      loading.value = false
      counting.value = false
    }
  }
}
async function loadTokenizers() {
  try {
    tokenizers.value = (await window.shellApi.context.tokenizers()) || {}
  } catch {
    tokenizers.value = {}
  }
}
// Read when the page opens (and again when the project or the agents change
// while it is open).
watch(
  () => [open.value, props.projectCwd, shownAgents.value.map((a) => a.id).join(',')],
  ([isOpen]) => {
    if (!isOpen) return
    refresh()
    loadTokenizers()
  },
  { immediate: true }
)

async function retry() {
  await window.shellApi.context.retry()
  refresh(true)
}
async function download(id) {
  busy[id] = 'download'
  delete tokenizerErrors[id]
  try {
    const res = await window.shellApi.context.downloadTokenizer(id)
    if (!res || !res.ok) tokenizerErrors[id] = (res && res.error) || t('context.tokenizer.failed', 'The download failed.')
  } finally {
    delete busy[id]
    await loadTokenizers()
    refresh(true)
  }
}
async function removeTokenizer(id) {
  busy[id] = 'remove'
  try {
    await window.shellApi.context.removeTokenizer(id)
  } finally {
    delete busy[id]
    await loadTokenizers()
    refresh(true)
  }
}

// ---------------------------------------------------------------- Display
const megabytes = (bytes) => {
  try {
    return new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))
  } catch {
    return String(Math.round(bytes / 1048576))
  }
}
const sizeText = (bytes) => t('context.tokenizer.size', '{{mb}} MB', { mb: megabytes(bytes || 0) })
const toggle = (id) => (openId.value = openId.value === id ? null : id)
const nameOf = (id) => (shownAgents.value.find((a) => a.id === id) || {}).name || agentLabel(id)
const totalText = (a) => (a.summary.pending && !a.summary.total ? '' : tokensText({ tokens: a.summary.total, exact: a.summary.exact === 'all' }))
const exactText = (a) =>
  a.summary.exact === 'all'
    ? t('context.exact.all', 'exact')
    : a.summary.exact === 'some'
      ? t('context.exact.some', 'partly estimated')
      : t('context.exact.none', 'estimate')
const groupsLine = (a) =>
  GROUPS.filter((g) => a.summary.groups[g])
    .map((g) => `${groupShort(g)} ${compactTokens(a.summary.groups[g])}`)
    .join(' · ')
const barParts = (a) => (a.summary.total ? GROUPS.filter((g) => a.summary.groups[g]).map((g) => ({ g, pct: (a.summary.groups[g] / a.summary.total) * 100 })) : [])
// The lines that stand for several items, never struck through.
const isTally = (item) => item.type === 'more' || item.type === 'hidden'
// A group shows ITEM_LIMIT lines at most, then one "N more not shown" line
// (the main process already folds a flood of imports into its own line,
// kept last).
const ITEM_LIMIT = 300
const itemsOf = (a, g) => {
  const all = (a.items || []).filter((i) => i.group === g && !isTally(i))
  const list = g === 'rules' ? all : [...all].sort((x, y) => (y.result ? y.result.tokens : -1) - (x.result ? x.result.tokens : -1))
  const tallies = (a.items || []).filter((i) => i.group === g && isTally(i))
  if (list.length <= ITEM_LIMIT) return tallies.length ? [...list, ...tallies] : list
  return [...list.slice(0, ITEM_LIMIT), { key: 'hidden:' + g, group: g, type: 'hidden', label: '', count: list.length - ITEM_LIMIT, loaded: true }, ...tallies]
}
const groupTokens = (a, g) => a.summary.groups[g] || 0
const scopeText = (s) => (s === 'project' || s === 'local' ? t('context.scope.project', 'This project') : t('context.scope.user', 'All projects'))
const itemLabel = (item) => {
  if (item.type === 'boardRule') return t('context.item.boardRule', 'Task board rule in {{file}}', { file: item.label })
  if (item.type === 'teamInstructions') return t('context.item.teamInstructions', 'Team tools: instructions')
  if (item.type === 'teamTools') return t('context.item.teamTools', 'Team tools: {{count}} definitions', { count: item.toolCount })
  if (item.type === 'more')
    return item.count === 1
      ? t('context.item.more', '{{n}} more import not followed', { count: 1, n: fullTokens(1) })
      : t('context.item.more', '{{n}} more imports not followed', { count: item.count, n: fullTokens(item.count) })
  if (item.type === 'hidden') return t('context.item.hidden', '{{n}} more not shown', { count: item.count, n: fullTokens(item.count) })
  return item.label
}
const noteText = (note) =>
  ({
    memory: t('context.note.memory', 'first 200 lines'),
    truncated: t('context.note.truncated', 'cut to its size limit'),
    onDemand: t('context.note.onDemand', 'loaded only when relevant, not counted'),
    import: t('context.note.import', 'imported'),
    off: t('context.note.off', 'turned off, not counted'),
    notMeasured: t('context.note.notMeasured', 'not measured yet'),
    notApproved: t('context.note.notApproved', 'not allowed in Claude Code yet, not counted'),
    outside: t('context.note.outside', 'not followed (outside the project)'),
    skipped: t('context.note.skipped', 'not followed (not a text file, or a credentials file)'),
    limit: t('context.note.limit', 'not read (the reading limit was reached)')
  })[note] || ''
// A rules file that was read: it may be opened in Tessel's editor.
const canOpen = (item) => item.type === 'file' && !!item.path && !['outside', 'skipped', 'limit'].includes(item.note)
// The tokenizer an agent's exact count waits for (downloadable, not there).
const missingTokenizer = (a) => (a.counter && a.counter.kind === 'local' && TOKENIZERS[a.counter.tokenizer] && !TOKENIZERS[a.counter.tokenizer].shipped && !(tokenizers.value[a.counter.tokenizer] || {}).ready ? a.counter.tokenizer : null)
// The estimates a Retry may turn exact, and why.
const retryReason = (a) => {
  const r = (a.items || []).map((i) => i.result).find((res) => retryable(res) && res.reason !== 'notCounted')
  return r ? reasonText(r) : ''
}
const needsSignIn = (a) => a.counter && a.counter.api === 'anthropic' && (a.items || []).some((i) => i.result && i.result.reason === 'noKey')
// Text with {{placeholders}} is built here: in the template, "}}" would end
// the interpolation.
const needTokenizerText = (a) => {
  const id = missingTokenizer(a)
  return t('context.needTokenizer', 'Exact counts for {{model}} need the {{tokenizer}} tokenizer ({{size}}), downloaded once from Hugging Face.', {
    model: a.model,
    tokenizer: TOKENIZERS[id].name,
    size: sizeText((tokenizers.value[id] || {}).bytes)
  })
}
const someEstimatesText = (a) => t('context.someEstimates', 'Some counts are estimates: {{why}}.', { why: retryReason(a) })
// How an agent's counts were made: by its counter, or estimated (and why).
const agentCounterText = (a) => {
  if (a.summary.exact === 'all' || a.summary.exact === 'some') return counterText(a.counter)
  const id = missingTokenizer(a)
  if (id) return t('context.counter.waitTokenizer', 'estimated until the {{tokenizer}} tokenizer is downloaded', { tokenizer: TOKENIZERS[id].name })
  const why = reasonText((a.items || []).map((i) => i.result).find((r) => r && !r.exact && r.reason))
  return why ? t('context.counter.estimatedWhy', 'estimated: {{why}}', { why }) : t('context.counter.estimate', 'estimated')
}
const tokenizerRows = computed(() => Object.entries(tokenizers.value).map(([id, row]) => ({ id, ...row })))
const shortPath = (p) => {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean)
  return parts.length > 3 ? `…${p.includes('\\') ? '\\' : '/'}${parts.slice(-3).join(p.includes('\\') ? '\\' : '/')}` : p // i18n-ignore
}
</script>

<template>
  <section id="set-context" class="set-page ctx-page" data-page="context" :hidden="!shown('context')" aria-labelledby="set-context-title">
    <header class="set-page-head">
      <h2 id="set-context-title">{{ PAGES.context.title }}</h2>
      <p class="set-page-desc">{{ PAGES.context.desc }}</p>
    </header>
    <div v-if="!open" class="set-group">
      <div class="set-card">
        <div class="set-row">
          <div class="set-label">{{ t('settings.context.summary', 'Context cost') }}
            <span class="set-hint">{{ t('settings.context.summaryHint', 'Tokens each agent loads up front: rules files, skills, MCP tools and Tessel’s team tools.') }}</span>
          </div>
          <button type="button" class="exit-btn" @click="go('context')">{{ t('settings.context.open', 'Open Context') }}</button>
        </div>
      </div>
    </div>
    <template v-else>
    <div class="set-group">
      <div class="ctx-group-head">
        <div class="set-group-title">{{ t('context.agents.title', 'Per agent') }}</div>
        <span v-if="counting" class="ctx-dim" role="status">{{ t('context.counting', 'Counting…') }}</span>
        <button type="button" class="exit-btn small" :disabled="loading || counting" @click="refresh()">{{ t('context.recount', 'Count again') }}</button>
      </div>
      <p class="ctx-group-desc">
        {{ t('context.agents.desc', "Not counted: each agent's own system prompt and built-in tools. A struck-through item loads only when relevant.") }}
      </p>
      <div class="set-card set-card-pad">
        <p v-if="error" class="ctx-callout warn" role="alert">{{ error }}</p>
        <div v-if="loading" class="ctx-dim ctx-empty">{{ t('context.loading', 'Reading what each agent loads…') }}</div>
        <div v-else-if="!shownAgents.length" class="ctx-dim ctx-empty">{{ t('context.noAgents', 'No agent that Tessel can measure is installed.') }}</div>
        <ul v-else-if="data && data.agents" class="ctx-list" :aria-label="t('context.agents.title', 'Per agent')">
          <li v-for="a in data.agents" :key="a.id" class="ctx-item" :class="{ open: openId === a.id }" :data-agent="a.id">
            <button type="button" class="ctx-row" :aria-expanded="openId === a.id" @click="toggle(a.id)">
              <BrandIcon :kind="a.id" :size="20" />
              <span class="ctx-row-main">
                <span class="ctx-row-top">
                  <span class="ctx-row-name">{{ nameOf(a.id) }}</span>
                  <span v-if="a.model" class="ctx-tag mono" :title="counterText(a.counter)">{{ a.model }}</span>
                  <span v-if="a.defaulted" class="ctx-tag" :title="t('context.defaultModelHint', 'No model found in its settings: counted for the model it uses by default.')">{{ t('context.defaultModel', 'default model') }}</span>
                </span>
                <span class="ctx-row-desc">{{ agentCounterText(a) }}<template v-if="groupsLine(a)"> · {{ groupsLine(a) }}</template></span>
              </span>
              <span class="ctx-row-meta">
                <span class="ctx-total" data-test="agent-total">{{ totalText(a) }}</span>
                <span class="ctx-src" :class="{ estimate: a.summary.exact !== 'all' }">{{ exactText(a) }}</span>
              </span>
              <svg class="ctx-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <div v-if="barParts(a).length" class="ctx-bar" aria-hidden="true">
              <span v-for="p in barParts(a)" :key="p.g" :class="'g-' + p.g" :style="{ width: p.pct + '%' }" />
            </div>

            <div v-if="openId === a.id" class="ctx-details">
              <p v-if="missingTokenizer(a)" class="ctx-callout info">
                {{ needTokenizerText(a) }}
                <button type="button" class="exit-btn small" :disabled="!!busy[missingTokenizer(a)]" @click="download(missingTokenizer(a))">
                  {{ busy[missingTokenizer(a)] ? t('context.tokenizer.downloading', 'Downloading…') : t('context.tokenizer.download', 'Download') }}
                </button>
              </p>
              <p v-if="needsSignIn(a)" class="ctx-callout info">
                {{ t('context.claudeSignInCallout', "Claude's tokenizer is not public: exact counts come from Anthropic's count_tokens, with an API key (ANTHROPIC_API_KEY) or, if you turn it on, your Claude Code sign-in (Anthropic may refuse it).") }}
                <label class="ctx-inline-switch">
                  <input v-model="settings.contextClaudeSignIn" type="checkbox" class="set-switch" @change="refresh(true)" />
                  {{ t('context.claudeSignIn', 'Count with my Claude sign-in') }}
                </label>
              </p>
              <p v-if="retryReason(a)" class="ctx-callout warn">
                {{ someEstimatesText(a) }}
                <button type="button" class="exit-btn small" :disabled="counting" @click="retry">{{ t('context.retry', 'Retry') }}</button>
              </p>

              <template v-for="g in GROUPS" :key="g">
                <section v-if="itemsOf(a, g).length" class="ctx-section" :data-group="g">
                  <div class="ctx-section-head">
                    <span class="ctx-swatch" :class="'g-' + g" aria-hidden="true" />
                    <span>{{ groupTitle(g) }}</span>
                    <span class="ctx-section-total">{{ compactTokens(groupTokens(a, g)) }}</span>
                    <button v-if="groupLink(g)" type="button" class="ctx-link" @click="go(groupLink(g).page)">{{ groupLink(g).label }}</button>
                  </div>
                  <ul class="ctx-lines">
                    <li v-for="item in itemsOf(a, g)" :key="item.key" class="ctx-line" :class="{ off: !item.loaded && !isTally(item), tally: isTally(item) }">
                      <span class="ctx-line-main">
                        <span class="ctx-line-top">
                          <span class="ctx-line-name" :title="item.path || undefined">{{ itemLabel(item) }}</span>
                          <span v-if="item.scope && g !== 'tessel'" class="ctx-tag scope">{{ scopeText(item.scope) }}</span>
                          <span v-if="item.path && (item.type === 'file' || item.type === 'boardRule')" class="ctx-path" :title="item.path">{{ shortPath(item.path) }}</span>
                        </span>
                        <span v-if="noteText(item.note)" class="ctx-note">{{ noteText(item.note) }}</span>
                      </span>
                      <span class="ctx-line-cost">
                        <McpTokenTag
                          v-if="item.type === 'mcp' && item.ref && item.note !== 'off'"
                          :server="item.ref.name"
                          :agent="item.ref.agent"
                          :scope="item.ref.scope"
                          :cwd="projectCwd"
                          variant="details"
                          @measured="refresh(true)"
                        />
                        <span v-else-if="item.result" class="ctx-num" :class="{ estimate: !item.result.exact }" :title="sourceTitle(item.result)">{{ tokensText(item.result) }}</span>
                        <button v-if="canOpen(item)" type="button" class="ctx-link" :title="t('context.openHint', 'Open in Tessel’s editor')" @click="openFile(item.path)">{{ t('context.open', 'Open') }}</button>
                      </span>
                    </li>
                  </ul>
                </section>
              </template>
              <p class="ctx-foot">
                {{ t('context.optionalFoot', 'All of it is optional: turn skills and servers off where they are managed, and edit or remove a rules file to drop it.') }}
              </p>
            </div>
          </li>
        </ul>
      </div>
    </div>

    </template>

    <div class="set-group">
      <div class="set-group-title">{{ t('context.howTitle', 'How tokens are counted') }}</div>
      <div class="set-card">
        <div class="set-row">
          <div class="set-label">
            {{ t('context.claudeSignIn', 'Count with my Claude sign-in') }}
            <span class="set-hint">{{ t('context.claudeSignInHint', "Uses your Claude Code sign-in to ask Anthropic's count_tokens, the way Claude Code itself does. Anthropic may refuse it; an estimate is shown then. An ANTHROPIC_API_KEY is used instead when one is set.") }}</span>
          </div>
          <input v-model="settings.contextClaudeSignIn" type="checkbox" class="set-switch" data-setting="contextClaudeSignIn" @change="refresh(true)" />
        </div>
        <div class="set-row">
          <div class="set-label">
            {{ t('context.geminiSignIn', 'Count with my Gemini CLI sign-in') }}
            <span class="set-hint">{{ t('context.geminiSignInHint', "Uses your Gemini CLI sign-in to ask Google's countTokens, for the Gemini models that have no local tokenizer. A GEMINI_API_KEY is used instead when one is set.") }}</span>
          </div>
          <input v-model="settings.contextGeminiSignIn" type="checkbox" class="set-switch" data-setting="contextGeminiSignIn" @change="refresh(true)" />
        </div>
        <div class="set-row ctx-tokenizers-row">
          <div class="set-label">
            {{ t('context.tokenizers.title', 'Open models’ tokenizers') }}
            <span class="set-hint">{{ t('context.tokenizers.hint', "Each model's own tokenizer, downloaded once from Hugging Face when you click Download, checked by hash. OpenAI's ship with Tessel.") }}</span>
          </div>
        </div>
        <ul class="ctx-tokenizers">
          <li v-for="row in tokenizerRows" :key="row.id" class="ctx-tokenizer" :data-tokenizer="row.id">
            <span class="ctx-tokenizer-name">{{ row.name }}</span>
            <span class="ctx-dim ctx-size">{{ sizeText(row.bytes) }}</span>
            <span class="ctx-dim ctx-licence" :title="row.repo">{{ row.licence }}</span>
            <span v-if="tokenizerErrors[row.id]" class="ctx-error">{{ tokenizerErrors[row.id] }}</span>
            <span class="ctx-tokenizer-action">
              <template v-if="row.ready">
                <span class="ctx-tag ok">{{ t('context.tokenizer.ready', 'Downloaded') }}</span>
                <button type="button" class="ctx-link" :disabled="!!busy[row.id]" @click="removeTokenizer(row.id)">{{ t('context.tokenizer.remove', 'Remove') }}</button>
              </template>
              <button v-else type="button" class="exit-btn small" :disabled="!!busy[row.id]" @click="download(row.id)">
                {{ busy[row.id] === 'download' ? t('context.tokenizer.downloading', 'Downloading…') : t('context.tokenizer.download', 'Download') }}
              </button>
            </span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ctx-group-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ctx-group-head .set-group-title {
  margin-right: auto;
}
.ctx-group-desc {
  margin: 0 0 8px;
  color: var(--text-dim);
  font-size: 12px;
}
.ctx-dim {
  color: var(--text-dim);
  font-size: 12px;
}
.ctx-empty {
  padding: 14px 4px;
}
.ctx-list {
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--border);
}
.ctx-item {
  border-bottom: 1px solid var(--border);
}
.ctx-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 50px;
  padding: 5px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ctx-row:hover,
.ctx-item.open > .ctx-row {
  background: var(--surface-3);
}
.ctx-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.ctx-row-main {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ctx-row-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
  min-width: 0;
}
.ctx-row-name {
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 600;
}
.ctx-row-desc {
  overflow: hidden;
  color: var(--text-dim);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctx-row-meta {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
}
.ctx-total {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ctx-src {
  color: var(--text-dim);
  font-size: 10.5px;
}
.ctx-src.estimate {
  font-style: italic;
}
.ctx-chevron {
  flex: 0 0 auto;
  color: var(--text-dim);
  transition: transform 0.12s ease;
}
.ctx-item.open .ctx-chevron {
  transform: rotate(90deg);
}
.ctx-tag {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--surface-3);
  color: var(--text-dim);
  font-size: 10.5px;
  line-height: 16px;
  white-space: nowrap;
}
.ctx-tag.mono {
  font-family: 'Cascadia Mono', Consolas, monospace;
}
.ctx-tag.scope {
  border: 1px solid var(--border-strong);
  background: transparent;
  line-height: 14px;
}
.ctx-tag.ok {
  background: color-mix(in srgb, #3fb950 20%, transparent);
  color: #a8e6b4;
}
/* The share of each group, under the agent's row. */
.ctx-bar {
  display: flex;
  height: 3px;
  margin: 0 8px 6px 38px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--surface-3);
}
.ctx-bar > span,
.ctx-swatch {
  display: block;
}
.g-rules {
  background: #4c8dff;
}
.g-skills {
  background: #3fb950;
}
.g-mcp {
  background: #d29922;
}
.g-tessel {
  background: #a371f7;
}
.ctx-details {
  padding: 4px 8px 12px 38px;
}
.ctx-section {
  margin-top: 6px;
}
.ctx-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  color: var(--text-dim);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.ctx-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.ctx-section-total {
  color: var(--text);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
  text-transform: none;
}
.ctx-section-head .ctx-link {
  margin-left: auto;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
}
.ctx-lines {
  margin: 0;
  padding: 0;
  list-style: none;
}
.ctx-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  min-height: 30px;
  padding: 3px 0;
  border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  font-size: 12px;
}
.ctx-line.off .ctx-line-name {
  color: var(--text-dim);
  text-decoration: line-through;
}
.ctx-line.tally .ctx-line-name {
  color: var(--text-dim);
}
/* Name, scope and path on one line (the path gives way first), a note under. */
.ctx-line-main {
  display: flex;
  flex: 1 1 200px;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.ctx-line-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
}
.ctx-line-name {
  flex: 0 1 auto;
  min-width: 40px;
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctx-path {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  color: var(--text-dim);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctx-note {
  color: var(--text-dim);
  font-size: 11px;
  font-style: italic;
}
.ctx-line-cost {
  display: flex;
  flex: 0 1 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 4px 10px;
  margin-left: auto;
}
.ctx-num {
  color: var(--text);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ctx-num.estimate {
  color: var(--text-dim);
}
.ctx-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  font-size: 11.5px;
}
.ctx-link:hover {
  text-decoration: underline;
}
.ctx-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.ctx-callout {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  margin: 6px 0;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.45;
}
.ctx-callout.info {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.ctx-callout.warn {
  background: color-mix(in srgb, #d29922 14%, transparent);
}
.ctx-inline-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.ctx-foot {
  margin: 10px 0 0;
  color: var(--text-dim);
  font-size: 11.5px;
}
.ctx-error {
  color: #ffb4b6;
  font-size: 11px;
}
.ctx-tokenizers {
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
}
.ctx-tokenizer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 12px;
  min-height: 34px;
  border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  font-size: 12px;
}
.ctx-tokenizer-name {
  min-width: 120px;
  color: var(--text);
}
.ctx-size {
  min-width: 64px;
  font-variant-numeric: tabular-nums;
}
.ctx-licence {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctx-tokenizer-action {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
</style>
