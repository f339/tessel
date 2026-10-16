<script setup>
// Settings > Developer tools: the tools agents use (toolsCatalog.js), one row
// each: found on the PATH, or installed with winget in a new pane, and its
// one-time setup (git's name and email, the GitHub CLI's sign-in). The rows
// always render, so the search finds them; what is installed is read once
// the page opens, and the setup again when the window gets the focus back.
import { ref, reactive, computed, watch, onBeforeUnmount } from 'vue'
import { LoaderCircle, Check } from 'lucide-vue-next'
import BrandIcon from '../BrandIcon.vue'
import { DEV_TOOLS } from '../../toolsCatalog'
import { t } from '../../i18n'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const { page, shown, emit } = useSettingsShell()

const found = reactive({}) // bin -> bool
const setup = reactive({}) // tool id -> its setup state (main's tools:status)
const checked = ref(false) // a check answered once
const checking = ref(false)
const error = ref('')

async function loadSetup() {
  if (!window.shellApi.toolStatus) return
  try {
    Object.assign(setup, (await window.shellApi.toolStatus()) || {})
  } catch {
    // keep the setup buttons
  }
}
async function check() {
  if (checking.value) return
  if (!window.shellApi.checkTools) {
    error.value = t('settings.devtools.unavailable', 'This version of Tessel cannot check the tools.')
    return
  }
  checking.value = true
  error.value = ''
  try {
    if (window.shellApi.refreshPath) await window.shellApi.refreshPath()
    Object.assign(found, (await window.shellApi.checkTools(DEV_TOOLS.map((tool) => tool.bin))) || {})
    await loadSetup()
    checked.value = true
  } catch (err) {
    error.value = (err && err.message) || String(err)
  } finally {
    checking.value = false
  }
}
watch(
  () => page.value === 'devtools',
  (open) => {
    if (open && !checked.value && !checking.value) check()
  },
  { immediate: true }
)

// A setup step changes its tool's state: read it again a little after one
// starts, and when the window gets the focus back, while this page shows.
const timers = []
function scheduleRecheck() {
  timers.push(setTimeout(loadSetup, 15000), setTimeout(loadSetup, 45000))
}
function onWindowFocus() {
  if (page.value === 'devtools' && checked.value) loadSetup()
}
window.addEventListener('focus', onWindowFocus)
onBeforeUnmount(() => {
  window.removeEventListener('focus', onWindowFocus)
  for (const id of timers) clearTimeout(id)
})

const installedCount = computed(() => DEV_TOOLS.filter((tool) => found[tool.bin]).length)
const summary = computed(() => {
  if (!checked.value) return checking.value ? t('settings.devtools.checking', 'Checking which tools are installed…') : ''
  return t('settings.devtools.count', '{{count}} of {{total}} installed', { count: installedCount.value, total: DEV_TOOLS.length })
})

// What a tool's setup step looks like now: done (with a short summary) or not.
function setupState(tool) {
  if (tool.id === 'gh' && setup.gh) {
    return setup.gh.signedIn
      ? {
          done: true,
          text: setup.gh.account
            ? t('tools.dev.signedInAs', 'Signed in as {{account}}', { account: setup.gh.account })
            : t('tools.dev.signedIn', 'Signed in')
        }
      : { done: false, text: t('settings.devtools.ghNotSignedIn', 'Not signed in to GitHub yet') }
  }
  if (tool.id === 'git' && setup.git) {
    return setup.git.configured
      ? { done: true, text: `${setup.git.name} <${setup.git.email}>` }
      : { done: false, text: t('settings.devtools.gitNoIdentity', 'No name and email for commits yet') }
  }
  return null
}

// Installs and setup steps run in a new pane (Settings closes so it is seen).
function install(tool) {
  emit('run-job', { label: t('tools.installPane', 'Install {{name}}', { name: tool.name }), command: tool.install })
}
function runAction(act) {
  emit('run-job', { label: act.label, command: act.command, shell: act.shell })
  scheduleRecheck()
}
</script>

