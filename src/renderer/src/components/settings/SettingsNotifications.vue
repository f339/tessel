<script setup>
// Settings > Notifications: the master switch, what it turns on (Windows
// notifications, the terminal bell, the sound), and the in-app alerts,
// which do not depend on it. The rows under the master switch are indented
// and turned off with it.
import { Play } from 'lucide-vue-next'
import ThemedSelect from '../ui/ThemedSelect.vue'
import { t } from '../../i18n'
import { settings } from '../../settings'
import { playAlertSound } from '../../notificationsStore'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const { shown, emit } = useSettingsShell()

// The sound at the chosen volume.
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
      <h3 class="set-group-title">{{ t('settings.alerts.systemGroup', 'Notifications and sound') }}</h3>
      <div class="set-card">
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.alerts.enable', 'Enable notifications') }}
            <span class="set-hint">{{ t('settings.alerts.enableHint', 'Native system notifications for background events.') }}</span>
          </div>
          <input v-model="settings.notificationsEnabled" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row set-row-nested" :class="{ 'set-disabled': !settings.notificationsEnabled }">
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
        <label class="set-row set-row-nested" :class="{ 'set-disabled': !settings.notificationsEnabled }">
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
        <label class="set-row set-row-nested" :class="{ 'set-disabled': !settings.notificationsEnabled }">
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
        <!-- The sound, its volume and a preview, on one row. -->
        <div class="set-row set-row-nested" :class="{ 'set-disabled': !settings.notificationsEnabled }">
          <label class="set-label" for="settings-alert-sound">
            {{ t('settings.alerts.soundVolume', 'Sound and volume') }}
            <span class="set-hint">{{ t('settings.alerts.soundHint', 'With each new notification (the bell in the toolbar lists them)') }}</span>
          </label>
          <div class="set-inline alerts-sound">
            <ThemedSelect
              id="settings-alert-sound"
              v-model="settings.alertSound"
              class="set-select alerts-sound-select"
              :disabled="!settings.notificationsEnabled"
              @change="previewSound"
            >
              <option value="none">{{ t('settings.alerts.soundNone', 'None') }}</option>
              <option value="chime">{{ t('settings.alerts.soundChime', 'Chime') }}</option>
              <option value="ping">{{ t('settings.alerts.soundPing', 'Ping') }}</option>
            </ThemedSelect>
            <template v-if="settings.alertSound !== 'none'">
              <input
                id="settings-volume"
                class="set-range alerts-volume"
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
              <button
                type="button"
                class="exit-btn small alerts-play"
                data-test="alerts-preview"
                :title="t('settings.alerts.preview', 'Play the sound')"
                :aria-label="t('settings.alerts.preview', 'Play the sound')"
                :disabled="!settings.notificationsEnabled"
                @click="previewSound"
              >
                <Play :size="13" aria-hidden="true" />
              </button>
            </template>
          </div>
        </div>
        <div class="set-row set-row-nested" :class="{ 'set-disabled': !settings.notificationsEnabled }">
          <div class="set-label">
            {{ t('settings.alerts.testRow', 'Try it') }}
            <span class="set-hint">{{ t('settings.alerts.testHint', 'Shows a notification now, with the sound chosen above.') }}</span>
          </div>
          <button
            class="exit-btn"
            type="button"
            data-test="test-notification"
            :disabled="!settings.notificationsEnabled"
            @click="emit('test-notification')"
          >
            {{ t('settings.alerts.testShort', 'Send a test') }}
          </button>
        </div>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.alerts.inAppGroup', 'In Tessel') }}</h3>
      <div class="set-card">
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.alerts.inApp', 'In-app alerts') }}
            <span class="set-hint">{{ t('settings.alerts.inAppHint', 'When an agent finishes in a pane you aren\'t looking at') }}</span>
          </div>
          <input v-model="settings.inAppAlerts" type="checkbox" class="set-switch" />
        </label>
      </div>
    </div>
  </section>
</template>

<style scoped>
.alerts-sound {
  flex-wrap: wrap;
  justify-content: flex-end;
}
.alerts-sound-select {
  min-width: 120px;
}
.alerts-volume {
  width: 110px;
}
.alerts-play {
  justify-content: center;
  width: 26px;
  padding: 0;
}
.alerts-play:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
