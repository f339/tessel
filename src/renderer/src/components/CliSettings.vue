<script setup>
// Settings > General > Tessel CLI: registers the tessel command (a tessel.cmd
// and its folder on your user PATH, src/main/cliInstall.js), after a
// confirmation; Remove undoes both.
import { ref, computed, onMounted, nextTick } from 'vue'
import ConfirmDialog from './ConfirmDialog.vue'
import { t } from '../i18n'

const api = window.shellApi && window.shellApi.cli
const status = ref(null)
const busy = ref(false)
const error = ref('')
const confirm = ref(null) // 'install' | 'uninstall'
const commandSwitch = ref(null)

const name = computed(() => (status.value && status.value.name) || 'tessel')
const supported = computed(() => !!(api && status.value && status.value.supported))
const installed = computed(() => !!(status.value && status.value.state === 'installed'))
// The row's hint, with the command's name shown as code: { before, code, after }.
const NAME = '\u0001'
function withName(text) {
  const [before, after = ''] = text.split(NAME)
  return text.includes(NAME) ? { before, code: name.value, after } : { before: text }
}
const hint = computed(() => {
  const s = status.value
  if (!api || (s && !s.supported)) return withName(t('settings.cli.unsupported', 'The tessel command is available on Windows only.'))
  if (!s) return withName(error.value ? t('settings.cli.statusFailed', 'Failed to load the command’s status.') : t('settings.cli.checking', 'Checking the command’s registration…'))
  if (s.state === 'installed') return withName(t('settings.cli.installedHint', 'The {{name}} command is registered. Open a new terminal if it is not found yet.', { name: NAME }))
  if (s.state === 'partial') return withName(t('settings.cli.partialHint', 'The {{name}} command is only partly registered. Register it again to repair it.', { name: NAME }))
  return withName(t('settings.cli.registerHint', 'Register the {{name}} command in your user PATH.', { name: NAME }))
})

// A few commands to try, each kept on one line (never `tessel --` | `help`).
const examples = computed(() => {
  const n = name.value
  return [`${n} .`, `${n} new --agent claude`, `${n} status`, `${n} --help`] // i18n-ignore
})

async function refresh() {
  if (!api) return
  busy.value = true
  error.value = ''
  try {
    const res = await api.installStatus()
    if (res && res.ok) status.value = res.status
    else error.value = (res && res.error) || t('settings.cli.statusFailed', 'Failed to load the command’s status.')
  } catch {
    error.value = t('settings.cli.statusFailed', 'Failed to load the command’s status.')
  } finally {
    busy.value = false
  }
}

function ask() {
  if (!supported.value || busy.value) return
  confirm.value = installed.value ? 'uninstall' : 'install'
}

async function onAnswer(yes) {
  const what = confirm.value
  confirm.value = null
  if (!yes || !what) {
    await nextTick()
    commandSwitch.value?.focus()
    return
  }
  busy.value = true
  error.value = ''
  try {
    const res = await (what === 'install' ? api.install() : api.uninstall())
    if (res && res.ok) status.value = res.status
    else
      error.value =
        (res && res.error) ||
        (what === 'install'
          ? t('settings.cli.installFailed', 'Failed to register the {{name}} command in PATH.', { name: name.value })
          : t('settings.cli.removeFailed', 'Failed to remove the {{name}} command from PATH.', { name: name.value }))
  } catch {
    error.value = what === 'install'
      ? t('settings.cli.installFailed', 'Failed to register the {{name}} command in PATH.', { name: name.value })
      : t('settings.cli.removeFailed', 'Failed to remove the {{name}} command from PATH.', { name: name.value })
  } finally {
    busy.value = false
    await nextTick()
    commandSwitch.value?.focus()
  }
}

const reveal = () => api && api.reveal().catch(() => {})

onMounted(refresh)
</script>

<template>
  <div class="set-group" data-cli-settings="">
    <h3 class="set-group-title">{{ t('settings.cli.title', 'Tessel CLI') }}</h3>
    <p class="set-group-desc">
      {{ t('settings.cli.intro', 'Open projects and files, start terminals and agents, and see what runs, from your terminal.') }}
    </p>
    <div class="set-card">
      <div class="set-row">
        <div class="set-label">
          {{ t('settings.cli.shellCommand', 'Shell command') }}
          <span class="set-hint" role="status"
            >{{ hint.before }}<code v-if="hint.code" class="cli-name">{{ hint.code }}</code>{{ hint.after }}</span
          >
          <details class="set-more" data-cli-agents-note="">
            <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
            <p>{{ t('settings.cli.agentsNote', 'Programs running as you, including the agents in Tessel’s panes, can use the command too: it opens projects, files and panes and adds cards, but never types into a terminal or answers a confirmation.') }}</p>
          </details>
        </div>
        <div class="set-inline">
          <button
            class="exit-btn"
            type="button"
            :disabled="busy || !api"
            :aria-label="t('settings.cli.refreshLabel', 'Refresh the command’s status')"
            @click="refresh"
          >
            {{ t('settings.cli.refresh', 'Refresh') }}
          </button>
          <input
            ref="commandSwitch"
            type="checkbox"
            class="set-switch"
            data-cli-switch=""
            :checked="installed"
            :disabled="busy || !supported"
            :aria-label="t('settings.cli.shellCommand', 'Shell command')"
            @click.prevent="ask"
          />
        </div>
      </div>
      <div v-if="status && status.supported" class="set-row">
        <div class="set-label">
          {{ t('settings.cli.commandPath', 'Command path') }}
          <span class="sl-path cli-path" :title="status.commandPath">{{ status.commandPath }}</span>
          <span v-if="installed" class="set-hint cli-examples">
            {{ t('settings.cli.examplesLead', 'In a terminal:') }}
            <code v-for="ex in examples" :key="ex" class="set-code">{{ ex }}</code>
          </span>
        </div>
        <button v-if="status.shim" class="exit-btn" type="button" @click="reveal">{{ t('settings.cli.showInExplorer', 'Show in Explorer') }}</button>
      </div>
      <div v-if="error" class="set-callout warn cli-error" role="alert">
        <span class="set-callout-text">{{ error }}</span>
      </div>
    </div>
    <ConfirmDialog
      v-if="confirm === 'install'"
      :title="t('settings.cli.registerTitle', 'Register the {{name}} command in PATH?', { name })"
      :text="t('settings.cli.registerText', 'Tessel will register {{path}} so the command works from your terminal. Its folder is added to your user PATH (not the system PATH); Remove undoes it.', { path: status ? status.commandPath : '' })"
      :confirm-label="t('settings.cli.register', 'Register')"
      @answer="onAnswer"
    />
    <ConfirmDialog
      v-if="confirm === 'uninstall'"
      :title="t('settings.cli.removeTitle', 'Remove the {{name}} command from PATH?', { name })"
      :text="t('settings.cli.removeText', 'This removes the shell command and takes its folder off your user PATH. Tessel itself remains installed.')"
      :confirm-label="t('settings.cli.remove', 'Remove')"
      danger
      @answer="onAnswer"
    />
  </div>
</template>

<style scoped>
/* The command's name in a sentence: code, on one line. */
.cli-name {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--surface-3);
  color: var(--text);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  white-space: nowrap;
}
.cli-path {
  max-width: 100%;
}
.cli-examples {
  line-height: 1.6;
}
.cli-error {
  margin: 0 0 12px;
}
</style>
