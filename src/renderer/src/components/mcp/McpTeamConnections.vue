<script setup>
// How each agent gets its team messages (its hooks): the old Team
// connections tab of MCP servers, standalone, for Settings > Orchestration
// (its Agent hooks group) to mount: <McpTeamConnections :agents="agents" />.
//
// Props:  agents - the agent list Settings gets from App.vue ({ id, name,
//                  available }): which agents are installed, and the names of
//                  your own agents.
// Events: none. It reads and acts by itself, through window.shellApi:
//           teamHooksStatus()  - read on mount and on Check again
//                                (src/main/teamHooksStatus.js);
//           installTeamTools() - Set up again (team tools, hooks, memory
//                                rule); its errors show in its own message.
// Styles: the .mcp-* classes in style.css (.mcp-about, .mcp-toolbar,
//         .mcp-server, .mcp-agents, .mcp-status, .mcp-error, .mcp-notice).
import { ref, reactive, computed, onMounted } from 'vue'
import BrandIcon from '../BrandIcon.vue'
import { t } from '../../i18n'
import { ALL_AGENTS, AGENT_NAME } from './mcpShared'

const props = defineProps({
  agents: { type: Array, default: () => [] }
})

const busy = ref('')
const message = reactive({ text: '', kind: 'ok' })
const installed = computed(() =>
  Object.fromEntries(ALL_AGENTS.map((id) => [id, !!props.agents.find((a) => a.id === id && a.available)]))
)
const hooksErrorLabel = (error) => t('mcp.hooks.checkFailed', 'Could not check: {{error}}', { error })
const lastSignalLabel = (signal) =>
  signal.source
    ? t('mcp.hooks.lastSignalFrom', 'Last signal {{when}} ({{source}})', { when: ago(signal.at), source: signal.source })
    : t('mcp.hooks.lastSignal', 'Last signal {{when}}', { when: ago(signal.at) })

// --- Connections: how each agent gets its team messages (its hooks) ---------
// Read-only status from the main process (teamHooksStatus.js): hooks in place,
// Codex's one-time approval in /hooks, and the last signal a hook sent, the
// proof it works. Agents without hooks set up get the typed reminder only.
const hooks = ref(null) // { agents: [...] } | { error }
const hooksLoading = ref(false)
async function loadHooks() {
  if (!window.shellApi.teamHooksStatus) return
  hooksLoading.value = true
  try {
    hooks.value = await window.shellApi.teamHooksStatus()
  } catch (err) {
    hooks.value = { error: err && err.message }
  } finally {
    hooksLoading.value = false
  }
}
// Agents installed here, or with Tessel's hooks still in place.
const hookRows = computed(() =>
  (hooks.value && Array.isArray(hooks.value.agents) ? hooks.value.agents : []).filter(
    (r) => installed.value[r.id] || r.hooks !== 'missing'
  )
)
// Its name: the known ones, else the agent's own (Settings > Agents).
const hookAgentName = (id) => AGENT_NAME[id] || (props.agents.find((a) => a.id === id) || {}).name || id
// Installed agents Tessel has no hooks for yet (they get the typed reminder).
const noHookAgents = computed(() =>
  ALL_AGENTS.filter((a) => installed.value[a] && !hookRows.value.find((r) => r.id === a))
)
function hookState(r) {
  if (r.error || r.hooks === 'error') return { cls: 'error', label: t('mcp.hooks.error', 'Error') }
  if (r.hooks !== 'installed')
    return {
      cls: 'error',
      label: r.hooks === 'partial' ? t('mcp.hooks.incomplete', 'Incomplete') : t('mcp.hooks.notSetUp', 'Not set up')
    }
  if (r.approval === 'needs-approval' || r.approval === 'changed')
    return { cls: 'auth', label: t('mcp.hooks.needsApproval', 'Needs your approval') }
  // Codex's saved approval could not be read: /hooks is the reference.
  if (r.id === 'codex' && !r.approval) return { cls: 'auth', label: t('mcp.hooks.approvalUnknown', 'Approval unknown') }
  return { cls: 'connected', label: r.lastSignal ? t('mcp.hooks.working', 'Working') : t('mcp.hooks.setUp', 'Set up') }
}
function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return t('mcp.ago.now', 'just now')
  if (s < 3600) return t('mcp.ago.minutes', '{{count}} min ago', { count: Math.round(s / 60) })
  if (s < 86400) return t('mcp.ago.hours', '{{count}} h ago', { count: Math.round(s / 3600) })
  return t('mcp.ago.days', '{{count}} d ago', { count: Math.round(s / 86400) })
}
async function reinstallHooks() {
  if (!window.shellApi.installTeamTools) return
  busy.value = 'hooks'
  try {
    const res = await window.shellApi.installTeamTools()
    const errors = (res && res.errors) || []
    message.kind = errors.length ? 'error' : 'ok'
    message.text = errors.length ? errors.join(' ') : t('mcp.hooks.reinstalled', 'Team tools and hooks are set up.')
  } catch (err) {
    message.kind = 'error'
    message.text = (err && err.message) || t('mcp.hooks.reinstallFailed', 'The team tools could not be set up.')
  } finally {
    busy.value = ''
    loadHooks()
  }
}

