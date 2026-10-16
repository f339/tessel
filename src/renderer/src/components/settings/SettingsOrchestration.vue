<script setup>
// Settings > Orchestration: agents working as a team, their hooks and how
// to ask for teamwork.
import { ref, computed, onMounted } from 'vue'
import ThemedSelect from '../ui/ThemedSelect.vue'
import { t } from '../../i18n'
import BrandIcon from '../BrandIcon.vue'
import SettingsToolRows from '../SettingsToolRows.vue'
import { settings, clamp } from '../../settings'
import { ORCHESTRATION_EXAMPLES, ORCHESTRATION_TOOLS } from '../../orchestrationGuide'
import { WORKER_AGENTS, MAX_CONCURRENT_LIMIT, NESTED_DEPTH_LIMIT } from '../../../../shared/orchestration'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const props = defineProps({
  // Built-in and your own agents, with `available` (found on the PATH).
  agents: { type: Array, default: () => [] }
})
const { shown, openMcpTab, emit } = useSettingsShell()

// Settings > Orchestration: which agents can work as a team (Tessel's team
// tools and hooks set up in them), and how to ask for it.
const coverage = ref(null) // [{ id, name, state: 'ready'|'missing'|'approval' }] | { error }
// Agent hooks: the node they run ({ found, path, error }), and the copies
// Tessel kept of the agents' files before its first change.
const hookNode = ref(null)
const hookBackups = ref([])
async function loadCoverage() {
  if (!window.shellApi.teamHooksStatus) return
  try {
    const res = await window.shellApi.teamHooksStatus()
    hookNode.value = res && res.node ? res.node : null
    hookBackups.value = res && Array.isArray(res.backups) ? res.backups : []
    const rows = (res && Array.isArray(res.agents) ? res.agents : [])
      // Status-only hooks bring no team messages (agentStatusHooks.js).
      .filter((r) => !r.statusOnly && props.agents.some((a) => a.id === r.id && a.available))
      .map((r) => ({
        id: r.id,
        name: (props.agents.find((a) => a.id === r.id) || {}).name || r.id,
        state:
          r.error || r.hooks !== 'installed'
            ? 'missing'
            : r.approval === 'needs-approval' || r.approval === 'changed'
              ? 'approval'
              : 'ready'
      }))
    coverage.value = rows
  } catch (err) {
    coverage.value = { error: (err && err.message) || t('settings.orchestration.unknownError', 'unknown error') }
  }
}
onMounted(loadCoverage)
// Settings > Orchestration > Agent hooks: remove every hook Tessel added.
const removingHooks = ref(false)
const removeHooksResult = ref('')
async function removeTesselHooks() {
  if (!window.shellApi.teamRemoveHooks || removingHooks.value) return
  removingHooks.value = true
  removeHooksResult.value = ''
  try {
    const res = await window.shellApi.teamRemoveHooks()
    const errors = res && Array.isArray(res.errors) ? res.errors : []
    removeHooksResult.value = errors.length
      ? t('settings.orchestration.removeHooksFailed', 'Some hooks could not be removed: {{errors}}', { errors: errors.join(' ') })
      : t('settings.orchestration.removeHooksDone', 'Tessel hooks removed.')
  } catch (err) {
    removeHooksResult.value = t('settings.orchestration.removeHooksFailed', 'Some hooks could not be removed: {{errors}}', { errors: (err && err.message) || '' })
  } finally {
    removingHooks.value = false
    loadCoverage()
  }
}
const hookBackupsLine = computed(() =>
  t('settings.orchestration.hooksBackups', 'Copies kept: {{files}}', { files: hookBackups.value.join(', ') })
)
// Cursor's status hooks turned off: Tessel's entries leave its hooks.json now.
function setCursorHooks(e) {
  settings.cursorStatusHooks = !!e.target.checked
  if (!settings.cursorStatusHooks && window.shellApi.prepareAgentStatus)
    window.shellApi.prepareAgentStatus('cursor', { cursor: false }).catch(() => {})
}
const coverageSummary = computed(() => {
  const c = coverage.value
  if (!c) return t('settings.orchestration.checking', 'Checking your agents…')
  if (c.error) return t('settings.orchestration.checkFailed', 'Could not check: {{error}}', { error: c.error })
  if (!c.length)
    return t('settings.orchestration.noAgents', 'No agent with team tools found. Install agents in Settings > Agents, then check again.')
  const ready = c.filter((r) => r.state === 'ready').length
  return ready === c.length
    ? t('settings.orchestration.allReady', 'All {{count}} agents can work as a team.', { count: c.length })
    : t('settings.orchestration.someReady', '{{ready}} of {{count}} agents can work as a team.', { ready, count: c.length })
})
// Coordinator and workers: the agents that can be started as workers (their
// team tools ready), and the limits (whole numbers in their range).
const workerAgentsReady = computed(() =>
  Array.isArray(coverage.value) ? coverage.value.filter((r) => r.state === 'ready' && WORKER_AGENTS.includes(r.id)).map((r) => r.name) : []
)
const workerAgentsLine = computed(() =>
  workerAgentsReady.value.length
    ? t('settings.orchestration.setupAgents', 'Agents that can be workers: {{agents}}', { agents: workerAgentsReady.value.join(', ') })
    : t('settings.orchestration.setupNoAgents', 'No agent that can be a worker is ready (Claude Code, Codex, Gemini or Qwen, with the team tools)')
)
const maxWorkersHint = computed(() =>
  t('settings.orchestration.maxWorkersHint', 'Per coordinator (1 to {{max}}); the others wait in a queue and start when one ends', { max: MAX_CONCURRENT_LIMIT })
)
const maxDepthHint = computed(() =>
  t('settings.orchestration.maxDepthHint', "1: the lead's workers cannot start workers of their own; 2: they can, once; up to {{max}}", { max: NESTED_DEPTH_LIMIT })
)
function setOrchestrationNumber(key, max, e) {
  const n = parseInt(e.target.value, 10)
  if (Number.isFinite(n)) settings[key] = clamp(n, 1, max)
  e.target.value = settings[key]
}
const copiedExample = ref('')
function copyExample(ex) {
  if (navigator.clipboard) navigator.clipboard.writeText(ex.prompt).catch(() => {})
  copiedExample.value = ex.id
  setTimeout(() => {
    if (copiedExample.value === ex.id) copiedExample.value = ''
  }, 1500)
}
</script>

