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
const hint = computed(() => {
  const s = status.value
  if (!api || (s && !s.supported)) return t('settings.cli.unsupported', 'The tessel command is available on Windows only.')
  if (!s) return error.value ? t('settings.cli.statusFailed', 'Failed to load the command’s status.') : t('settings.cli.checking', 'Checking the command’s registration…')
  if (s.state === 'installed') return t('settings.cli.installedHint', 'The {{name}} command is registered. Open a new terminal if it is not found yet.', { name: name.value })
  if (s.state === 'partial') return t('settings.cli.partialHint', 'The {{name}} command is only partly registered. Register it again to repair it.', { name: name.value })
  return t('settings.cli.registerHint', 'Register the {{name}} command in your user PATH.', { name: name.value })
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
    <div class="set-card">
      <p class="set-hint set-card-text">
        {{ t('settings.cli.intro', 'Use Tessel from your terminal to open projects and files, start terminals and agents, and see what is running.') }}
      </p>
      <p class="set-hint set-card-text" data-cli-agents-note="">
        {{ t('settings.cli.agentsNote', 'Programs running as you, including the agents in Tessel’s panes, can use the command too: it opens projects, files and panes and adds cards, but never types into a terminal or answers a confirmation.') }}
      </p>
      <div class="set-row">
        <div class="set-label">
          {{ t('settings.cli.shellCommand', 'Shell command') }}
          <span class="set-hint" role="status">{{ hint }}</span>
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
          <span class="set-hint"><code>{{ status.commandPath }}</code></span>
          <span v-if="installed" class="set-hint">
            {{ t('settings.cli.examplesLead', 'In a terminal:') }}
            <code v-for="ex in examples" :key="ex" class="set-code">{{ ex }}</code>
          </span>
        </div>
        <button v-if="status.shim" class="exit-btn" type="button" @click="reveal">{{ t('settings.cli.showInExplorer', 'Show in Explorer') }}</button>
      </div>
      <p v-if="error" class="set-hint set-card-text set-warn" role="alert">{{ error }}</p>
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
