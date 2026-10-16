<script setup>
// "Where you're signed in" (Settings > AI provider accounts): each account
// (an agent and its email or login) with every place Tessel can see it
// signed in: this PC, its WSL distros, the saved SSH hosts (main's
// signedInPlaces.js). This PC shows at once; each host and distro is
// checked on its own in the background ("checking…"), never with a sign-in.
// Only machines Tessel knows: the providers do not list other devices.
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import BrandIcon from './BrandIcon.vue'
import { t } from '../i18n'
import { agentLabel, timeAgo } from '../sessionHistory'
import { groupAccounts, switchTarget, switchablePanes, panesOnLogin } from '../signedInPlaces'
import { planName, applyHostAccounts, overrideText } from '../hostAccounts'

const panesApi = inject('accountPanes', null)
const places = ref([])
const checking = ref({}) // place id -> true
const busy = ref({}) // action key -> true
const notice = ref('')
const error = ref('')
const loading = ref(true)
const now = ref(Date.now())
const available = computed(() => !!(window.shellApi && window.shellApi.signedIn))
let alive = true
let request = 0

const grouped = computed(() => groupAccounts(places.value))
const panes = computed(() => {
  void now.value
  try {
    return panesApi ? panesApi.list() : []
  } catch {
    return []
  }
})

function setPlace(place) {
  if (!place || typeof place.id !== 'string') return
  const i = places.value.findIndex((p) => p.id === place.id)
  if (i >= 0) places.value.splice(i, 1, place)
  else places.value.push(place)
  // The panes on that host see the same accounts at once.
  if (place.kind === 'ssh' && place.state === 'ready') applyHostAccounts(place.hostId, { ok: true, entries: place.entries.map((e) => ({ ...e })), os: place.os || null })
}

async function scan(id, opts = {}) {
  if (checking.value[id]) return
  checking.value = { ...checking.value, [id]: true }
  try {
    const res = await window.shellApi.signedIn.scan(id, opts)
    if (alive && res && res.ok && res.place) setPlace(res.place)
  } catch {
    /* the place keeps what it showed */
  } finally {
    if (alive) {
      const next = { ...checking.value }
      delete next[id]
      checking.value = next
    }
  }
}

// fresh: every place read again now (Refresh), not from the last minute,
// the login shells of the hosts and distros asked again too.
async function load({ fresh = false } = {}) {
  if (!available.value) return
  const req = ++request
  error.value = ''
  try {
    const res = await window.shellApi.signedIn.places()
    if (!alive || req !== request) return
    if (!res || !res.ok) throw new Error()
    places.value = res.places || []
    now.value = Date.now()
    for (const p of places.value) {
      if (p.kind === 'pc') continue
      if (p.kind === 'ssh' && p.state !== 'not-connected' && (fresh || p.state === 'unknown')) scan(p.id, fresh ? { fresh, relogin: true } : {})
      if (p.kind === 'wsl' && (p.state === 'unknown' || (fresh && p.state === 'ready'))) scan(p.id, fresh ? { fresh, relogin: true } : {})
    }
  } catch {
    if (alive && req === request) error.value = t('signedIn.readFailed', 'The places could not be read.')
  } finally {
    if (alive && req === request) loading.value = false
  }
}

