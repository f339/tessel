<script setup>
// Settings > Orchestration: agents working as a team. Three groups: Team
// (which agents have the team tools, and waking idle ones), Coordinator and
// workers, Agent hooks (how each agent gets its team messages, Cursor's
// opt-in, removing them all); then the windows of the page, and "How to ask
// for teamwork" (example prompts, the team tools, what keeps agents apart),
// folded until opened or a search finds something in it.
import { ref, computed, inject, onMounted } from 'vue'
import ThemedSelect from '../ui/ThemedSelect.vue'
import { t } from '../../i18n'
import BrandIcon from '../BrandIcon.vue'
import SettingsToolRows from '../SettingsToolRows.vue'
import McpTeamConnections from '../mcp/McpTeamConnections.vue'
import { settings, clamp } from '../../settings'
import { ORCHESTRATION_EXAMPLES, ORCHESTRATION_TOOLS } from '../../orchestrationGuide'
import { WORKER_AGENTS, MAX_CONCURRENT_LIMIT, NESTED_DEPTH_LIMIT } from '../../../../shared/orchestration'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const props = defineProps({
  // Built-in and your own agents, with `available` (found on the PATH).
  agents: { type: Array, default: () => [] }
})
const { shown, searching, go, emit } = useSettingsShell()
const askConfirm = inject('askConfirm', null)

// Team: which agents can work as a team (Tessel's team tools and hooks set
// up in them), read from the hooks' status (src/main/teamHooksStatus.js).
const coverage = ref(null) // [{ id, name, state: 'ready'|'missing'|'approval' }] | { error }
const checking = ref(false)
// Agent hooks: the node they run ({ found, path, error }), and the copies
// Tessel kept of the agents' files before its first change.
const hookNode = ref(null)
const hookBackups = ref([])
async function loadCoverage() {
  if (!window.shellApi.teamHooksStatus || checking.value) return
  checking.value = true
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
  } finally {
    checking.value = false
  }
}
onMounted(loadCoverage)
const coverageRows = computed(() => (Array.isArray(coverage.value) ? coverage.value : []))
const coverageError = computed(() => (coverage.value && !Array.isArray(coverage.value) ? coverage.value.error : ''))
const coverageSummary = computed(() => {
  const c = coverage.value
  if (!c) return t('settings.orchestration.checking', 'Checking your agents…')
  if (c.error) return t('settings.orchestration.checkFailedShort', 'Could not check your agents.')
  if (!c.length) return t('settings.orchestration.noAgentsShort', 'No agent with the team tools yet: install one in Agents, then check again.')
  const ready = c.filter((r) => r.state === 'ready').length
  return ready === c.length
    ? t('settings.orchestration.allReady', 'All {{count}} agents can work as a team.', { count: c.length })
    : t('settings.orchestration.someReady', '{{ready}} of {{count}} agents can work as a team.', { ready, count: c.length })
})
const TAG = { ready: 'tag-ok', approval: 'tag-warn', missing: 'tag-danger' }
function stateText(state) {
  if (state === 'ready') return t('settings.orchestration.ready', 'ready')
  if (state === 'approval') return t('settings.orchestration.needsApproval', 'needs your approval')
  return t('settings.orchestration.notSetUp', 'not set up')
}

// Coordinator and workers: the agents that can be started as workers (their
// team tools ready), and the limits (whole numbers in their range).
const workerAgentsReady = computed(() => coverageRows.value.filter((r) => r.state === 'ready' && WORKER_AGENTS.includes(r.id)).map((r) => r.name))
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

