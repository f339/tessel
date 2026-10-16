<script setup>
// Settings > Automations: AutomationsPage.vue, loaded while its page is open.
import { t } from '../../i18n'
import AutomationsPage from '../AutomationsPage.vue'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const { page, searching, shown, go } = useSettingsShell()
</script>

<template>
  <section
    id="set-automations"
    class="set-page"
    data-page="automations"
    :hidden="!shown('automations')"
    aria-labelledby="set-automations-title"
  >
    <header class="set-page-head">
      <h2 id="set-automations-title">{{ PAGES.automations.title }}</h2>
      <p class="set-page-desc">{{ PAGES.automations.desc }}</p>
    </header>
    <div class="set-group">
      <AutomationsPage v-if="page === 'automations' && !searching" />
      <div v-else class="set-row">
        <div class="set-label">{{ t('settings.automations.open', 'Open Automations') }}
          <span class="set-hint">{{ t('settings.automations.openHint', 'Create schedules and inspect recent runs.') }}</span>
        </div>
        <button type="button" class="exit-btn" @click="go('automations')">{{ t('settings.automations.open', 'Open Automations') }}</button>
      </div>
    </div>
  </section>
</template>
