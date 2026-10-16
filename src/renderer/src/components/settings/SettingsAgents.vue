<script setup>
// Settings > Agents: which agents Tessel offers, their updates, how they
// start and what they may do.
import { ref, computed } from 'vue'
import ThemedSelect from '../ui/ThemedSelect.vue'
import { describeWaitingText } from '../../agentUpdateWhy'
import { t, intlLocale } from '../../i18n'
import BrandIcon from '../BrandIcon.vue'
import AgentTerminalSettings from '../AgentTerminalSettings.vue'
import SettingsToolRows from '../SettingsToolRows.vue'
import { LoaderCircle } from 'lucide-vue-next'
import { updateFailureText, updateKindLabel } from '../../agentUpdateErrors'
import { settings, clamp } from '../../settings'
import { parseEnvText, YOLO_ARGS, YOLO_ENV, agentEnabled } from '../../../../shared/agentPrefs'
import { AGENT_DOCS } from '../../../../shared/agentDocs'
import {
  getAgentSessionOptionCatalog,
  valuesOnListedRow,
  modelOptions,
  resolveSessionOptionDefaults,
  updateSessionOptionDefaults,
  clearSessionOptionModel,
  clearSessionOptionValue
} from '../../../../shared/agentSessionOptions'
import { modelsFor, modelLists, modelProbes, refreshModels, canProbeModels } from '../../agentModels'
import { sessionOptionLabel, sessionChoiceLabel, probeErrorText } from '../../sessionOptionLabels'
import { CACHE_TTLS } from '../../promptCache'
import { agentRulesReason, agentRulesStatus } from '../../agentStateRules'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const props = defineProps({
  shells: { type: Array, default: () => [] },
  // Built-in and your own agents, with `available` (found on the PATH).
  agents: { type: Array, default: () => [] },
  // Agent CLI updates: { checkedAt, agents: { id: { installed, latest,
  // update, source, note } } }, the updates running (agentId -> job) and
  // the ones waiting their turn.
  agentUpdates: { type: Object, default: null },
  agentUpdateJobs: { type: Object, default: () => ({}) },
  agentUpdateQueue: { type: Array, default: () => [] },
  // { entries: [...newest first], last: { agentId: entry } } (main's agentUpdateHistory.js)
  agentUpdateHistory: { type: Object, default: () => ({ entries: [], last: {} }) }
})
const { shown, emit } = useSettingsShell()

// Settings > Agents "When a project opens" (projectLauncher.js): its choices.
const projectOpenShellLabel = (shell) => t('settings.agents.projectOpenShell', 'Open a terminal: {{shell}}', { shell })
const projectOpenAgentLabel = (agent) => t('settings.agents.projectOpenAgent', 'Start {{agent}}', { agent })

// Settings > Agents > Detection rules: which rules read the agents' screens.
const agentRulesLine = computed(() => {
  // The example "Open rules file" creates changes nothing until edited.
  if (agentRulesStatus.state === 'override' && !agentRulesStatus.size)
    return t('settings.agents.rulesEmpty', 'Your rules file changes nothing yet: the built-in rules are in use. Saved changes apply at once')
  if (agentRulesStatus.state === 'override')
    return t('settings.agents.rulesOverride', 'Your rules file is in use ({{count}} change(s) over the built-in rules)', { count: agentRulesStatus.size })
  if (agentRulesStatus.state === 'invalid')
    return t('settings.agents.rulesInvalid', 'Your rules file is ignored, the built-in rules stay in use: {{reason}}', { reason: agentRulesReason(t) })
  return t('settings.agents.rulesBuiltin', 'Built-in rules. Open the rules file to fix how Tessel tells an agent works, waits for your approval or hit its limit; saved changes apply at once')
})
const agentRulesError = ref('')
async function openAgentRules() {
  agentRulesError.value = ''
  const res = await window.shellApi.agentRules?.open().catch((err) => ({ ok: false, error: err?.message || String(err) }))
  if (res && !res.ok) agentRulesError.value = res.error || ''
}

