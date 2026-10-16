<script setup>
// Settings > Updates: Tessel's version and updates.
import { t } from '../../i18n'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

defineProps({
  updateStatus: { type: Object, default: () => ({ state: 'disabled' }) }
})
const { shown, emit } = useSettingsShell()

function updateText(u) {
  switch (u.state) {
    case 'checking':
      return t('settings.updates.checking', 'Checking for updates…')
    case 'none':
      return t('settings.updates.latest', 'You have the latest version.')
    case 'downloading':
      return u.percent
        ? t('settings.updates.downloadingPct', 'Downloading {{version}} ({{percent}}%)…', { version: u.version, percent: u.percent })
        : t('settings.updates.downloading', 'Downloading {{version}}…', { version: u.version })
    case 'ready':
      return t('settings.updates.ready', 'Version {{version}} is ready to install.', { version: u.version })
    case 'error':
      return t('settings.updates.error', 'Could not check for updates. Try again later.')
    case 'disabled':
      return t('settings.updates.disabled', 'Only the installed app updates itself.')
    default:
      return t('settings.updates.idle', 'Checks automatically every few hours.')
  }
}
</script>

<template>
  <section
    id="set-updates"
    class="set-page"
    data-page="updates"
    :hidden="!shown('updates')"
    aria-labelledby="set-updates-title"
  >
    <header class="set-page-head">
      <h2 id="set-updates-title">{{ PAGES.updates.title }}</h2>
      <p class="set-page-desc">{{ PAGES.updates.desc }}</p>
    </header>
    <div class="set-group">
      <div class="set-card">
        <div class="set-row">
          <div class="set-label">
            Tessel {{ updateStatus.current || '' }}
            <span class="set-hint">{{ updateText(updateStatus) }}</span>
          </div>
          <button
            v-if="updateStatus.state === 'ready'"
            class="exit-btn primary"
            @click="emit('open-update')"
          >
            {{ t('settings.updates.restart', 'Restart and update') }}
          </button>
          <button
            v-else
            class="exit-btn"
            :disabled="['disabled', 'checking', 'downloading'].includes(updateStatus.state)"
            @click="emit('check-updates')"
          >
            {{ t('settings.updates.check', 'Check for updates') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
