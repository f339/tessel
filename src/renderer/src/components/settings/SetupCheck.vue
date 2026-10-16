<script setup>
// Settings > General > Setup check: what Tessel itself needs on this
// computer (main's tesselNeeds.js), the problems only, each with the button
// that fixes it, then how many checks are fine. Read when General opens and
// again on Check again; the optional extras (uv for Python MCP servers) wait
// behind "Show all checks".
import { ref, computed, watch } from 'vue'
import { LoaderCircle, Check } from 'lucide-vue-next'
import { t } from '../../i18n'
import { DEV_TOOLS } from '../../toolsCatalog'
import { useSettingsShell } from './settingsShell'

const { page, go, emit } = useSettingsShell()

const available = !!window.shellApi?.tesselNeeds
const rows = ref(null)
const loading = ref(false)
const error = ref('')
// The team tools set up from here: busy, then what went wrong if anything.
const settingUp = ref(false)
const setUpError = ref('')

async function load() {
  if (!available || loading.value) return
  loading.value = true
  error.value = ''
  try {
    const res = await window.shellApi.tesselNeeds()
    if (res && res.ok && Array.isArray(res.rows)) rows.value = res.rows
    else error.value = (res && res.error) || t('tools.needs.checkFailed', 'Could not check.')
  } catch (err) {
    error.value = (err && err.message) || t('tools.needs.checkFailed', 'Could not check.')
  } finally {
    loading.value = false
  }
}
// General is the page Settings opens on: read once it shows, never for a search.
watch(
  () => page.value === 'general',
  (open) => {
    if (open && !rows.value && !error.value) load()
  },
  { immediate: true }
)

const problems = computed(() => (rows.value || []).filter((r) => r.status === 'warn' || r.status === 'missing'))
const okCount = computed(() => (rows.value || []).filter((r) => r.status === 'ok').length)
const optionalCount = computed(() => (rows.value || []).filter((r) => r.status === 'optional').length)
const okText = computed(() => {
  const count = okCount.value
  if (problems.value.length || optionalCount.value) return t('settings.setup.okCount', count === 1 ? '{{count}} check OK' : '{{count}} checks OK', { count })
  return count === 1 ? t('settings.setup.allOk', '{{count}} check OK', { count }) : t('settings.setup.allOk', 'All {{count}} checks OK', { count })
})
const optionalText = computed(() => t('settings.setup.optionalCount', '{{count}} optional', { count: optionalCount.value }))

function statusLabel(status) {
  if (status === 'ok') return t('tools.needs.ok', 'OK')
  if (status === 'warn') return t('tools.needs.warn', 'To fix')
  if (status === 'missing') return t('tools.needs.missing', 'Missing')
  if (status === 'optional') return t('tools.needs.optional', 'Optional')
  return status
}
function statusTag(status) {
  return { ok: 'tag-ok', warn: 'tag-warn', missing: 'tag-danger' }[status] || 'tag-off'
}

const toolById = Object.fromEntries(DEV_TOOLS.map((tool) => [tool.id, tool]))
// The button that fixes a row: an install or a command in a new pane (Settings
// closes so it is seen), an agent update, the team tools set up again, or the
// page to go to. Null when there is nothing to click (the where text says it).
function fixOf(r) {
  const fix = r.fix || {}
  const tool = fix.install && toolById[fix.install]
  if (tool)
    return {
      label: t('tools.install', 'Install'),
      run: () => emit('run-job', { label: t('tools.installPane', 'Install {{name}}', { name: tool.name }), command: tool.install })
    }
  if (fix.action === 'update-agent' && fix.agent) return { label: t('tools.update', 'Update'), run: () => emit('update-agent', fix.agent) }
  if (fix.run) return { label: t('tools.update', 'Update'), run: () => emit('run-job', { label: fix.run, command: fix.run }) }
  if (fix.action === 'team-setup') return { label: t('settings.setup.setUp', 'Set up'), run: setUpTeam, busy: settingUp.value }
  if (fix.action === 'team') return { label: t('settings.setup.openOrchestration', 'Open Orchestration'), run: () => go('orchestration') }
  if (fix.action === 'agents') return { label: t('settings.setup.installAgent', 'Install an agent'), run: () => go('agents') }
  if (fix.action === 'git-identity') {
    const act = toolById.git && toolById.git.actions && toolById.git.actions[0]
    if (act) return { label: act.label, run: () => emit('run-job', { label: act.label, command: act.command, shell: act.shell }) }
  }
  return null
}

async function setUpTeam() {
  if (!window.shellApi.installTeamTools || settingUp.value) return
  settingUp.value = true
  setUpError.value = ''
  try {
    const res = await window.shellApi.installTeamTools()
    const errors = (res && res.errors) || []
    if (errors.length) setUpError.value = errors.join(' ')
  } catch (err) {
    setUpError.value = (err && err.message) || String(err)
  } finally {
    settingUp.value = false
    load()
  }
}
</script>