// Settings > Agents: versions and updates of the installed agent CLIs.
const checkingAgentUpdates = ref(false)
async function checkAgentUpdates() {
  checkingAgentUpdates.value = true
  try {
    await new Promise((resolve) => emit('check-agent-updates', resolve))
  } finally {
    checkingAgentUpdates.value = false
  }
}
function updateRow(id) {
  return (props.agentUpdates && props.agentUpdates.agents && props.agentUpdates.agents[id]) || null
}
const updatableCount = computed(() =>
  props.agentUpdates && props.agentUpdates.agents ? Object.values(props.agentUpdates.agents).filter((r) => r.update).length : 0
)
const agentUpdatesSummary = computed(() => {
  const u = props.agentUpdates
  if (!u) return t('settings.agents.notChecked', 'Not checked yet')
  const when = new Date(u.checkedAt).toLocaleString(intlLocale(), { dateStyle: 'short', timeStyle: 'short' })
  const n = updatableCount.value
  return n
    ? n === 1
      ? t('settings.agents.updatesSummary', '{{count}} update available · checked {{when}}', { count: n, when })
      : t('settings.agents.updatesSummary', '{{count}} updates available · checked {{when}}', { count: n, when })
    : t('settings.agents.upToDate', 'All up to date · checked {{when}}', { when })
})
function versionText(a) {
  const r = updateRow(a.id)
  if (!r) return ''
  if (r.update)
    return t('settings.agents.updateAvailable', 'Update available: {{installed}} → {{latest}}', {
      installed: r.installed,
      latest: r.latest
    })
  if (r.installed)
    return r.latest
      ? t('settings.agents.versionLatest', 'Version {{version}} (latest)', { version: r.installed })
      : t('settings.agents.version', 'Version {{version}}', { version: r.installed })
  return r.note || ''
}
// An update in progress, in words.
function jobText(id) {
  const j = props.agentUpdateJobs && props.agentUpdateJobs[id]
  if (!j) return props.agentUpdateQueue.includes(id) ? t('settings.agents.jobQueued', 'Waiting for the other updates') : ''
  const waiting = describeWaitingText(j.waiting)
  switch (j.phase) {
    case 'updating':
      return j.via === 'background'
        ? t('settings.agents.jobUpdatingBackground', 'Updating in the background…')
        : t('settings.agents.jobUpdating', 'Updating in a pane below…')
    case 'waiting-stop':
      return t('settings.agents.jobWaitingStop', 'Its files are in use: waiting to stop {{panes}} safely, then updating and resuming them', {
        panes: waiting || t('settings.agents.jobItsPanes', 'its panes')
      })
    case 'retrying':
      return t('settings.agents.jobRetrying', 'Stopped its panes; updating again…')
    case 'restarting':
      return t('settings.agents.jobRestarting', 'Updated to {{version}}. Waiting to restart: {{panes}}', {
        version: j.version,
        panes: waiting || '…'
      })
    case 'done':
      // The report comes from the updater, as it is.
      return (
        t('settings.agents.jobDone', 'Updated to {{version}}.', { version: j.version || j.target }) +
        (j.report ? ` ${j.report}` : '')
      )
    case 'failed':
      // Told by the last result line (the history) when it has it.
      if (lastUpdate(id) && lastUpdate(id).at >= (j.startedAt || 0) && !j.inUse) return ''
      return j.error
        ? t('settings.agents.jobFailedWith', 'Not updated: {{error}}.', { error: j.error })
        : t('settings.agents.jobFailed', 'Not updated.')
    default:
      return ''
  }
}
function jobRunning(id) {
  const j = props.agentUpdateJobs && props.agentUpdateJobs[id]
  return !!(j && ['updating', 'retrying'].includes(j.phase))
}
// Files in use by its own panes: Tessel can close and reopen them.
function jobInUse(id) {
  const j = props.agentUpdateJobs && props.agentUpdateJobs[id]
  return !!(j && j.phase === 'failed' && j.inUse)
}

// The update history (the last attempts) and each agent's last result.
function lastUpdate(id) {
  const h = props.agentUpdateHistory
  return (h && h.last && h.last[id]) || null
}
const updateHistory = computed(() => {
  const h = props.agentUpdateHistory
  return h && Array.isArray(h.entries) ? h.entries : []
})
const historyOpen = ref(false)
const historyTitle = computed(() => t('settings.agents.history', 'Update history ({{count}})', { count: updateHistory.value.length }))
function whenText(at) {
  return new Date(at).toLocaleString(intlLocale(), { dateStyle: 'short', timeStyle: 'short' })
}
function versionsText(e) {
  const to = e.ok ? e.version || e.to : e.to
  return e.from && to ? `${e.from} → ${to}` : to || e.from || ''
}
function lastUpdateText(id) {
  const e = lastUpdate(id)
  if (!e) return ''
  const vars = { when: whenText(e.at), versions: versionsText(e) }
  return e.ok
    ? t('settings.agents.lastOk', 'Last update {{when}}: {{versions}}, succeeded', vars)
    : t('settings.agents.lastFailed', 'Last update {{when}}: {{versions}}, failed ({{kind}})', { ...vars, kind: updateKindLabel(e.kind) })
}
// Why the last attempt failed, in plain words, and the line of output that tells it.
function lastUpdateWhy(a) {
  const e = lastUpdate(a.id)
  if (!e || e.ok) return ''
  // Files in use by its own panes: the job's line says it, with its button.
  if (jobInUse(a.id)) return updateFailureText('in-use', a.name, { panes: 1 })
  return updateFailureText(e.kind, a.name)
}
function jobActive(id) {
  const j = props.agentUpdateJobs && props.agentUpdateJobs[id]
  return props.agentUpdateQueue.includes(id) || !!(j && !['done', 'failed'].includes(j.phase))
}