function placeName(place) {
  if (place.kind === 'pc') return t('signedIn.thisPc', 'This PC')
  if (place.kind === 'wsl') return t('signedIn.wsl', '{{name}} (WSL)', { name: place.label })
  return place.label
}
function scopeText(place, entry) {
  if (place.kind === 'pc') return entry.scope === 'system' ? t('signedIn.scope.system', 'its own sign-in') : entry.scope === 'tessel' ? t('signedIn.scope.added', 'added in Tessel') : t('signedIn.scope.own', 'its own sign-in')
  if (entry.scope === 'tessel') return t('signedIn.scope.folder', 'account folder made by Tessel')
  if (entry.scope === 'orphan') return t('signedIn.scope.orphan', 'left by a removed account folder (its agent kept running)')
  if (entry.scope === 'env') return t('signedIn.scope.env', 'its folder from the login shell')
  return t('signedIn.scope.own', 'its own sign-in')
}
function stateText(entry) {
  if (entry.state === 'signed-in') return ''
  if (entry.state === 'profile') return t('signedIn.state.profile', 'signed out (its profile is still there)')
  if (entry.state === 'missing') return t('signedIn.state.missing', 'sign-in needed')
  if (entry.state === 'unknown') return t('signedIn.state.unknown', 'not verified')
  return ''
}
// Something set on the host that is used instead of this sign-in.
function overrideLine(entry) {
  return Array.isArray(entry.override) && entry.override.length ? t('signedIn.override', 'uses {{what}} instead', { what: overrideText(entry.override) }) : ''
}
function seen(entry) {
  return Number.isFinite(entry.lastSeen) && entry.lastSeen > 0 ? t('signedIn.lastSeen', 'last change {{when}}', { when: timeAgo(entry.lastSeen, now.value) }) : ''
}
function groupTitle(g) {
  return g.email || (g.login ? `@${g.login}` : '') || t('signedIn.unnamed', 'Signed in (no account name)')
}
function providersText(entry) {
  return Array.isArray(entry.providers) && entry.providers.length ? entry.providers.map((p) => p.name).join(', ') : ''
}
function placeStatus(place) {
  if (checking.value[place.id]) return t('signedIn.checking', 'checking…')
  if (place.state === 'not-connected') return place.stale ? t('signedIn.notConnectedStale', 'not connected (shown as last checked)') : t('signedIn.notConnected', 'not connected: open a terminal or its project there to check it')
  if (place.state === 'stopped') return t('signedIn.stopped', 'not running')
  if (place.state === 'error') return place.error || t('signedIn.error', 'could not be checked')
  if (place.state === 'unknown') return t('signedIn.notChecked', 'not checked yet')
  const n = (place.entries || []).filter((e) => e.state !== 'empty').length
  return n ? t('signedIn.placeCount', n === 1 ? '{{count}} sign-in' : '{{count}} sign-ins', { count: n }) : t('signedIn.none', 'no sign-in found')
}
const otherPlaces = computed(() => places.value.filter((p) => p.kind !== 'pc'))

function rowTarget(row) {
  return switchTarget(row.place, row.entry, row.place.entries || [])
}
function rowPanes(row) {
  return switchablePanes(row.place, row.entry, rowTarget(row), panes.value)
}
async function switchPane(row, pane) {
  const target = rowTarget(row)
  if (!target || !panesApi) return
  const key = `switch:${pane.id}` // i18n-ignore
  busy.value = { ...busy.value, [key]: true }
  try {
    await panesApi.switchTo(pane.id, target.id)
    notice.value = t('signedIn.switched', '{{pane}} restarts on {{account}}.', { pane: pane.name, account: row.entry.email || row.entry.login || t('signedIn.thisAccount', 'this account') })
  } finally {
    const next = { ...busy.value }
    delete next[key]
    busy.value = next
  }
}
async function act(kind, row) {
  const api = window.shellApi.remoteAccounts
  if (!api || row.place.kind !== 'ssh') return
  const key = `${kind}:${row.place.id}:${row.entry.agent}:${row.entry.id || ''}`
  busy.value = { ...busy.value, [key]: true }
  notice.value = ''
  try {
    // Main asks first (a dialog there): nothing changes without your yes.
    // The panes still on that login are named: main stops them first (a
    // running agent would write the sign-in back).
    const running = panesOnLogin(row.place, row.entry, panes.value).map((p) => p.id)
    const res =
      kind === 'remove'
        ? await api.remove(row.place.hostId, row.entry.agent, row.entry.id, { panes: running, orphan: row.entry.scope === 'orphan' })
        : await api.signOut(row.place.hostId, row.entry.agent, { panes: running })
    if (res && res.ok) {
      notice.value =
        kind === 'remove'
          ? t('signedIn.removed', 'Removed from {{host}}.', { host: row.place.label })
          : res.keychain
            ? t('signedIn.signedOutKeychain', 'Signed out of the sign-in file on {{host}}; the macOS Keychain login remains (sign out in Claude Code there to remove it).', { host: row.place.label })
            : t('signedIn.signedOut', 'Signed out on {{host}}.', { host: row.place.label })
      await scan(row.place.id, { fresh: true })
    } else if (res && !res.cancelled) notice.value = res.error || t('signedIn.actionFailed', 'That could not be done.')
  } catch {
    notice.value = t('signedIn.actionFailed', 'That could not be done.')
  } finally {
    const next = { ...busy.value }
    delete next[key]
    busy.value = next
  }
}
const isBusy = (kind, row) => !!busy.value[`${kind}:${row.place.id}:${row.entry.agent}:${row.entry.id || ''}`]

