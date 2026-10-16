<script setup>
// Settings > About & updates (page id 'updates', so openSettings('updates')
// still opens it): Tessel's version and its updates (when it last looked,
// Check now, the release notes), what to use when something goes wrong, and
// the licenses.
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { ExternalLink } from 'lucide-vue-next'
import { t } from '../../i18n'
import { relativeTime } from '../../automationLabels'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const props = defineProps({
  updateStatus: { type: Object, default: () => ({ state: 'disabled' }) }
})
const { shown, emit, go } = useSettingsShell()

// Where Tessel is published (package.json's "publish"): its releases, issues
// and license files.
const REPO = 'https://github.com/mindkind1337/tessel' // i18n-ignore
const tagOf = (version) => (version ? `v${String(version).replace(/^v/, '')}` : '') // i18n-ignore

// "Last checked 5 min ago" stays true while the page is open.
const now = ref(Date.now())
const clock = setInterval(() => (now.value = Date.now()), 30000)
onBeforeUnmount(() => clearInterval(clock))

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
const lastChecked = computed(() => {
  const at = Number(props.updateStatus.checkedAt)
  if (!Number.isFinite(at) || at <= 0 || props.updateStatus.state === 'checking') return ''
  return t('settings.updates.lastChecked', 'Last checked {{when}}', { when: relativeTime(at, now.value) })
})
// "You have the latest version · Last checked 5 min ago": one line, the
// sentence's own full stop dropped before the dot.
const statusLine = computed(() => {
  const text = updateText(props.updateStatus)
  return lastChecked.value ? `${text.replace(/\.$/, '')} · ${lastChecked.value}` : text
})
// The release whose notes "What's new" opens: the one ready to install, else
// the one running.
const notesVersion = computed(() => (props.updateStatus.state === 'ready' && props.updateStatus.version) || props.updateStatus.current || '')
const notesUrl = computed(() => (notesVersion.value ? `${REPO}/releases/tag/${tagOf(notesVersion.value)}` : `${REPO}/releases`)) // i18n-ignore
const fileUrl = (name) => `${REPO}/blob/${tagOf(props.updateStatus.current) || 'main'}/${name}` // i18n-ignore

// The logs and diagnostics are General's Troubleshooting group: opened there.
function openTroubleshooting() {
  go('general')
  nextTick(() => document.querySelector('.set-page[data-page="general"] [data-group="troubleshooting"]')?.scrollIntoView?.({ block: 'start' }))
}
async function openLink(url) {
  try {
    await window.shellApi?.openExternal?.(url)
  } catch {
    /* nothing to open it with */
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
      <h3 class="set-group-title">{{ t('settings.updates.versionGroup', 'Version') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <div class="set-label">
            <span class="about-name">Tessel <span class="about-version" data-test="about-version">{{ updateStatus.current || '' }}</span></span>
            <span class="set-hint" data-test="update-status">{{ statusLine }}</span>
            <details v-if="updateStatus.state === 'error' && updateStatus.message" class="set-more about-raw">
              <summary>{{ t('settings.common.details', 'Details') }}</summary>
              <p>{{ updateStatus.message }}</p>
            </details>
          </div>
          <button
            v-if="updateStatus.state === 'ready'"
            type="button"
            class="exit-btn primary"
            data-test="update-restart"
            @click="emit('open-update')"
          >
            {{ t('settings.updates.restart', 'Restart and update') }}
          </button>
          <button
            v-else
            type="button"
            class="exit-btn"
            data-test="update-check"
            :disabled="['disabled', 'checking', 'downloading'].includes(updateStatus.state)"
            @click="emit('check-updates')"
          >
            {{ updateStatus.state === 'checking' ? t('settings.updates.checkingShort', 'Checking…') : t('settings.updates.checkNow', 'Check now') }}
          </button>
        </div>
        <div class="set-row">
          <div class="set-label">
            {{ t('settings.updates.whatsNew', 'What’s new') }}
            <span class="set-hint" v-text="t('settings.updates.whatsNewHint', 'The release notes of version {{version}}, on GitHub.', { version: notesVersion })"></span>
          </div>
          <button type="button" class="exit-btn about-link" data-test="update-notes" @click="openLink(notesUrl)">
            {{ t('settings.updates.releaseNotes', 'Release notes') }}<ExternalLink :size="12" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>

    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.updates.troubleGroup', 'Troubleshooting') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <div class="set-label">
            {{ t('settings.updates.logsDiagnostics', 'Logs and diagnostics') }}
            <span class="set-hint">{{ t('settings.updates.logsDiagnosticsHint', 'The logs folder and the diagnostics to paste into a report, in General.') }}</span>
          </div>
          <button type="button" class="exit-btn" data-test="about-troubleshooting" @click="openTroubleshooting">{{ t('settings.updates.openInGeneral', 'Open in General') }}</button>
        </div>
        <div class="set-row">
          <div class="set-label">
            {{ t('settings.updates.report', 'Report a problem') }}
            <span class="set-hint">{{ t('settings.updates.reportHint', 'Open an issue on GitHub, with the diagnostics pasted in.') }}</span>
          </div>
          <button type="button" class="exit-btn about-link" data-test="about-report" @click="openLink(`${REPO}/issues`)">
            {{ t('settings.updates.reportButton', 'New issue') }}<ExternalLink :size="12" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>

    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.updates.licensesGroup', 'Licenses') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <div class="set-label">
            {{ t('settings.updates.license', 'Tessel’s license') }}
            <span class="set-hint">{{ t('settings.updates.licenseHint', 'Open source, under the MIT license.') }}</span>
          </div>
          <button type="button" class="exit-btn about-link" data-test="about-license" @click="openLink(fileUrl('LICENSE'))">
            {{ t('settings.updates.view', 'View') }}<ExternalLink :size="12" aria-hidden="true" />
          </button>
        </div>
        <div class="set-row">
          <div class="set-label">
            {{ t('settings.updates.notices', 'Third-party notices') }}
            <span class="set-hint">{{ t('settings.updates.noticesHint', 'The open-source work Tessel includes or adapts, with its licenses.') }}</span>
          </div>
          <button type="button" class="exit-btn about-link" data-test="about-notices" @click="openLink(fileUrl('THIRD_PARTY_NOTICES.md'))">
            {{ t('settings.updates.view', 'View') }}<ExternalLink :size="12" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.about-name {
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 600;
}
.about-version {
  font-variant-numeric: tabular-nums;
}
.about-raw p {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
.about-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
</style>