// Settings > Agents: each detected agent's own command, arguments and
// variables, whether it is offered, and the one a new pane starts.
const openAgent = ref(null) // the agent whose "Customize" is open
const envErrors = ref({})
// Settings > Agents: the installed agents first, then the ones not found,
// each group in its usual order.
const agentsInstalledFirst = computed(() => [
  ...props.agents.filter((a) => a.available),
  ...props.agents.filter((a) => !a.available)
])
function agentPref(id) {
  return settings.agentPrefs[id] || {}
}
function setAgentPref(id, field, value) {
  const next = { ...agentPref(id), [field]: value }
  if (field === 'env') {
    const r = parseEnvText(value)
    envErrors.value = { ...envErrors.value, [id]: r.error || '' }
  }
  settings.agentPrefs = { ...settings.agentPrefs, [id]: next }
}
function resetAgent(id) {
  const next = { ...settings.agentPrefs }
  const keepOff = next[id] && next[id].enabled === false
  delete next[id]
  if (keepOff) next[id] = { enabled: false }
  settings.agentPrefs = next
  envErrors.value = { ...envErrors.value, [id]: '' }
}
function customized(id) {
  const p = agentPref(id)
  return !!((p.command && p.command.trim()) || (p.args && p.args.trim()) || (p.env && p.env.trim()))
}
const detecting = ref(false)
async function detectAgents() {
  detecting.value = true
  try {
    await new Promise((resolve) => emit('detect-agents', resolve))
  } finally {
    detecting.value = false
  }
}
// Settings > Agents, each agent's default model and effort (Orca's catalogs
// and the agent's own model list). Nothing chosen: the agent's own default,
// and Tessel adds no flag (Orca's rule).
function hasModelDefaults(id) {
  return !!getAgentSessionOptionCatalog(id)
}
function modelDefaults(id) {
  // A Cursor variant id saved before its list was grouped: its row, with
  // the effort / Fast / Thinking it stands for.
  return valuesOnListedRow(modelsFor(id), resolveSessionOptionDefaults(settings.agentSessionOptions, id)) || null
}
// The models offered, with the chosen one even when the list lacks it.
function defaultModelRows(id) {
  const list = modelsFor(id)
  const d = modelDefaults(id)
  return d && !list.some((m) => m.id === d.model) ? [...list, { id: d.model, label: d.model, options: [] }] : list
}
function setDefaultModel(id, modelId) {
  settings.agentSessionOptions = modelId
    ? updateSessionOptionDefaults({ persisted: settings.agentSessionOptions, agent: id, modelId, optionId: 'model', value: modelId })
    : clearSessionOptionModel(settings.agentSessionOptions, id)
}
// The chosen model's options a launch can set (effort; Cursor's thinking and
// fast mode, which go into its model name).
function defaultOptionRows(id) {
  const d = modelDefaults(id)
  if (!d) return []
  return modelOptions(getAgentSessionOptionCatalog(id), modelsFor(id), d.model).filter(
    (o) => o.apply.launchArgs || o.apply.composedIntoModel
  )
}
// A fast mode only a running session takes (Claude Code's /fast).
function defaultHasLiveFast(id) {
  const d = modelDefaults(id)
  return !!d && modelOptions(getAgentSessionOptionCatalog(id), modelsFor(id), d.model).some(
    (o) => o.id === 'fastMode' && !o.apply.launchArgs && !o.apply.composedIntoModel
  )
}
function setDefaultOption(id, optionId, value) {
  const d = modelDefaults(id)
  if (!d) return
  let persisted = settings.agentSessionOptions
  // A saved Cursor variant id becomes its row: the values it stood for are
  // kept with the one changed now.
  const stored = resolveSessionOptionDefaults(persisted, id)
  if (stored && stored.model !== d.model) {
    persisted = updateSessionOptionDefaults({ persisted, agent: id, modelId: d.model, optionId: 'model', value: d.model })
    for (const [k, v] of Object.entries(d)) if (k !== 'model') persisted = updateSessionOptionDefaults({ persisted, agent: id, modelId: d.model, optionId: k, value: v })
  }
  settings.agentSessionOptions =
    value === '' || value === null
      ? clearSessionOptionValue({ persisted, agent: id, modelId: d.model, optionId })
      : updateSessionOptionDefaults({ persisted, agent: id, modelId: d.model, optionId, value })
}
function probeFor(id) {
  return modelProbes[id] || { busy: false, error: null }
}
function modelListText(a) {
  const list = modelLists[a.id]
  const probe = probeFor(a.id)
  if (probe.busy) return t('settings.agents.modelsListing', 'Asking {{name}} for its models…', { name: a.name })
  if (probe.error) return probeErrorText(probe.error, a.name)
  if (!canProbeModels(a.id) && !list) return t('settings.agents.modelsBuiltInOnly', 'Built-in model list. The agent may also offer other models in its own settings.')
  // No built-in list (OpenCode: its providers are the account's own).
  if (!list && !modelsFor(a.id).length) return t('settings.agents.modelsNone', 'No list yet. Refresh asks {{name}} for the models it offers.', { name: a.name })
  if (!list) return t('settings.agents.modelsBuiltIn', 'Built-in list. Refresh asks {{name}} for the models your account has.', { name: a.name })
  return t('settings.agents.modelsListed', '{{count}} models listed by {{name}} on {{date}}.', {
    count: list.models.length,
    name: a.name,
    date: new Date(list.fetchedAt).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' })
  })
}
function refreshAgentModels(a) {
  refreshModels(a.id, agentPref(a.id).command || '')
}

// The hint over an agent's variables (Yolo's own ones named).
function envHint(id) {
  return YOLO_ENV[id]
    ? t('settings.agents.variablesYolo', 'Variables, one NAME=value per line (Yolo sets {{names}})', {
        names: Object.keys(YOLO_ENV[id]).join(', ')
      })
    : t('settings.agents.variables', 'Variables, one NAME=value per line')
}
function openDocs(id) {
  if (AGENT_DOCS[id] && window.shellApi.openExternal) window.shellApi.openExternal(AGENT_DOCS[id])
}

