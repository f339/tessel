<script setup>
// Settings > Stats & Usage: the Usage menu's settings (moved from
// Appearance), then StatsUsage.vue, loaded while its page is open.
import { ref, watch } from 'vue'
import { t } from '../../i18n'
import ThemedSelect from '../ui/ThemedSelect.vue'
import StatsUsage from '../StatsUsage.vue'
import { settings, USAGE_REFRESH_MINUTES } from '../../settings'
import { loadUsageProviders } from '../../usageProviders'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

defineProps({
  worktreePaths: { type: Array, default: () => [] }
})
const { page, searching, shown, go } = useSettingsShell()

// "Usage refresh": Off, or every N minutes.
const usageRefreshLabel = (m) =>
  m === 0
    ? t('settings.appearance.usageRefreshOff', 'Off')
    : t('settings.appearance.usageRefreshMinutes', '{{count}} min', { count: m })

// The providers of the Usage menu (installed agents, or a saved key): a
// hidden one leaves the menu and the analytics. Read once the page opens
// (or a search shows it), never while Settings opens on another page.
const providers = ref(null)
const providersState = ref('idle') // 'idle' | 'loading' | 'ready' | 'error'
async function loadProviders() {
  providersState.value = 'loading'
  try {
    providers.value = await loadUsageProviders()
    providersState.value = 'ready'
  } catch {
    providersState.value = 'error'
  }
}
watch(
  () => page.value === 'stats' || searching.value,
  (wanted) => {
    if (wanted && providersState.value === 'idle') loadProviders()
  },
  { immediate: true }
)
function toggleProvider(id) {
  const hidden = settings.hiddenUsageProviders
  settings.hiddenUsageProviders = hidden.includes(id) ? hidden.filter((p) => p !== id) : [...hidden, id]
}
</script>

<template>
  <section id="set-stats" class="set-page" data-page="stats" :hidden="!shown('stats')" aria-labelledby="set-stats-title">
    <header class="set-page-head">
      <h2 id="set-stats-title">{{ PAGES.stats.title }}</h2>
      <p class="set-page-desc">{{ PAGES.stats.desc }}</p>
    </header>
    <div class="set-group" data-group="usage-menu">
      <h3 class="set-group-title">{{ t('settings.stats.usageMenu', 'Usage menu') }}</h3>
      <p class="set-group-desc">{{ t('settings.stats.usageMenuDesc', 'The limits of your plans, in the Usage menu of the status bar.') }}</p>
      <div class="set-card">
        <div class="set-row">
          <div id="settings-usage-pct-label" class="set-label">
            {{ t('settings.appearance.usagePct', 'Usage percentages') }}
            <span class="set-hint">{{ t('settings.appearance.usagePctHint', 'Show the share of each limit used, or what remains.') }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-usage-pct-label" data-setting="usagePercentageDisplay">
            <button
              v-for="o in [
                { id: 'used', label: t('settings.appearance.used', 'Used') },
                { id: 'remaining', label: t('settings.appearance.remaining', 'Remaining') }
              ]"
              :key="o.id"
              type="button"
              class="launch-seg-btn"
              :class="{ on: settings.usagePercentageDisplay === o.id }"
              :aria-pressed="settings.usagePercentageDisplay === o.id"
              @click="settings.usagePercentageDisplay = o.id"
            >
              {{ o.label }}
            </button>
          </div>
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-usage-refresh">
            {{ t('settings.appearance.usageRefresh', 'Usage refresh') }}
            <span class="set-hint">{{ t('settings.appearance.usageRefreshHint', 'How often the limits are read again while Tessel is in use. Off: when you open Usage.') }}</span>
          </label>
          <ThemedSelect id="settings-usage-refresh" v-model="settings.usageRefreshMinutes" class="set-select" data-setting="usageRefreshMinutes">
            <option v-for="m in USAGE_REFRESH_MINUTES" :key="m" :value="m">{{ usageRefreshLabel(m) }}</option>
          </ThemedSelect>
        </div>
        <div class="set-row" data-setting="hiddenUsageProviders">
          <div id="settings-usage-providers-label" class="set-label">
            {{ t('settings.stats.providersShown', 'Providers shown') }}
            <span class="set-hint">{{ t('settings.stats.providersShownHint', 'A provider turned off leaves the Usage menu and the analytics below.') }}</span>
          </div>
          <div v-if="providersState === 'ready' && providers.length" class="set-chips" role="group" aria-labelledby="settings-usage-providers-label">
            <button
              v-for="p in providers"
              :key="p.id"
              type="button"
              class="chip"
              :class="{ on: !settings.hiddenUsageProviders.includes(p.id) }"
              :aria-pressed="!settings.hiddenUsageProviders.includes(p.id)"
              :data-usage-provider="p.id"
              @click="toggleProvider(p.id)"
            >
              {{ p.name }}
            </button>
          </div>
          <span v-else-if="providersState === 'ready'" class="set-hint">{{ t('settings.stats.noProviders', 'No provider found on this computer.') }}</span>
          <span v-else-if="providersState === 'error'" class="set-inline">
            <span class="set-hint">{{ t('settings.stats.providersError', 'Could not list the providers.') }}</span>
            <button type="button" class="exit-btn small" @click="loadProviders">{{ t('settings.stats.retry', 'Retry') }}</button>
          </span>
          <span v-else class="set-hint" role="status">{{ t('settings.stats.providersLoading', 'Looking for providers…') }}</span>
        </div>
      </div>
    </div>
    <div class="set-group" data-group="analytics">
      <StatsUsage v-if="page === 'stats' && !searching" :worktree-paths="worktreePaths" />
      <div v-else class="set-card">
        <div class="set-row">
          <div class="set-label">{{ t('settings.stats.analytics', 'Usage analytics') }}
            <span class="set-hint">{{ t('settings.stats.analyticsHint', 'Overview, Claude, Codex, tokens, costs, cache efficiency, daily usage, models, projects and sessions.') }}</span>
          </div>
          <button type="button" class="exit-btn" @click="go('stats')">{{ t('settings.stats.open', 'Open Stats & Usage') }}</button>
        </div>
      </div>
    </div>
  </section>
</template>