// Agent hooks > Team connections: how each agent gets its team messages
// (McpTeamConnections reads the hooks itself when it opens). Folded: the
// Team group already shows each agent's state, and it lists every hook.
const connectionsOpen = ref(false)
// Cursor's status hooks turned off: Tessel's entries leave its hooks.json now.
function setCursorHooks(e) {
  settings.cursorStatusHooks = !!e.target.checked
  if (!settings.cursorStatusHooks && window.shellApi.prepareAgentStatus)
    window.shellApi.prepareAgentStatus('cursor', { cursor: false }).catch(() => {})
}
// Remove every hook Tessel added, and the copies it kept: asked first, as
// the copies are gone for good (Tessel adds the hooks back on its next start).
const removingHooks = ref(false)
const removeHooksResult = ref(null) // { ok } | { errors: [] }
async function removeTesselHooks() {
  if (!window.shellApi.teamRemoveHooks || removingHooks.value) return
  const question = {
    title: t('settings.orchestration.removeHooksConfirmTitle', 'Remove Tessel hooks?'),
    text: t('settings.orchestration.removeHooksConfirmText', 'Tessel removes its hooks, plugins and extensions from your agents, and the copies it kept of their files. It adds the hooks back the next time it starts one of these agents.'),
    confirmLabel: t('settings.orchestration.removeHooksButton', 'Remove'),
    danger: true
  }
  const ok = askConfirm ? await askConfirm(question) : window.confirm(question.title)
  if (ok !== true) return
  removingHooks.value = true
  removeHooksResult.value = null
  try {
    const res = await window.shellApi.teamRemoveHooks()
    const errors = res && Array.isArray(res.errors) ? res.errors : []
    removeHooksResult.value = errors.length ? { errors } : { ok: true }
  } catch (err) {
    removeHooksResult.value = { errors: [(err && err.message) || t('settings.orchestration.unknownError', 'unknown error')] }
  } finally {
    removingHooks.value = false
    loadCoverage()
  }
}
const backupsLabel = computed(() => t('settings.orchestration.backupsCount', 'Copies Tessel kept ({{count}})', { count: hookBackups.value.length }))