// Settings > Agents > chat agents: minutes idle before a chat's process
// stops (0: never).
function setChatIdleMinutes(e) {
  const n = parseInt(e.target.value, 10)
  if (Number.isFinite(n)) settings.chatIdleMinutes = clamp(n, 0, 1440)
  e.target.value = settings.chatIdleMinutes
}

function setSleepMinutes(e) {
  const n = parseInt(e.target.value, 10)
  if (Number.isFinite(n)) settings.agentSleepMinutes = clamp(n, 1, 1440)
  e.target.value = settings.agentSleepMinutes
}

// Orca's "Keep computer awake" (agent-awake-copy.ts): On, Agent, Off.
// The choice lists below are computed so they follow the interface's language.
const AWAKE_MODES = computed(() => [
  { id: 'on', label: t('settings.common.on', 'On'), title: t('settings.agents.awakeOnTitle', 'Keep this computer awake continuously') },
  { id: 'agents', label: t('settings.agents.awakeAgent', 'Agent'), title: t('settings.agents.awakeAgentTitle', 'Stay awake while an agent is working') },
  { id: 'off', label: t('settings.common.off', 'Off'), title: t('settings.agents.awakeOffTitle', 'Allow normal system sleep behavior') }
])
</script>

<template>
  <section
    id="set-agents"
    class="set-page"
    data-page="agents"
    :hidden="!shown('agents')"
    aria-labelledby="set-agents-title"
  >
    <header class="set-page-head">
      <h2 id="set-agents-title">{{ PAGES.agents.title }}</h2>
      <p class="set-page-desc">{{ PAGES.agents.desc }}</p>
    </header>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.agents.newAgents', 'New agents') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <label class="set-label" for="settings-default-agent">
            {{ t('settings.agents.defaultAgent', 'Default agent') }}
            <span class="set-hint">{{ t('settings.agents.defaultAgentHint', 'What a new pane starts (Ctrl+Shift+T)') }}</span>
          </label>
          <ThemedSelect id="settings-default-agent" v-model="settings.defaultAgent" class="set-select">
            <option value="">{{ t('settings.agents.defaultShell', 'The default shell') }}</option>
            <option
              v-for="a in agents.filter((x) => x.available && agentEnabled(settings.agentPrefs, x.id))"
              :key="a.id"
              :value="a.id"
            >
              {{ a.name }}
            </option>
          </ThemedSelect>
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-project-open">
            {{ t('settings.agents.projectOpen', 'When a project opens') }}
            <span class="set-hint">{{ t('settings.agents.projectOpenHint', 'What a new project starts, here or on an SSH host. Ask shows the agents, terminals and recent conversations to choose from.') }}</span>
          </label>
          <ThemedSelect id="settings-project-open" v-model="settings.projectOpen" class="set-select" data-setting="projectOpen">
            <option value="ask">{{ t('settings.agents.projectOpenAsk', 'Ask') }}</option>
            <option value="terminal">{{ t('settings.agents.projectOpenTerminal', 'Open a terminal') }}</option>
            <option v-for="s in shells" :key="'terminal:' + s.id" :value="'terminal:' + s.id">
              {{ projectOpenShellLabel(s.name) }}
            </option>
            <option
              v-for="a in agents.filter((x) => x.available && agentEnabled(settings.agentPrefs, x.id))"
              :key="'agent:' + a.id"
              :value="'agent:' + a.id"
            >
              {{ projectOpenAgentLabel(a.name) }}
            </option>
          </ThemedSelect>
        </div>
        <div class="set-row">
          <div id="settings-perm-label" class="set-label">
            {{ t('settings.agents.permissions', 'Permissions') }}
            <span class="set-hint">{{ t('settings.agents.permissionsHint', 'For agents you start from now on') }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-perm-label">
            <button
              class="launch-seg-btn"
              :class="{ on: settings.agentPermissions === 'manual' }"
              :aria-pressed="settings.agentPermissions === 'manual'"
              @click="settings.agentPermissions = 'manual'"
            >
              {{ t('settings.agents.manual', 'Manual') }}
            </button>
            <button
              class="launch-seg-btn"
              :class="{ on: settings.agentPermissions === 'yolo' }"
              :aria-pressed="settings.agentPermissions === 'yolo'"
              @click="settings.agentPermissions = 'yolo'"
            >
              Yolo
            </button>
          </div>
        </div>
        <p v-if="settings.agentPermissions === 'yolo'" class="mcp-error agents-warn">
          {{ t('settings.agents.yoloWarning', 'Yolo: agents run commands and change files without asking you first (each agent\'s own skip-approvals option, unless you set its arguments yourself). Use it only in projects you can restore.') }}
        </p>
        <!-- Folders where agents always start in Yolo (pane menu > Yolo in this folder). -->
        <div v-if="(settings.yoloFolders || []).length" class="set-row yolo-folders" data-test="settings-yolo-folders">
          <div class="set-label">
            {{ t('settings.agents.yoloFolders', 'Yolo folders') }}
            <span class="set-hint">{{ t('settings.agents.yoloFoldersHint', 'Agents started in these folders always start in Yolo (pane menu > Yolo in this folder)') }}</span>
          </div>
          <div class="yolo-folder-list">
            <div v-for="f in settings.yoloFolders || []" :key="f" class="yolo-folder">
              <span class="yolo-folder-path" :title="f">{{ f }}</span>
              <button class="exit-btn" :title="t('settings.agents.yoloFolderRemoveHint', 'Agents started here ask first again (unless Yolo is on above)')" @click="settings.yoloFolders = settings.yoloFolders.filter((x) => x !== f)">
                {{ t('settings.agents.yoloFolderRemove', 'Remove') }}
              </button>
            </div>
          </div>
        </div>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.agents.resume', 'Resume conversations when panes reopen') }}
            <span class="set-hint">{{ t('settings.agents.resumeHint', 'Claude Code and Codex continue where they left off after a restart, instead of starting a new chat') }}</span>
          </div>
          <input v-model="settings.resumeAgents" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.agents.folderTrust', 'Trust the folder when Tessel starts an agent') }}
            <span class="set-hint">{{ t('settings.agents.folderTrustHint', 'Agents Tessel starts in a project you added, in a folder you trusted for chats, or in a copy Tessel made from one, skip their "Do you trust this folder?" question (Claude Code, Codex, Cursor, Copilot, Antigravity), so the project\'s agent settings and hooks apply right away. A pull request\'s copy, your home folder and remote hosts still ask. Off: each agent asks the first time it runs in a folder, and workers or automations wait at that question until you answer it. Folders already trusted stay trusted.') }}</span>
          </div>
          <input v-model="settings.agentFolderTrust" type="checkbox" class="set-switch" data-setting="agentFolderTrust" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.agents.browser', 'Let agents use the browser') }}
            <span class="set-hint">{{ t('settings.agents.browserHint', 'Agents can read, click and type in the built-in browser\'s pages of their own project (never other projects\' pages, never password fields, no downloads). All pages share the browser\'s cookies: agents can use the sites you are signed into in Tessel\'s browser. A page an agent drives shows an Agent badge; its Stop button takes the page back.') }}</span>
          </div>
          <input v-model="settings.agentBrowser" type="checkbox" class="set-switch" data-setting="agentBrowser" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.agents.autoTitles', 'Show the conversation\'s title') }}
            <span class="set-hint">{{ t('settings.agents.autoTitlesHint', 'Under the agent in the left sidebar and in the pane\'s hover card (Claude Code and Codex)') }}</span>
          </div>
          <input v-model="settings.autoTitles" type="checkbox" class="set-switch" />
        </label>
      </div>
    </div>

    <SettingsToolRows page="agents" @open="emit('open-tool', $event)" />

    <AgentTerminalSettings />

    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.agents.whileWorking', 'While agents work') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <div id="settings-awake-label" class="set-label">
            {{ t('settings.agents.keepAwake', 'Keep computer awake') }}
            <span class="set-hint">{{ t('settings.agents.keepAwakeHint', 'Choose On, Agent, or Off. Agent mode stays awake while agents are working; lid-close behavior follows this device\'s power settings.') }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-awake-label">
            <button
              v-for="m in AWAKE_MODES"
              :key="m.id"
              class="launch-seg-btn"
              :class="{ on: settings.keepAwake === m.id }"
              :aria-pressed="settings.keepAwake === m.id"
              :title="m.title"
              @click="settings.keepAwake = m.id"
            >
              {{ m.label }}
            </button>
          </div>
        </div>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.agents.cacheTimer', 'Prompt cache timer') }}
            <span class="set-hint">{{ t('settings.agents.cacheTimerHint', 'Claude keeps your conversation cached for a while after it answers. A message sent later re-sends it all uncached (slower, costs more). Shows a countdown in Claude\'s panes') }}</span>
          </div>
          <input v-model="settings.promptCacheTimer" type="checkbox" class="set-switch" />
        </label>
        <div v-if="settings.promptCacheTimer" class="set-row">
          <label class="set-label" for="settings-cache-ttl">
            {{ t('settings.agents.cacheDuration', 'Cache duration') }}
            <span class="set-hint">{{ t('settings.agents.cacheDurationHint', 'Match your provider\'s cache. The default is 5 minutes') }}</span>
          </label>
          <ThemedSelect id="settings-cache-ttl" v-model.number="settings.promptCacheTtlMs" class="set-select">
            <option v-for="ttl in CACHE_TTLS" :key="ttl.ms" :value="ttl.ms">{{ ttl.label }}</option>
          </ThemedSelect>
        </div>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.agents.sleep', 'Put idle agents to sleep') }}
            <span class="set-hint">{{ t('settings.agents.sleepHint', 'An agent idle for a while stops its terminal to free memory; its pane stays and opening it resumes the conversation. Only agents whose conversation Tessel can resume, never teammates, nor the pane you are in') }}</span>
          </div>
          <input v-model="settings.agentSleep" type="checkbox" class="set-switch" />
        </label>
        <div v-if="settings.agentSleep" class="set-row">
          <label class="set-label" for="settings-sleep-min">
            {{ t('settings.agents.sleepAfter', 'Sleep after') }}
            <span class="set-hint">{{ t('settings.agents.sleepAfterHint', 'Minutes idle (1 to 1440)') }}</span>
          </label>
          <input
            id="settings-sleep-min"
            class="set-number"
            type="number"
            min="1"
            max="1440"
            :value="settings.agentSleepMinutes"
            @change="setSleepMinutes"
          />
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-chat-idle">
            {{ t('settings.agents.chatIdle', 'Stop an idle chat agent after') }}
            <span class="set-hint">{{
              t('settings.agents.chatIdleHint', 'Minutes without a turn (0: never). Its next message starts it again, its conversation resumed')
            }}</span>
          </label>
          <input
            id="settings-chat-idle"
            class="set-number"
            type="number"
            min="0"
            max="1440"
            data-setting="chatIdleMinutes"
            :value="settings.chatIdleMinutes"
            @change="setChatIdleMinutes"
          />
        </div>
      </div>
    </div>

    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.agents.installed', 'Installed agents') }}</h3>
      <div class="set-card">
        <div class="agents-head">
          <span class="set-hint">{{ t('settings.agents.detected', 'Detected on this computer') }}</span>
          <button class="exit-btn" type="button" :disabled="detecting" @click="detectAgents">
            {{ detecting ? t('settings.agents.detecting', 'Detecting…') : t('settings.agents.detectAgain', 'Detect again') }}
          </button>
        </div>
        <div class="set-row agent-updates-row" data-test="agent-updates">
          <div class="set-label">
            {{ t('settings.agents.updates', 'Agent updates') }}
            <span class="set-hint agent-updates-summary">{{ agentUpdatesSummary }}</span>
          </div>
          <div class="agent-set-actions">
            <button
              class="exit-btn"
              type="button"
              data-test="check-agent-updates"
              :disabled="checkingAgentUpdates"
              @click="checkAgentUpdates"
            >
              {{ checkingAgentUpdates ? t('settings.agents.checking', 'Checking…') : t('settings.agents.checkUpdates', 'Check for agent updates') }}
            </button>
            <button
              v-if="updatableCount > 1"
              class="exit-btn"
              type="button"
              data-test="update-all-agents"
              @click="emit('update-all-agents')"
            >
              {{ t('settings.agents.updateAll', 'Update all') }}
            </button>
          </div>
        </div>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.agents.autoUpdate', 'Update agents automatically') }}
            <span class="set-hint">{{ t('settings.agents.autoUpdateHint', 'When a newer version is found, update it by itself at a safe moment: panes running it are idle, nothing typed in them. They restart in place and resume their conversation') }}</span>
          </div>
          <input v-model="settings.autoUpdateAgents" type="checkbox" class="set-switch" />
        </label>
        <!-- The texts that tell an agent works, waits for an approval or
             hit its limit: the built-in rules, or the user's rules file
             over them (agentStateRules.js). -->
        <div class="set-row" data-test="agent-rules">
          <div class="set-label">
            {{ t('settings.agents.rules', 'Detection rules') }}
            <span class="set-hint" :class="{ 'set-error': agentRulesStatus.state === 'invalid' }" data-test="agent-rules-status">{{ agentRulesLine }}</span>
            <span v-if="agentRulesError" class="set-hint set-error">{{ agentRulesError }}</span>
          </div>
          <button class="exit-btn" type="button" data-test="agent-rules-open" @click="openAgentRules">
            {{ t('settings.agents.rulesOpen', 'Open rules file') }}
          </button>
        </div>
        <div v-for="a in agentsInstalledFirst" :key="a.id" class="agent-set" :data-agent="a.id">
          <div class="agent-set-header">
            <div class="set-label agent-set-name">
              <BrandIcon :kind="a.id" :size="15" />
              <span>{{ a.name }}</span>
              <span class="set-hint">
                {{ a.available ? t('settings.agents.isInstalled', 'Installed') : t('settings.agents.notFound', 'Not found')
                }}{{ customized(a.id) ? ' · ' + t('settings.agents.customized', 'customized') : '' }}
              </span>
            </div>
            <div class="agent-set-actions">
              <!-- Not on this computer: install it (the launch menu's way:
                   the exact command is shown and confirmed first when it
                   runs a vendor script), or its install page. -->
              <button
                v-if="!a.available && a.install"
                class="exit-btn"
                type="button"
                data-test="agent-install"
                @click="emit('install-agent', a)"
              >
                {{ t('settings.agents.install', 'Install') }}
              </button>
              <button
                v-else-if="!a.available && a.docsUrl"
                class="exit-btn"
                type="button"
                data-test="agent-install-page"
                :title="a.docsUrl"
                @click="emit('agent-install-page', a)"
              >
                {{ t('settings.agents.installPage', 'Install page') }}
              </button>
              <button v-if="AGENT_DOCS[a.id]" class="exit-btn" type="button" @click="openDocs(a.id)">
                {{ t('settings.agents.docs', 'Docs') }}
              </button>
              <button
                class="exit-btn"
                type="button"
                :aria-expanded="openAgent === a.id"
                @click="openAgent = openAgent === a.id ? null : a.id"
              >
                {{ t('settings.agents.customize', 'Customize') }}
              </button>
              <input
                type="checkbox"
                class="set-switch"
                :aria-label="t('settings.agents.offerInMenus', 'Offer {{name}} in menus', { name: a.name })"
                :title="
                  agentEnabled(settings.agentPrefs, a.id)
                    ? t('settings.agents.shownInMenus', 'Shown in menus')
                    : t('settings.agents.hiddenFromMenus', 'Hidden from menus')
                "
                :checked="agentEnabled(settings.agentPrefs, a.id)"
                @change="setAgentPref(a.id, 'enabled', $event.target.checked)"
              />
            </div>
          </div>
          <div class="agent-set-details" v-if="jobText(a.id) || (a.available && (versionText(a) || lastUpdate(a.id) || updateRow(a.id)?.update))">
            <div class="agent-set-update-info">
              <!-- Full-width lines under the name row. -->
              <div
                v-if="a.available && versionText(a)"
                class="set-hint agent-version"
                :class="{ 'agent-update-available': updateRow(a.id) && updateRow(a.id).update }"
                :data-test="`agent-version-${a.id}`"
              >
                {{ versionText(a) }}
              </div>
              <div v-if="jobText(a.id)" class="set-hint agent-update-job" :data-test="`agent-update-job-${a.id}`">
                <LoaderCircle v-if="jobRunning(a.id)" :size="11" class="sb-spin agent-update-spinner" aria-hidden="true" />
                {{ jobText(a.id) }}
              </div>
              <div
                v-if="a.available && lastUpdate(a.id)"
                class="set-hint agent-update-last"
                :class="{ 'agent-update-failed': !lastUpdate(a.id).ok }"
                :data-test="`agent-update-last-${a.id}`"
              >
                <span>{{ lastUpdateText(a.id) }}</span>
                <span v-if="lastUpdateWhy(a)" class="agent-update-why">{{ lastUpdateWhy(a) }}</span>
                <code v-if="!lastUpdate(a.id).ok && lastUpdate(a.id).detail" class="agent-update-detail">{{ lastUpdate(a.id).detail }}</code>
                <span class="agent-update-last-actions">
                  <button
                    v-if="jobInUse(a.id)"
                    class="exit-btn"
                    type="button"
                    :data-test="`close-reopen-${a.id}`"
                    @click="emit('close-reopen-agent-update', a.id)"
                  >
                    {{ t('settings.agents.closeReopen', 'Close and reopen them') }}
                  </button>
                  <button
                    v-if="lastUpdate(a.id).file"
                    class="exit-btn"
                    type="button"
                    :data-test="`view-update-log-${a.id}`"
                    @click="emit('open-update-log', lastUpdate(a.id).file)"
                  >
                    {{ t('settings.agents.viewLog', 'View log') }}
                  </button>
                </span>
              </div>

            </div>
            <div v-if="(a.available && updateRow(a.id)?.update) || (agentUpdateJobs[a.id] && ['waiting-stop', 'restarting'].includes(agentUpdateJobs[a.id].phase))" class="agent-set-update-actions">
              <button
                v-if="a.available && updateRow(a.id) && updateRow(a.id).update"
                class="exit-btn agent-update-btn"
                type="button"
                :data-test="`update-agent-${a.id}`"
                :disabled="jobActive(a.id)"
                @click="emit('update-agent', a.id)"
              >
                <LoaderCircle v-if="jobRunning(a.id)" :size="11" class="sb-spin agent-update-spinner" aria-hidden="true" />
                {{ jobActive(a.id) ? t('settings.agents.updating', 'Updating…') : t('settings.agents.update', 'Update') }}
              </button>
              <button
                v-if="a.available && updateRow(a.id) && updateRow(a.id).update && !jobActive(a.id)"
                class="exit-btn"
                type="button"
                :data-test="`update-agent-pane-${a.id}`"
                :title="t('settings.agents.runInTerminalTitle', 'Run the update in a terminal pane, to see its output as it goes')"
                @click="emit('update-agent-in-pane', a.id)"
              >
                {{ t('settings.agents.runInTerminal', 'Run in a terminal') }}
              </button>
              <button
                v-if="agentUpdateJobs[a.id] && ['waiting-stop', 'restarting'].includes(agentUpdateJobs[a.id].phase)"
                class="exit-btn"
                type="button"
                :title="t('settings.agents.stopWaitingTitle', 'Stop waiting for its panes (they keep running as they are)')"
                @click="emit('cancel-agent-update', a.id)"
              >
                {{ t('settings.agents.stopWaiting', 'Stop waiting') }}
              </button>

            </div>
          </div>
          <!-- Its default model and effort (Orca's model per agent). -->
          <div v-if="a.available && hasModelDefaults(a.id)" class="agent-models" :data-test="`agent-models-${a.id}`">
            <label class="agent-model-field">
              <span class="set-hint">{{ t('settings.agents.defaultModel', 'Model') }}</span>
              <ThemedSelect
                class="set-select"
                :data-test="`agent-model-${a.id}`"
                @change="setDefaultModel(a.id, $event.target.value)"
              >
                <option value="" :selected="!modelDefaults(a.id)">{{ t('pane.sessionOptions.agentDefault', "Agent's own default") }}</option>
                <option
                  v-for="m in defaultModelRows(a.id)"
                  :key="m.id"
                  :value="m.id"
                  :selected="!!modelDefaults(a.id) && modelDefaults(a.id).model === m.id"
                >
                  {{ m.label }}
                </option>
              </ThemedSelect>
            </label>
            <template v-for="o in defaultOptionRows(a.id)" :key="o.id">
              <label v-if="o.kind.type === 'select'" class="agent-model-field">
                <span class="set-hint">{{ sessionOptionLabel(o) }}</span>
                <ThemedSelect
                  class="set-select"
                  :data-test="`agent-option-${a.id}-${o.id}`"
                  @change="setDefaultOption(a.id, o.id, $event.target.value)"
                >
                  <option value="" :selected="modelDefaults(a.id)[o.id] === undefined">{{ t('pane.sessionOptions.valueIsDefault', 'Default') }}</option>
                  <option v-for="c in o.kind.choices" :key="c.value" :value="c.value" :selected="modelDefaults(a.id)[o.id] === c.value">
                    {{ sessionChoiceLabel(c) }}
                  </option>
                </ThemedSelect>
              </label>
              <label v-else class="agent-model-field agent-model-switch">
                <span class="set-hint">{{ sessionOptionLabel(o) }}</span>
                <input
                  type="checkbox"
                  class="set-switch"
                  :data-test="`agent-option-${a.id}-${o.id}`"
                  :checked="modelDefaults(a.id)[o.id] === undefined ? o.kind.defaultValue : modelDefaults(a.id)[o.id] === true"
                  @change="setDefaultOption(a.id, o.id, $event.target.checked)"
                />
              </label>
            </template>
            <button
              v-if="canProbeModels(a.id)"
              class="exit-btn"
              type="button"
              :data-test="`agent-models-refresh-${a.id}`"
              :disabled="probeFor(a.id).busy"
              :title="t('settings.agents.refreshModelsHint', 'Ask {{name}} which models it offers (it may use its sign-in and the network; no prompt is sent)', { name: a.name })"
              @click="refreshAgentModels(a)"
            >
              <LoaderCircle v-if="probeFor(a.id).busy" :size="11" class="sb-spin agent-update-spinner" aria-hidden="true" />
              {{ t('settings.agents.refreshModels', 'Refresh models') }}
            </button>
            <div class="set-hint agent-models-status" :class="{ 'agent-update-failed': !!probeFor(a.id).error }" :data-test="`agent-models-status-${a.id}`">
              {{ modelListText(a) }}
              <template v-if="defaultHasLiveFast(a.id)"> {{ t('settings.agents.fastModeLive', 'Fast mode is switched in a running pane (pane menu > Model).') }}</template>
              {{ modelDefaults(a.id) ? t('settings.agents.modelApplies', 'Applies to panes you start from now on; running ones show Restart to apply.') : '' }}
            </div>
          </div>
          <div v-if="openAgent === a.id" class="agent-custom">
            <label class="agent-field">
              <span class="set-hint">{{ t('settings.agents.command', 'Command') }}</span>
              <input
                class="set-number mcp-input"
                spellcheck="false"
                :placeholder="a.command"
                :value="agentPref(a.id).command || ''"
                @change="setAgentPref(a.id, 'command', $event.target.value)"
              />
            </label>
            <label class="agent-field">
              <span class="set-hint">{{ t('settings.agents.arguments', 'Arguments (replace the Yolo option when set)') }}</span>
              <input
                class="set-number mcp-input"
                spellcheck="false"
                :placeholder="
                  YOLO_ARGS[a.id]
                    ? t('settings.agents.yoloAdds', 'Yolo adds: {{args}}', { args: YOLO_ARGS[a.id] })
                    : t('settings.agents.argsExample', 'e.g. --model …')
                "
                :value="agentPref(a.id).args || ''"
                @change="setAgentPref(a.id, 'args', $event.target.value)"
              />
            </label>
            <label class="agent-field">
              <span class="set-hint" v-text="envHint(a.id)"></span>
              <textarea
                class="set-number mcp-input agent-env"
                rows="3"
                spellcheck="false"
                :value="agentPref(a.id).env || ''"
                @change="setAgentPref(a.id, 'env', $event.target.value)"
              ></textarea>
            </label>
            <p v-if="envErrors[a.id]" class="mcp-error">
              {{ envErrors[a.id] }} {{ t('settings.agents.notUsedUntilFixed', 'Not used until fixed.') }}
            </p>
            <div class="agent-custom-foot">
              <span class="set-hint">{{ t('settings.agents.appliesFromNow', 'Applies to panes you start from now on') }}</span>
              <button class="exit-btn" type="button" :disabled="!customized(a.id)" @click="resetAgent(a.id)">
                {{ t('settings.agents.reset', 'Reset') }}
              </button>
            </div>
          </div>
        </div>
        <!-- The last update attempts (kept by Tessel, at most 20). -->
        <div v-if="updateHistory.length" class="agent-update-history" data-test="agent-update-history">
          <button
            class="agent-update-history-toggle"
            type="button"
            :aria-expanded="historyOpen"
            @click="historyOpen = !historyOpen"
          >
            {{ historyOpen ? '▾' : '▸' }}
            {{ historyTitle }}
          </button>
          <ul v-if="historyOpen" class="agent-update-history-list">
            <li
              v-for="(e, i) in updateHistory"
              :key="`${e.agentId}-${e.at}-${i}`"
              :class="{ 'agent-update-failed': !e.ok }"
              data-test="agent-update-history-entry"
            >
              <span class="set-hint">{{ whenText(e.at) }}</span>
              <span>{{ e.name }}</span>
              <span class="set-hint">{{ versionsText(e) }}</span>
              <span>{{ updateKindLabel(e.kind) }}</span>
              <span v-if="e.via === 'pane'" class="set-hint">{{ t('settings.agents.viaPane', 'in a terminal') }}</span>
              <span v-else-if="e.auto" class="set-hint">{{ t('settings.agents.viaAuto', 'automatic') }}</span>
              <button v-if="e.file" class="exit-btn" type="button" @click="emit('open-update-log', e.file)">
                {{ t('settings.agents.viewLog', 'View log') }}
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>