<template>
  <section id="set-devtools" class="set-page" data-page="devtools" :hidden="!shown('devtools')" aria-labelledby="set-devtools-title">
    <header class="set-page-head">
      <h2 id="set-devtools-title">{{ PAGES.devtools.title }}</h2>
      <p class="set-page-desc">{{ PAGES.devtools.desc }}</p>
    </header>
    <div class="set-group">
      <p class="set-group-desc">{{ t('settings.devtools.groupDesc', 'Installs run with winget in a new pane; some installers ask for permission in a Windows prompt.') }}</p>
      <div class="set-card">
        <div class="dt-toolbar">
          <span class="set-hint dt-summary" aria-live="polite">
            <LoaderCircle v-if="checking" :size="12" class="sb-spin" aria-hidden="true" />
            {{ summary }}
          </span>
          <button type="button" class="exit-btn small" :disabled="checking" data-test="devtools-check" @click="check">
            {{ checking ? t('tools.checking', 'Checking…') : t('tools.checkAgain', 'Check again') }}
          </button>
        </div>
        <div v-if="error" class="set-callout danger dt-error" role="alert" data-test="devtools-error">
          <span class="set-callout-text">{{ t('settings.devtools.failed', 'Tessel could not check which tools are installed.') }}</span>
          <button type="button" class="exit-btn small" :disabled="checking" @click="check">{{ t('settings.common.retry', 'Retry') }}</button>
          <details class="set-more dt-more">
            <summary>{{ t('settings.common.details', 'Details') }}</summary>
            <code class="dt-raw">{{ error }}</code>
          </details>
        </div>
        <div v-for="tool in DEV_TOOLS" :key="tool.id" class="set-row dt-row" :data-tool="tool.id">
          <BrandIcon class="dt-icon" :kind="tool.id" :accent="tool.accent" :label="tool.name" :size="20" />
          <div class="set-label">
            <span class="dt-name">
              {{ tool.name }}
              <span v-if="checked && found[tool.bin]" class="tag tag-ok">{{ t('tools.installed', 'Installed') }}</span>
              <span v-else-if="checked" class="tag tag-off">{{ t('settings.devtools.notInstalled', 'Not installed') }}</span>
            </span>
            <span class="set-hint dt-desc" :title="tool.desc">{{ tool.desc }}</span>
            <span
              v-if="found[tool.bin] && setupState(tool)"
              class="set-hint dt-setup"
              :class="{ done: setupState(tool).done }"
              :title="setupState(tool).text"
              :data-setup="tool.id"
            >
              <Check v-if="setupState(tool).done" :size="12" aria-hidden="true" />
              <span class="dt-setup-text">{{ setupState(tool).text }}</span>
            </span>
          </div>
          <span class="dt-actions">
            <span v-if="!checked && checking" class="dt-skel" aria-hidden="true"></span>
            <template v-else-if="found[tool.bin]">
              <button
                v-for="act in tool.actions || []"
                :key="act.label"
                type="button"
                class="exit-btn small"
                :title="act.label"
                @click="runAction(act)"
              >
                {{ setupState(tool) && setupState(tool).done ? act.doneLabel || t('tools.dev.change', 'Change') : act.label }}
              </button>
            </template>
            <button v-else-if="checked" type="button" class="exit-btn small" :data-install="tool.id" @click="install(tool)">
              {{ t('tools.install', 'Install') }}
            </button>
          </span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.dt-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  padding: 12px 0 10px;
  border-bottom: 1px solid var(--border);
}
.dt-summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
}
.dt-error {
  margin: 10px 0;
}
.dt-more {
  flex: 1 1 100%;
}
.dt-raw {
  display: block;
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
.set-card .dt-row {
  gap: 12px;
}
.set-card .dt-row > .dt-icon {
  flex: 0 0 auto;
  align-self: flex-start;
  margin-top: 2px;
}
.dt-name {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}
.dt-desc,
.dt-setup-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dt-setup {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  color: var(--warn);
}
.dt-setup.done {
  color: #8fd6a0;
}
.dt-setup > svg {
  flex: 0 0 auto;
}
.dt-actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}
.dt-skel {
  width: 64px;
  height: 22px;
  border-radius: 6px;
  background: var(--surface-3);
  opacity: 0.6;
}
@container (max-width: 520px) {
  .set-card .dt-row {
    flex-wrap: nowrap;
  }
  .set-card .dt-row > .set-label {
    flex: 1 1 auto;
  }
}
</style>
