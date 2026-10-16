<script setup>
// Settings > Notifications: desktop notifications and their sound.
import ThemedSelect from '../ui/ThemedSelect.vue'
import { t } from '../../i18n'
import { settings } from '../../settings'
import { playAlertSound } from '../../notificationsStore'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const { shown, emit } = useSettingsShell()

// Notifications: the sound at the chosen volume.
function previewSound() {
  playAlertSound(settings.alertSound, settings.notificationVolume)
}
</script>

<template>
  <section
    id="set-alerts"
    class="set-page"
    data-page="alerts"
    :hidden="!shown('alerts')"
    aria-labelledby="set-alerts-title"
  >
    <header class="set-page-head">
      <h2 id="set-alerts-title">{{ PAGES.alerts.title }}</h2>
      <p class="set-page-desc">{{ PAGES.alerts.desc }}</p>
    </header>
    <div class="set-group">
      <div class="set-card">
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.alerts.enable', 'Enable notifications') }}
            <span class="set-hint">{{ t('settings.alerts.enableHint', 'Native system notifications for background events.') }}</span>
          </div>
          <input v-model="settings.notificationsEnabled" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row" :class="{ 'set-disabled': !settings.notificationsEnabled }">
          <div class="set-label">
            {{ t('settings.alerts.windows', 'Windows notifications') }}
            <span class="set-hint">{{ t('settings.alerts.windowsHint', 'When an agent finishes while the app is in the background') }}</span>
          </div>
          <input
            v-model="settings.desktopNotifications"
            type="checkbox"
            class="set-switch"
            :disabled="!settings.notificationsEnabled"
          />
        </label>
        <label class="set-row" :class="{ 'set-disabled': !settings.notificationsEnabled }">
          <div class="set-label">
            {{ t('settings.alerts.bell', 'Terminal bell') }}
            <span class="set-hint">{{ t('settings.alerts.bellHint', 'A background terminal emits a bell character.') }}</span>
          </div>
          <input
            v-model="settings.notifyTerminalBell"
            type="checkbox"
            class="set-switch"
            :disabled="!settings.notificationsEnabled"
          />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.alerts.inApp', 'In-app alerts') }}
            <span class="set-hint">{{ t('settings.alerts.inAppHint', 'When an agent finishes in a pane you aren\'t looking at') }}</span>
          </div>
          <input v-model="settings.inAppAlerts" type="checkbox" class="set-switch" />
        </label>
        <div class="set-row" :class="{ 'set-disabled': !settings.notificationsEnabled }">
          <label class="set-label" for="settings-alert-sound">
            {{ t('settings.alerts.sound', 'Sound') }}
            <span class="set-hint">{{ t('settings.alerts.soundHint', 'With each new notification (the bell in the toolbar lists them)') }}</span>
          </label>
          <ThemedSelect
            id="settings-alert-sound"
            v-model="settings.alertSound"
            class="set-select"
            :disabled="!settings.notificationsEnabled"
            @change="previewSound"
          >
            <option value="none">{{ t('settings.alerts.soundNone', 'None') }}</option>
            <option value="chime">{{ t('settings.alerts.soundChime', 'Chime') }}</option>
            <option value="ping">{{ t('settings.alerts.soundPing', 'Ping') }}</option>
          </ThemedSelect>
        </div>
        <div
          v-if="settings.alertSound !== 'none'"
          class="set-row"
          :class="{ 'set-disabled': !settings.notificationsEnabled }"
        >
          <label class="set-label" for="settings-volume">{{ t('settings.alerts.volume', 'Volume') }}</label>
          <div class="set-inline">
            <input
              id="settings-volume"
              class="set-range"
              type="range"
              min="0"
              max="100"
              step="5"
              :aria-label="t('settings.alerts.volumeLabel', 'Notification sound volume')"
              :disabled="!settings.notificationsEnabled"
              :value="settings.notificationVolume"
              @input="settings.notificationVolume = Math.round(Number($event.target.value))"
              @change="previewSound"
            />
            <span class="set-hint set-volume-value">{{ settings.notificationVolume }}%</span>
          </div>
        </div>
        <label class="set-row" :class="{ 'set-disabled': !settings.notificationsEnabled }">
          <div class="set-label">
            {{ t('settings.alerts.suppress', 'Suppress while focused') }}
            <span class="set-hint">{{ t('settings.alerts.suppressHint', 'Skip notifications when the triggering worktree is already visible.') }}</span>
          </div>
          <input
            v-model="settings.notifySuppressWhenFocused"
            type="checkbox"
            class="set-switch"
            :disabled="!settings.notificationsEnabled"
          />
        </label>
        <div class="set-row">
          <span></span>
          <button
            class="exit-btn"
            type="button"
            data-test="test-notification"
            :disabled="!settings.notificationsEnabled"
            @click="emit('test-notification')"
          >
            {{ t('settings.alerts.test', 'Send test notification') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