const clock = setInterval(() => (now.value = Date.now()), 30000)
onMounted(() => load())
onBeforeUnmount(() => {
  alive = false
  clearInterval(clock)
})
</script>

<template>
  <section id="set-signed-in" class="signed-in" data-test="signed-in-places" :aria-busy="loading">
    <header class="si-head">
      <div>
        <h3 class="si-title">{{ t('signedIn.title', 'Where you’re signed in') }}</h3>
        <p class="si-scope">{{ t('signedIn.scopeNote', 'Only the machines Tessel knows: this PC, its WSL distros and your saved SSH hosts. The providers do not tell Tessel which other devices an account is signed in on.') }}</p>
      </div>
      <button type="button" class="exit-btn" data-test="signed-in-refresh" :disabled="!available" @click="load({ fresh: true })">
        {{ t('signedIn.refresh', 'Refresh') }}
      </button>
    </header>
    <p v-if="!available" class="si-empty">{{ t('signedIn.unavailable', 'Not available in this version.') }}</p>
    <p v-else-if="loading" class="si-empty" role="status">{{ t('signedIn.reading', 'Reading…') }}</p>
    <p v-if="error" class="si-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="si-notice" role="status">{{ notice }}</p>

    <div v-for="g in grouped.groups" :key="g.key" class="si-account" data-test="signed-in-account">
      <div class="si-account-head">
        <BrandIcon :kind="g.agent" :label="agentLabel(g.agent)" :size="16" />
        <span class="si-who">{{ groupTitle(g) }}</span>
        <span class="si-meta">{{ [agentLabel(g.agent), planName(g.plan), g.org && g.org !== g.email ? g.org : ''].filter(Boolean).join(' · ') }}</span>
      </div>
      <ul class="si-rows">
        <li v-for="row in g.rows" :key="`${row.place.id}:${row.entry.scope}:${row.entry.id || ''}`" class="si-row" data-test="signed-in-row">
          <div class="si-where">
            <span class="si-place">{{ placeName(row.place) }}</span>
            <span class="si-detail">{{ [scopeText(row.place, row.entry), planName(row.entry.plan), stateText(row.entry), overrideLine(row.entry), seen(row.entry)].filter(Boolean).join(' · ') }}</span>
          </div>
          <div class="si-actions">
            <button
              v-for="pane in rowPanes(row)"
              :key="pane.id"
              type="button"
              class="account-btn"
              data-test="signed-in-switch"
              :disabled="!!busy[`switch:${pane.id}`]"
              :title="t('signedIn.switchHint', 'Restart {{pane}} on this account (same pane)', { pane: pane.name })"
              @click="switchPane(row, pane)"
              v-text="t('signedIn.switch', 'Switch {{pane}}', { pane: pane.name })"
            ></button>
            <button v-if="row.entry.removable" type="button" class="account-btn" data-test="signed-in-remove" :disabled="isBusy('remove', row)" @click="act('remove', row)">
              {{ t('signedIn.remove', 'Remove from this host') }}
            </button>
            <button v-if="row.entry.signOut" type="button" class="account-btn account-quiet" data-test="signed-in-signout" :disabled="isBusy('signOut', row)" @click="act('signOut', row)">
              {{ t('signedIn.signOut', 'Sign out on the host…') }}
            </button>
          </div>
        </li>
      </ul>
    </div>

    <div v-if="grouped.unnamed.length" class="si-account">
      <div class="si-account-head">
        <span class="si-who">{{ t('signedIn.unnamed', 'Signed in (no account name)') }}</span>
      </div>
      <ul class="si-rows">
        <li v-for="row in grouped.unnamed" :key="`${row.place.id}:${row.entry.agent}:${row.entry.scope}`" class="si-row">
          <div class="si-where">
            <span class="si-place">{{ agentLabel(row.entry.agent) }} · {{ placeName(row.place) }}</span>
            <span class="si-detail">{{ [providersText(row.entry), seen(row.entry)].filter(Boolean).join(' · ') }}</span>
          </div>
        </li>
      </ul>
    </div>

    <div v-if="otherPlaces.length" class="si-places">
      <h4 class="si-subtitle">{{ t('signedIn.places', 'Places checked') }}</h4>
      <ul class="si-rows">
        <li v-for="p in otherPlaces" :key="p.id" class="si-row" data-test="signed-in-place">
          <div class="si-where">
            <span class="si-place">{{ placeName(p) }}</span>
            <span class="si-detail" :class="{ checking: checking[p.id] }">{{ placeStatus(p) }}</span>
          </div>
          <div class="si-actions">
            <button v-if="p.kind === 'wsl' && p.state === 'stopped'" type="button" class="account-btn" :disabled="!!checking[p.id]" :title="t('signedIn.startHint', 'Starts this distro to look at its sign-ins')" @click="scan(p.id, { start: true })">
              {{ t('signedIn.check', 'Check') }}
            </button>
            <button v-else-if="p.state !== 'not-connected'" type="button" class="account-btn account-quiet" :disabled="!!checking[p.id]" @click="scan(p.id, { fresh: true })">
              {{ t('signedIn.recheck', 'Check again') }}
            </button>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.signed-in {
  display: grid;
  gap: 10px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--text);
  min-width: 0;
}
.signed-in p {
  margin: 0;
}
.si-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.si-title {
  margin: 0 0 2px;
  font-size: 13px;
  color: var(--text-strong);
}
.si-subtitle {
  margin: 4px 0 2px;
  font-size: 11.5px;
  color: var(--text-dim);
  font-weight: 600;
}
.si-scope,
.si-empty {
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 1.45;
}
.si-error {
  color: var(--danger, var(--warn));
}
.si-notice {
  color: var(--text-dim);
}
.si-account {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.si-account-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.si-who {
  color: var(--text-strong);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.si-meta {
  color: var(--text-dim);
  font-size: 11px;
}
.si-rows {
  list-style: none;
  margin: 0;
  padding: 0 0 0 22px;
  display: grid;
  gap: 2px;
}
.si-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  margin: 0 -8px;
  border-radius: 6px;
  min-width: 0;
}
.si-row:hover {
  background: var(--surface-3);
}
.si-where {
  display: grid;
  gap: 1px;
  min-width: 0;
}
.si-place {
  color: var(--text);
  overflow-wrap: anywhere;
}
.si-detail {
  color: var(--text-dim);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.si-detail.checking {
  font-style: italic;
}
.si-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}
.account-btn {
  min-height: 24px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  color: var(--text);
  background: transparent;
  font: inherit;
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.account-btn:hover:not(:disabled) {
  color: var(--text-strong);
  background: var(--surface-3);
}
.account-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.account-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.account-quiet {
  border-color: transparent;
}
</style>