<template>
  <div v-if="available" class="set-group setup-check" data-test="setup-check">
    <h3 class="set-group-title">{{ t('settings.setup.title', 'Setup check') }}</h3>
    <div class="set-card">
      <!-- The first read: a line that says so, never "all OK" before it answers. -->
      <div v-if="!rows && !error" class="set-row setup-loading" role="status" aria-busy="true" data-test="setup-loading">
        <span class="set-label">
          <span class="setup-line"><LoaderCircle :size="13" class="sb-spin" aria-hidden="true" />{{ t('settings.setup.checking', 'Checking what Tessel needs…') }}</span>
        </span>
      </div>

      <div v-else-if="!rows" class="set-row setup-error" role="alert" data-test="setup-error">
        <div class="set-label">
          {{ t('settings.setup.failed', 'Tessel could not check its setup.') }}
          <details class="set-more">
            <summary>{{ t('settings.common.details', 'Details') }}</summary>
            <code class="setup-raw">{{ error }}</code>
          </details>
        </div>
        <button type="button" class="exit-btn" :disabled="loading" @click="load">{{ t('settings.common.retry', 'Retry') }}</button>
      </div>

      <template v-else>
        <div v-for="r in problems" :key="r.id" class="set-row setup-problem" :data-need="r.id">
          <div class="set-label">
            <span class="setup-name">{{ r.name }}<span class="tag" :class="statusTag(r.status)">{{ statusLabel(r.status) }}</span></span>
            <span class="set-hint setup-detail" :title="r.why">{{ r.detail }}</span>
            <span v-if="!fixOf(r) && r.fix && r.fix.where" class="set-hint">{{ r.fix.where }}</span>
          </div>
          <button v-if="fixOf(r)" type="button" class="exit-btn" :disabled="fixOf(r).busy" :data-fix="r.id" @click="fixOf(r).run()">
            <LoaderCircle v-if="fixOf(r).busy" :size="12" class="sb-spin" aria-hidden="true" />
            {{ fixOf(r).label }}
          </button>
        </div>
        <div v-if="error" class="set-callout danger setup-callout" role="alert">
          <span class="set-callout-text">{{ t('settings.setup.failedAgain', 'Tessel could not check its setup again: these are the last results.') }}</span>
          <details class="set-more">
            <summary>{{ t('settings.common.details', 'Details') }}</summary>
            <code class="setup-raw">{{ error }}</code>
          </details>
        </div>
        <div v-if="setUpError" class="set-callout danger setup-callout" role="alert">
          <span class="set-callout-text">{{ t('mcp.hooks.reinstallFailed', 'The team tools could not be set up.') }}</span>
          <details class="set-more">
            <summary>{{ t('settings.common.details', 'Details') }}</summary>
            <code class="setup-raw">{{ setUpError }}</code>
          </details>
        </div>

        <div class="set-row setup-foot" data-test="setup-ok">
          <div class="set-label">
            <span class="setup-line">
              <Check :size="14" class="setup-ok-icon" aria-hidden="true" />
              <span>{{ okText }}</span>
              <span v-if="optionalCount" class="set-hint">· {{ optionalText }}</span>
            </span>
            <details class="set-more setup-all">
              <summary>{{ t('settings.setup.showAll', 'Show all checks') }}</summary>
              <ul class="setup-list">
                <li v-for="r in rows" :key="r.id" :data-check="r.id">
                  <span class="setup-name">{{ r.name }}<span class="tag" :class="statusTag(r.status)">{{ statusLabel(r.status) }}</span></span>
                  <span class="set-hint">{{ r.why }}</span>
                  <span class="setup-detail-line">{{ r.detail }}</span>
                  <button v-if="r.status === 'optional' && fixOf(r)" type="button" class="exit-btn small" @click="fixOf(r).run()">{{ fixOf(r).label }}</button>
                </li>
              </ul>
            </details>
          </div>
          <button type="button" class="exit-btn small" :disabled="loading" data-test="setup-again" @click="load">
            <LoaderCircle v-if="loading" :size="12" class="sb-spin" aria-hidden="true" />
            {{ loading ? t('tools.checking', 'Checking…') : t('tools.checkAgain', 'Check again') }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.setup-line {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.setup-loading .setup-line {
  color: var(--text-dim);
}
.setup-name {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}
.setup-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.setup-ok-icon {
  color: #3fb950;
}
.setup-foot {
  align-items: flex-start;
}
.setup-foot > .exit-btn {
  margin-top: 1px;
}
.setup-all {
  font-weight: 400;
}
.setup-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 8px 0 2px;
  padding: 0;
  list-style: none;
}
.setup-list li {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.setup-list .setup-name {
  color: var(--text-strong);
}
.setup-list .exit-btn {
  margin-top: 4px;
}
.setup-detail-line {
  color: var(--text);
  font-size: 11.5px;
  overflow-wrap: anywhere;
}
.setup-raw {
  display: block;
  margin-top: 4px;
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
.setup-callout {
  margin: 4px 0 8px;
}
</style>
