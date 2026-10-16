<script setup>
// Settings > Stats & Usage: StatsUsage.vue, loaded while its page is open.
import { t } from '../../i18n'
import StatsUsage from '../StatsUsage.vue'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

defineProps({
  worktreePaths: { type: Array, default: () => [] }
})
const { page, searching, shown, go } = useSettingsShell()
</script>

<template>
  <section id="set-stats" class="set-page" data-page="stats" :hidden="!shown('stats')" aria-labelledby="set-stats-title">
    <header class="set-page-head">
      <h2 id="set-stats-title">{{ PAGES.stats.title }}</h2>
      <p class="set-page-desc">{{ PAGES.stats.desc }}</p>
    </header>
    <div class="set-group">
      <StatsUsage v-if="page === 'stats' && !searching" :worktree-paths="worktreePaths" />
      <div v-else class="set-row">
        <div class="set-label">{{ t('settings.stats.analytics', 'Usage analytics') }}
          <span class="set-hint">{{ t('settings.stats.analyticsHint', 'Overview, Claude, Codex, tokens, costs, cache efficiency, daily usage, models, projects and sessions.') }}</span>
        </div>
        <button type="button" class="exit-btn" @click="go('stats')">{{ t('settings.stats.open', 'Open Stats & Usage') }}</button>
      </div>
    </div>
  </section>
</template>