onMounted(loadHooks)
</script>

<template>
  <div class="mcp-connections">
    <p v-if="message.text" :class="message.kind === 'error' ? 'mcp-error' : 'mcp-notice'">{{ message.text }}</p>
    <p class="mcp-about">
      {{
        t('mcp.hooks.intro', 'How each agent gets its team messages. With its hooks set up, an agent receives them while it works and when it finishes a turn, without anything typed into its terminal. Without hooks, Tessel types a short reminder when the agent is idle.')
      }}
    </p>
    <div class="mcp-toolbar">
      <span class="set-hint">
        <template v-if="hooksLoading">{{ t('mcp.hooks.checking', 'Checking…') }}</template>
        <template v-else-if="hooks && hooks.error">{{ hooksErrorLabel(hooks.error) }}</template>
      </span>
      <button class="exit-btn" :disabled="hooksLoading" @click="loadHooks">
        {{ t('mcp.hooks.checkAgain', 'Check again') }}
      </button>
      <button class="exit-btn" :disabled="!!busy" @click="reinstallHooks">
        {{ busy === 'hooks' ? t('mcp.hooks.settingUp', 'Setting up…') : t('mcp.hooks.setUpAgain', 'Set up again') }}
      </button>
    </div>

    <div v-for="r in hookRows" :key="r.id" class="mcp-server">
      <div class="mcp-server-head">
        <BrandIcon :kind="r.id" :size="22" />
        <div class="mcp-row-main">
          <span class="mcp-name">{{ hookAgentName(r.id) }}</span>
          <span class="mcp-target">
            <template v-if="r.lastSignal">{{ lastSignalLabel(r.lastSignal) }}</template>
            <template v-else>{{ t('mcp.hooks.noSignal', 'No signal from its hooks yet') }}</template>
            <template v-if="r.id === 'claude'">
              · {{
                r.inbox
                  ? t('mcp.hooks.ownInbox', 'reminders go to its own inbox')
                  : t('mcp.hooks.inboxUnknown', 'inbox not reported yet')
              }}</template
            >
          </span>
        </div>
        <span class="mcp-status" :class="hookState(r).cls">{{ hookState(r).label }}</span>
      </div>
      <p v-if="r.id === 'codex' && r.approval !== 'approved'" class="mcp-about">
        <strong>{{ t('mcp.hooks.codexStepTitle', 'One step for you:') }}</strong>
        {{
          t('mcp.hooks.codexStep', "in each Codex pane, type /hooks and approve Tessel's entries. Codex runs a new or changed hook only after you review it."
          )
        }}
      </p>
      <p v-else-if="r.id === 'codex'" class="set-hint">
        {{
          t('mcp.hooks.codexApproved', 'Approved (saved in Codex). If messages stop arriving, /hooks in Codex shows the current state.')
        }}
      </p>
      <p v-if="r.statusOnly" class="set-hint">
        {{
          t('mcp.hooks.statusOnly', 'Its hooks tell Tessel when it works and when it is done. Team messages reach it as a typed reminder when it is idle.')
        }}
      </p>
      <p v-if="r.id === 'kimi'" class="set-hint">
        {{
          t('mcp.hooks.kimi', 'Team messages arrive when you send a prompt, or extend the end of a turn once.')
        }}
      </p>
      <p v-if="r.error" class="mcp-error">{{ r.error }}</p>
      <div v-if="r.events" class="mcp-agents">
        <div v-for="(on, ev) in r.events" :key="ev" class="mcp-agent">
          <span class="mcp-agent-name" :class="{ dim: !on }">{{ ev }}</span>
          <span class="mcp-agent-actions">
            <span class="set-hint">{{ on ? t('mcp.hooks.eventOn', 'set up') : t('mcp.hooks.eventMissing', 'missing') }}</span>
          </span>
        </div>
      </div>
    </div>

    <div v-if="noHookAgents.length" class="mcp-server">
      <div class="mcp-server-head">
        <div class="mcp-row-main">
          <span class="mcp-name">{{ t('mcp.hooks.none', 'No hooks yet') }}</span>
          <span class="mcp-target">{{
            t('mcp.hooks.noneHint', 'Typed reminder only, when the agent is idle')
          }}</span>
        </div>
      </div>
      <div class="mcp-agents">
        <div v-for="a in noHookAgents" :key="a" class="mcp-agent">
          <BrandIcon :kind="a" :size="14" />
          <span class="mcp-agent-name">{{ AGENT_NAME[a] }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