// How to ask for teamwork: folded, opened by its title or by a search that
// finds something in it (and folded again when the search ends, unless it
// was opened by hand).
const guideOpen = ref(false)
function onGuideToggle(e) {
  if (!searching.value) guideOpen.value = e.target.open
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

    <!-- Team: who can work as a team, and waking the idle ones. -->
    <div class="set-group" data-orch-team="">
      <h3 class="set-group-title">{{ t('settings.orchestration.team', 'Team') }}</h3>
      <p class="set-group-desc">{{ t('settings.orchestration.teamDesc', 'Agents in a team (Sessions) give each other cards, ask, answer and report; you follow them on the task board.') }}</p>
      <div class="set-card">
        <div class="set-row orch-team-status" data-orch-coverage="">
          <div class="set-label">
            {{ t('settings.orchestration.agentsReady', 'Agents with the team tools') }}
            <span class="set-hint" role="status">{{ coverageSummary }}</span>
            <details v-if="coverageError" class="set-more" data-orch-check-error="">
              <summary>{{ t('settings.orchestration.details', 'Details') }}</summary>
              <p class="orch-raw">{{ coverageError }}</p>
            </details>
            <span v-if="coverageRows.length" class="orch-tags">
              <span v-for="r in coverageRows" :key="r.id" class="tag orch-tag" :class="TAG[r.state]" :data-agent="r.id" :data-state="r.state">
                <BrandIcon :kind="r.id" :size="12" />{{ r.name }} · {{ stateText(r.state) }}
              </span>
            </span>
          </div>
          <span class="orch-team-actions">
            <button v-if="Array.isArray(coverage) && !coverage.length" class="exit-btn small" type="button" data-orch-open-agents="" @click="go('agents')">{{ t('settings.orchestration.openAgents', 'Open Agents') }}</button>
            <button class="exit-btn small" type="button" data-orch-check="" :disabled="checking" @click="loadCoverage">{{ t('settings.orchestration.checkAgain', 'Check again') }}</button>
          </span>
        </div>
        <div class="set-row">
          <div class="set-label">
            <label for="settings-orch-wake">{{ t('settings.orchestration.wakeUps', 'Wake idle agents for team messages') }}</label>
            <span class="set-hint">{{ t('settings.orchestration.wakeUpsShort', "Types a one-line reminder in an idle agent's terminal; off, messages wait for its next turn") }}</span>
            <details class="set-more">
              <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
              <p>{{ t('settings.orchestration.wakeUpsHint', 'Types a one-line reminder in an idle agent\'s terminal, never while you are in that pane or typing there (nothing else can start an idle agent). Off: messages wait until the agent next works') }}</p>
            </details>
          </div>
          <input id="settings-orch-wake" v-model="settings.teamWakeUps" type="checkbox" class="set-switch" data-setting="teamWakeUps" />
        </div>
        <div class="set-row set-row-nested" :class="{ 'set-disabled': !settings.teamWakeUps }">
          <div class="set-label">
            <label for="settings-orch-wake-unconfirmed">{{ t('settings.orchestration.wakeUnconfirmed', 'Wake agents even without confirmation (like other tools)') }}</label>
            <span class="set-hint">{{ t('settings.orchestration.wakeUnconfirmedShort', 'Also an agent whose hooks have not confirmed it is idle yet; off, Tessel asks you first') }}</span>
            <details class="set-more">
              <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
              <p>{{ t('settings.orchestration.wakeUnconfirmedHint', 'Also types the reminder into an agent whose hooks have not confirmed it is idle yet (a Codex relaunched in place), with the same checks: never while you type there, over a draft, an approval or an unsent line. Off: Tessel asks you first') }}</p>
            </details>
            <span v-if="settings.teamWakeUnconfirmed" class="set-hint set-warn" data-wake-unconfirmed-warning="">{{ t('settings.orchestration.wakeUnconfirmedWarn', 'Risk: without that confirmation the line could land in a program that crashed or at a bad moment in the agent.') }}</span>
          </div>
          <input id="settings-orch-wake-unconfirmed" v-model="settings.teamWakeUnconfirmed" type="checkbox" class="set-switch" data-setting="teamWakeUnconfirmed" :disabled="!settings.teamWakeUps" />
        </div>
      </div>
    </div>

    <!-- Coordinator and workers: how to start, then the confirmation and
         the limits. -->
    <div class="set-group" data-orch-workers="">
      <h3 class="set-group-title">{{ t('settings.orchestration.workers', 'Coordinator and workers') }}</h3>
      <p class="set-group-desc">{{ t('settings.orchestration.workersDesc', 'A team lead can start workers: new agents in new panes, each with its own card, brief and copy of the project.') }}</p>
      <div class="set-card">
        <ol class="orch-setup orch-steps" data-orch-setup="">
          <li :class="{ ok: workerAgentsReady.length > 0 }" v-text="workerAgentsLine"></li>
          <li>{{ t('settings.orchestration.setupTeam', 'Make a team in Sessions and choose its lead (right-click an agent, Make Lead)') }}</li>
          <li>{{ t('settings.orchestration.setupAskGuide', 'Ask the lead to coordinate workers (examples in "How to ask for teamwork" below)') }}</li>
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
            class="set-number set-number-short"
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
            class="set-number set-number-short"
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
            <span class="set-hint">{{ t('settings.orchestration.workerModeShort', 'Claude and Codex can work in a chat pane, other agents in a terminal; workers already open stay') }}</span>
          </label>
          <ThemedSelect id="settings-orch-mode" v-model="settings.orchestrationWorkerMode" class="set-select" data-setting="orchestrationWorkerMode">
            <option value="terminal">{{ t('settings.orchestration.workerModeTerminal', 'A terminal pane') }}</option>
            <option value="chat">{{ t('settings.orchestration.workerModeChat', 'A chat pane (Claude, Codex)') }}</option>
          </ThemedSelect>
        </div>
      </div>
    </div>

    <!-- The hooks Tessel adds to the agents: how each one gets its team
         messages (the team connections), Cursor's opt-in, and removing
         them all (before uninstalling Tessel). -->
    <div class="set-group" data-agent-hooks="">
      <h3 class="set-group-title">{{ t('settings.orchestration.hooksTitle', 'Agent hooks') }}</h3>
      <p class="set-group-desc">
        {{ t('settings.orchestration.hooksDesc', "Small hooks in your agents' settings tell Tessel what each one does and hand it team messages.") }}
      </p>
      <details class="set-more orch-group-more">
        <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
        <p>{{ t('settings.orchestration.hooksIntro', "Tessel adds small hooks to your agents' settings so it can show what each agent is doing and hand it team messages. Only Tessel's own entries are added; your other hooks and settings stay as they are.") }}</p>
      </details>
      <div class="set-card">
        <div v-if="hookNode && !hookNode.found" class="set-callout warn" data-hooks-no-node="">
          <span class="set-callout-text">{{ hookNode.error }}</span>
        </div>
        <div class="set-row" data-team-connections="">
          <div class="set-label">
            {{ t('settings.orchestration.connections', 'Team connections') }}
            <span class="set-hint">{{ t('settings.orchestration.connectionsHint', 'How each agent gets its team messages: through its hooks, or a typed reminder when idle') }}</span>
          </div>
          <button
            class="exit-btn small"
            type="button"
            data-orch-connections=""
            :aria-expanded="connectionsOpen ? 'true' : 'false'"
            aria-controls="orch-connections"
            @click="connectionsOpen = !connectionsOpen"
          >
            {{ connectionsOpen ? t('settings.orchestration.hide', 'Hide') : t('settings.orchestration.show', 'Show') }}
          </button>
        </div>
        <div v-if="connectionsOpen" id="orch-connections" class="orch-connections">
          <McpTeamConnections :agents="agents" />
        </div>
        <div class="set-row">
          <div class="set-label">
            <label for="settings-orch-cursor">{{ t('settings.orchestration.cursorHooks', 'Cursor status hooks') }}</label>
            <span class="set-hint">{{ t('settings.orchestration.cursorHooksShort', 'Shows whether Cursor is working or waiting for you (off by default)') }}</span>
            <details class="set-more">
              <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
              <p>{{ t('settings.orchestration.cursorHooksHint', "Shows whether Cursor is working or waiting for you. Its hooks file (~/.cursor/hooks.json) is read by both the Cursor CLI and the Cursor editor, and its prompt hook must answer before every prompt: if it failed, or stayed behind after Tessel is gone, Cursor could refuse your prompts. Off by default; turning it off removes Tessel's entries.") }}</p>
            </details>
          </div>
          <input id="settings-orch-cursor" :checked="settings.cursorStatusHooks" type="checkbox" class="set-switch" data-setting="cursorStatusHooks" @change="setCursorHooks" />
        </div>
        <div class="set-row">
          <div class="set-label">
            {{ t('settings.orchestration.removeHooks', 'Remove Tessel hooks') }}
            <span class="set-hint">{{ t('settings.orchestration.removeHooksShort', "Do this before uninstalling Tessel: the uninstaller leaves your agents' settings as they are") }}</span>
            <details class="set-more">
              <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
              <p>{{ t('settings.orchestration.removeHooksHint', "Removes every hook, plugin and extension Tessel added to your agents, and the copies it kept of their files before its first change (files ending in .before-tessel). Do this before uninstalling Tessel: the uninstaller does not touch your agents' settings. Tessel adds them back the next time it starts one of these agents.") }}</p>
            </details>
            <details v-if="hookBackups.length" class="set-more" data-hooks-backups="">
              <summary>{{ backupsLabel }}</summary>
              <ul class="orch-backups">
                <li v-for="file in hookBackups" :key="file"><span class="sl-path" :title="file">{{ file }}</span></li>
              </ul>
            </details>
            <span v-if="removeHooksResult && removeHooksResult.ok" class="set-hint orch-done" data-hooks-removed="">{{ t('settings.orchestration.removeHooksDone', 'Tessel hooks removed.') }}</span>
            <div v-else-if="removeHooksResult" class="set-callout warn" data-hooks-removed="">
              <span class="set-callout-text">{{ t('settings.orchestration.removeHooksFailedShort', 'Some hooks could not be removed.') }}</span>
              <details class="set-more">
                <summary>{{ t('settings.orchestration.details', 'Details') }}</summary>
                <p class="orch-raw">{{ removeHooksResult.errors.join(' ') }}</p>
              </details>
            </div>
          </div>
          <button class="exit-btn small danger" type="button" data-remove-hooks="" :disabled="removingHooks" @click="removeTesselHooks">{{ t('settings.orchestration.removeHooksButton', 'Remove') }}</button>
        </div>
      </div>
    </div>

    <SettingsToolRows page="orchestration" @open="emit('open-tool', $event)" />

    <!-- How to ask for teamwork: folded (opened by a search that finds
         something in it). The search reads its summary as the group title. -->
    <div class="set-group" data-orch-guide="">
      <details class="orch-guide" :open="guideOpen || searching" @toggle="onGuideToggle">
        <summary class="set-group-title">{{ t('settings.orchestration.guide', 'How to ask for teamwork') }}</summary>
        <p class="set-group-desc">{{ t('settings.orchestration.howToIntro', 'Tell the agent that leads the team, in your own words, for example:') }}</p>
        <div class="set-card">
          <div v-for="ex in ORCHESTRATION_EXAMPLES" :key="ex.id" class="orch-example">
            <div class="set-label">
              {{ ex.title }}
              <span class="set-hint">{{ ex.prompt }}</span>
            </div>
            <button class="exit-btn small" type="button" @click="copyExample(ex)">
              {{ copiedExample === ex.id ? t('settings.orchestration.copied', 'Copied') : t('settings.orchestration.copy', 'Copy') }}
            </button>
          </div>
        </div>
        <h4 class="orch-sub">{{ t('settings.orchestration.tools', 'The team tools') }}</h4>
        <div class="set-card">
          <ul class="orch-tools">
            <li v-for="[name, what] in ORCHESTRATION_TOOLS" :key="name"><code>{{ name }}</code> {{ what }}</li>
          </ul>
        </div>
        <h4 class="orch-sub">{{ t('settings.orchestration.trustTitle', 'What keeps agents apart') }}</h4>
        <div class="set-card">
          <p class="set-hint set-card-text" data-orch-trust="">
            {{ t('settings.orchestration.trust', 'Each worker request is signed with a secret only its pane has, and Tessel checks who sent it and whether it may still do it; answers (like what a worker shows) are encrypted for the agent that asked. This keeps one agent from posing as another by mistake or on the cheap. All agents run as your Windows user, so it cannot stop a determined program running as you.') }}
          </p>
        </div>
      </details>
    </div>
  </section>
</template>

<style scoped>
/* The status row: its tags under the summary, its buttons on the right. */
.orch-team-status {
  align-items: flex-start;
}
.orch-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin-top: 6px;
}
.orch-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.orch-team-actions {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
.set-label > label[for] {
  cursor: pointer;
}
.orch-raw {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  overflow-wrap: anywhere;
  user-select: text;
}
.orch-group-more {
  margin: -4px 0 8px;
}
.orch-done {
  color: #a8e6b4;
}
.orch-backups {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}
.orch-backups li {
  display: flex;
  min-width: 0;
}
.set-callout .set-more {
  flex-basis: 100%;
}
/* How to start workers: three short steps at the top of the card. */
.orch-steps {
  margin: 0;
  padding: 12px 0 10px 20px;
  border-bottom: 1px solid var(--border);
  line-height: 1.6;
}
/* The team connections (McpTeamConnections), unfolded under their row. */
.orch-connections {
  padding: 4px 0 12px;
  border-bottom: 1px solid var(--border);
}
/* Its Check again and Set up again together on the right, its status (when
   it has one) on the left. */
.orch-connections :deep(.mcp-toolbar) {
  justify-content: flex-end;
  gap: 6px;
}
.orch-connections :deep(.mcp-toolbar > .set-hint) {
  margin-right: auto;
}
/* How to ask for teamwork: its title opens it. */
.orch-guide > summary {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  list-style: none;
}
.orch-guide > summary::-webkit-details-marker {
  display: none;
}
.orch-guide > summary::before {
  content: '';
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid var(--text-dim);
  transition: transform 0.12s ease;
}
.orch-guide[open] > summary::before {
  transform: rotate(90deg);
}
.orch-guide > summary:focus-visible {
  border-radius: 3px;
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.orch-guide .orch-sub {
  margin: 16px 0 8px;
  color: var(--text-strong);
}
.orch-guide .orch-example {
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.orch-guide .orch-example:last-child {
  border-bottom: 0;
}
.orch-guide .orch-example .set-label {
  color: var(--text-strong);
  font-size: 13px;
}
</style>