<template>
  <section
    id="set-orchestration"
    class="set-page"
    data-page="orchestration"
    :hidden="!shown('orchestration')"
    aria-labelledby="set-orchestration-title"
  >
    <header class="set-page-head">
      <h2 id="set-orchestration-title">{{ PAGES.orchestration.title }}</h2>
      <p class="set-page-desc">{{ PAGES.orchestration.desc }}</p>
    </header>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.orchestration.yourTeam', 'Your team') }}</h3>
      <div class="set-card">
        <p class="set-hint set-card-text">
          {{ t('settings.orchestration.intro', 'Agents in a team (Sessions) coordinate through Tessel: they give each other cards, wait for the cards before theirs, ask and answer, report when done, and ask you to decide. You follow it on the task board.') }}
        </p>
        <div class="agents-head">
          <span class="set-hint">{{ coverageSummary }}</span>
          <span class="agent-set-actions">
            <button class="exit-btn" type="button" @click="loadCoverage">{{ t('settings.orchestration.checkAgain', 'Check again') }}</button>
            <button class="exit-btn" type="button" @click="openMcpTab('connections')">{{ t('settings.orchestration.details', 'Details') }}</button>
          </span>
        </div>
        <div v-if="Array.isArray(coverage) && coverage.length" class="orch-coverage">
          <span v-for="r in coverage" :key="r.id" class="orch-chip" :class="r.state" :data-agent="r.id">
            <BrandIcon :kind="r.id" :size="13" />{{ r.name }}:
            {{
              r.state === 'ready'
                ? t('settings.orchestration.ready', 'ready')
                : r.state === 'approval'
                  ? t('settings.orchestration.needsApproval', 'needs your approval')
                  : t('settings.orchestration.notSetUp', 'not set up')
            }}
          </span>
        </div>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.orchestration.wakeUps', 'Wake idle agents for team messages') }}
            <span class="set-hint">{{ t('settings.orchestration.wakeUpsHint', 'Types a one-line reminder in an idle agent\'s terminal, never while you are in that pane or typing there (nothing else can start an idle agent). Off: messages wait until the agent next works') }}</span>
          </div>
          <input v-model="settings.teamWakeUps" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row" :class="{ 'set-disabled': !settings.teamWakeUps }">
          <div class="set-label">
            {{ t('settings.orchestration.wakeUnconfirmed', 'Wake agents even without confirmation (like other tools)') }}
            <span class="set-hint">{{ t('settings.orchestration.wakeUnconfirmedHint', 'Also types the reminder into an agent whose hooks have not confirmed it is idle yet (a Codex relaunched in place), with the same checks: never while you type there, over a draft, an approval or an unsent line. Off: Tessel asks you first') }}</span>
            <span v-if="settings.teamWakeUnconfirmed" class="set-hint set-warn" data-wake-unconfirmed-warning="">{{ t('settings.orchestration.wakeUnconfirmedWarn', 'Risk: without that confirmation the line could land in a program that crashed or at a bad moment in the agent.') }}</span>
          </div>
          <input v-model="settings.teamWakeUnconfirmed" type="checkbox" class="set-switch" data-setting="teamWakeUnconfirmed" :disabled="!settings.teamWakeUps" />
        </label>
      </div>
    </div>
    <SettingsToolRows page="orchestration" @open="emit('open-tool', $event)" />
    <!-- The hooks Tessel adds to the agents: Cursor's opt-in, and
         removing them all (before uninstalling Tessel). -->
    <div class="set-group" data-agent-hooks="">
      <h3 class="set-group-title">{{ t('settings.orchestration.hooksTitle', 'Agent hooks') }}</h3>
      <div class="set-card">
        <p class="set-hint set-card-text">
          {{ t('settings.orchestration.hooksIntro', "Tessel adds small hooks to your agents' settings so it can show what each agent is doing and hand it team messages. Only Tessel's own entries are added; your other hooks and settings stay as they are.") }}
        </p>
        <p v-if="hookNode && !hookNode.found" class="set-hint set-warn set-card-text" data-hooks-no-node="">{{ hookNode.error }}</p>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.orchestration.cursorHooks', 'Cursor status hooks') }}
            <span class="set-hint">{{ t('settings.orchestration.cursorHooksHint', "Shows whether Cursor is working or waiting for you. Its hooks file (~/.cursor/hooks.json) is read by both the Cursor CLI and the Cursor editor, and its prompt hook must answer before every prompt: if it failed, or stayed behind after Tessel is gone, Cursor could refuse your prompts. Off by default; turning it off removes Tessel's entries.") }}</span>
          </div>
          <input :checked="settings.cursorStatusHooks" type="checkbox" class="set-switch" data-setting="cursorStatusHooks" @change="setCursorHooks" />
        </label>
        <div class="set-row">
          <div class="set-label">
            {{ t('settings.orchestration.removeHooks', 'Remove Tessel hooks') }}
            <span class="set-hint">{{ t('settings.orchestration.removeHooksHint', "Removes every hook, plugin and extension Tessel added to your agents, and the copies it kept of their files before its first change (files ending in .before-tessel). Do this before uninstalling Tessel: the uninstaller does not touch your agents' settings. Tessel adds them back the next time it starts one of these agents.") }}</span>
            <span v-if="hookBackups.length" class="set-hint" data-hooks-backups="" v-text="hookBackupsLine"></span>
            <span v-if="removeHooksResult" class="set-hint" data-hooks-removed="">{{ removeHooksResult }}</span>
          </div>
          <button class="exit-btn" type="button" data-remove-hooks="" :disabled="removingHooks" @click="removeTesselHooks">{{ t('settings.orchestration.removeHooksButton', 'Remove') }}</button>
        </div>
      </div>
    </div>
    <!-- Coordinator and workers (Orca's orchestration): the setup card,
         then the limits and the confirmation. -->
    <div class="set-group" data-orch-workers="">
      <h3 class="set-group-title">{{ t('settings.orchestration.workers', 'Coordinator and workers') }}</h3>
      <div class="set-card">
        <p class="set-hint set-card-text">
          {{ t('settings.orchestration.workersIntro', 'A team lead can start workers: new agents in new panes of its project, each with its own card, brief and, by default, its own copy of the project. They join the team, report when done and send a heartbeat while they work. You see each start on the board and in Activity.') }}
        </p>
        <p class="set-hint set-card-text" data-orch-trust="">
          {{ t('settings.orchestration.trust', 'Each worker request is signed with a secret only its pane has, and Tessel checks who sent it and whether it may still do it; answers (like what a worker shows) are encrypted for the agent that asked. This keeps one agent from posing as another by mistake or on the cheap. All agents run as your Windows user, so it cannot stop a determined program running as you.') }}
        </p>
        <ol class="orch-setup" data-orch-setup="">
          <li :class="{ ok: workerAgentsReady.length > 0 }" v-text="workerAgentsLine"></li>
          <li>{{ t('settings.orchestration.setupTeam', 'Make a team in Sessions and choose its lead (right-click an agent, Make Lead)') }}</li>
          <li>{{ t('settings.orchestration.setupAsk', 'Ask the lead to coordinate workers (see "Coordinate workers" below)') }}</li>
        </ol>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.orchestration.confirmWorkers', 'Ask before an agent starts workers') }}
            <span class="set-hint">{{ t('settings.orchestration.confirmWorkersHint', 'Each worker waits in the Tasks panel until you allow it. Off: workers start at once, within the limits below') }}</span>
          </div>
          <input v-model="settings.orchestrationConfirmWorkers" type="checkbox" class="set-switch" data-setting="orchestrationConfirmWorkers" />
        </label>
        <div class="set-row">
          <label class="set-label" for="settings-orch-max">
            {{ t('settings.orchestration.maxWorkers', 'Workers at a time') }}
            <span class="set-hint" v-text="maxWorkersHint"></span>
          </label>
          <input
            id="settings-orch-max"
            class="set-number"
            type="number"
            min="1"
            :max="MAX_CONCURRENT_LIMIT"
            :value="settings.orchestrationMaxWorkers"
            data-setting="orchestrationMaxWorkers"
            @change="setOrchestrationNumber('orchestrationMaxWorkers', MAX_CONCURRENT_LIMIT, $event)"
          />
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-orch-depth">
            {{ t('settings.orchestration.maxDepth', 'Nested worker depth') }}
            <span class="set-hint" v-text="maxDepthHint"></span>
          </label>
          <input
            id="settings-orch-depth"
            class="set-number"
            type="number"
            min="1"
            :max="NESTED_DEPTH_LIMIT"
            :value="settings.orchestrationMaxDepth"
            data-setting="orchestrationMaxDepth"
            @change="setOrchestrationNumber('orchestrationMaxDepth', NESTED_DEPTH_LIMIT, $event)"
          />
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-orch-mode">
            {{ t('settings.orchestration.workerMode', 'Mode for new workers') }}
            <span class="set-hint">{{
              t('settings.orchestration.workerModeHint', 'Claude and Codex can work in a chat pane, without a terminal. Other agents use a terminal pane. This applies to the next workers; it does not change those already open.')
            }}</span>
          </label>
          <ThemedSelect id="settings-orch-mode" v-model="settings.orchestrationWorkerMode" class="set-select" data-setting="orchestrationWorkerMode">
            <option value="terminal">{{ t('settings.orchestration.workerModeTerminal', 'A terminal pane') }}</option>
            <option value="chat">{{ t('settings.orchestration.workerModeChat', 'A chat pane (Claude, Codex)') }}</option>
          </ThemedSelect>
        </div>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.orchestration.tools', 'The team tools') }}</h3>
      <div class="set-card">
        <ul class="orch-tools">
          <li v-for="[name, what] in ORCHESTRATION_TOOLS" :key="name"><code>{{ name }}</code> {{ what }}</li>
        </ul>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.orchestration.howTo', 'How to use it') }}</h3>
      <div class="set-card">
        <p class="set-hint set-card-text">
          {{ t('settings.orchestration.howToIntro', 'Tell the agent that leads the team, in your own words, for example:') }}
        </p>
        <div v-for="ex in ORCHESTRATION_EXAMPLES" :key="ex.id" class="orch-example">
          <div class="set-label">
            {{ ex.title }}
            <span class="set-hint">{{ ex.prompt }}</span>
          </div>
          <button class="exit-btn" type="button" @click="copyExample(ex)">
            {{ copiedExample === ex.id ? t('settings.orchestration.copied', 'Copied') : t('settings.orchestration.copy', 'Copy') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
