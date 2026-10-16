<script setup>
// "Where you're signed in" (Settings > AI provider accounts): each provider,
// its accounts (an email or login, its plan), and each place Tessel can see
// that account signed in as a chip: this PC, its WSL distros, the saved SSH
// hosts (main's signedInPlaces.js). A chip opens what can be done there
// (Make default here, Sign out on the host, Remove from this host, Check
// again); "Switch panes…" restarts the panes on other accounts on this one.
// This PC shows at once; each host and distro is checked on its own in the
// background ("checking…"), never with a sign-in. The places not read yet
// fold into one quiet line. Only machines Tessel knows: the providers do not
// list other devices. Laid out like Settings > Skills (rows, chips, a detail
// panel on click). A Claude account's plan is the one Anthropic last
// reported (claudePlan.js), not its login file's; panes on an account with
// no subscription are said at the top, with Switch panes… to move them.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Check, ChevronRight } from 'lucide-vue-next'
import BrandIcon from './BrandIcon.vue'
import OrcaMenu from './OrcaMenu.vue'
import { t } from '../i18n'
import { agentLabel, timeAgo } from '../sessionHistory'
import { groupByProvider, panesOnLogin, panesUsing, placesToCheck, shownOrg, switchCandidates, switchTarget } from '../signedInPlaces'
import { planName, applyHostAccounts, overrideText, isDefaultHostAccount, setDefaultHostAccount, HOST_ACCOUNT_AGENTS } from '../hostAccounts'
import { planInfo } from '../claudePlan'

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

const providers = computed(() => groupByProvider(places.value))
const toCheck = computed(() => placesToCheck(places.value, checking.value))
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
// A chip's own word, when its place shows twice for one account.
function scopeShort(place, entry) {
  if (place.kind === 'pc') return entry.scope === 'tessel' ? t('signedIn.scopeShort.added', 'added in Tessel') : t('signedIn.scopeShort.own', 'own sign-in')
  if (entry.scope === 'tessel') return t('signedIn.scopeShort.folder', 'folder')
  if (entry.scope === 'orphan') return t('signedIn.scopeShort.orphan', 'left over')
  if (entry.scope === 'env') return t('signedIn.scopeShort.env', 'login shell folder')
  return t('signedIn.scopeShort.own', 'own sign-in')
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
function providersText(entry) {
  return Array.isArray(entry.providers) && entry.providers.length ? entry.providers.map((p) => p.name).join(', ') : ''
}
function placeStatus(place) {
  if (checking.value[place.id]) return t('signedIn.checking', 'checking…')
  if (place.state === 'not-connected') return place.stale ? t('signedIn.notConnectedStale', 'not connected (shown as last checked)') : t('signedIn.notConnectedShort', 'not connected')
  if (place.state === 'stopped') return t('signedIn.stopped', 'not running')
  if (place.state === 'error') return place.error || t('signedIn.error', 'could not be checked')
  if (place.state === 'unknown') return t('signedIn.notChecked', 'not checked yet')
  const n = (place.entries || []).filter((e) => e.state !== 'empty').length
  return n ? t('signedIn.placeCount', n === 1 ? '{{count}} sign-in' : '{{count}} sign-ins', { count: n }) : t('signedIn.none', 'no sign-in found')
}

// --- An account ---------------------------------------------------------------
function accountName(a) {
  if (a.unknown) return t('signedIn.unknownAccount', 'Unknown account')
  return a.email || (a.login ? `@${a.login}` : '') || t('signedIn.unnamedShort', 'Account')
}
function accountMeta(a) {
  if (a.unknown) {
    const kinds = [...new Set(a.chips.map((c) => providersText(c.entry)).filter(Boolean))]
    if (kinds.length) return kinds.join(' · ')
    // Signed in somewhere, or only a profile left (signed out): said.
    return a.chips.some((c) => c.entry.state === 'signed-in') ? t('signedIn.unknownHint', 'signed in; its account is not known yet') : t('signedIn.unknownSignedOut', 'signed out; its account is not known')
  }
  return shownOrg(a.org, a.email)
}
function usedBy(a) {
  return panesUsing(a, panes.value)
}
function usedByText(a) {
  const n = usedBy(a).length
  return n === 1 ? t('signedIn.usedByOne', 'Used by 1 pane') : t('signedIn.usedBy', 'Used by {{count}} panes', { count: n })
}
// Its subscription as Anthropic last reported it (a Claude account), or null.
function planOf(a) {
  void now.value
  return a && a.agent === 'claude' ? planInfo(a.sub, now.value) : null
}
// A sign-in's plan in words: the checked one, else its login file's.
function entryPlanText(entry) {
  const info = entry.agent === 'claude' ? planInfo(entry.sub, now.value) : null
  return info ? info.title : planName(entry.plan)
}

// --- Panes on an account with no subscription (a notice at the top) ---------
// The accounts that need it (no subscription, or a payment issue, no trial
// running) with panes on them; the panes once each; and where they can go:
// another account of that agent whose subscription is active (checked), else
// one not known to lack one, that can take at least one of them.
const attention = computed(() => {
  const all = providers.value.flatMap((p) => p.accounts)
  const bad = all.filter((a) => !a.unknown && planOf(a)?.attention && usedBy(a).length)
  if (!bad.length) return null
  const panesOnBad = new Map()
  for (const a of bad) for (const pane of usedBy(a)) panesOnBad.set(pane.id, pane)
  const takes = (a) => switchGroups(a).some((g) => g.items.some((i) => panesOnBad.has(i.pane.id)))
  const others = all.filter((a) => !a.unknown && a.agent === bad[0].agent && !bad.includes(a) && takes(a))
  const target = others.find((a) => planOf(a) && !planOf(a).warn) || others.find((a) => !planOf(a)?.warn) || null
  return {
    count: panesOnBad.size,
    ids: [...panesOnBad.keys()],
    payment: bad.every((a) => planOf(a).warn === 'payment'),
    names: bad.map(accountName).join(', '),
    target
  }
})
const attentionText = computed(() => {
  const n = attention.value
  if (!n) return ''
  if (n.payment) return n.count === 1 ? t('signedIn.paymentPanesOne', '1 pane uses an account with a payment issue') : t('signedIn.paymentPanes', '{{count}} panes use an account with a payment issue', { count: n.count })
  return n.count === 1 ? t('signedIn.noSubPanesOne', '1 pane uses an account with no subscription') : t('signedIn.noSubPanes', '{{count}} panes use an account with no subscription', { count: n.count })
})
// Switch panes… from the notice: the target account's panel, open, with the
// panes on the account without subscription already ticked.
function switchFromNotice() {
  const n = attention.value
  if (!n || !n.target) return
  switchOpen.value = n.target.key
  const ticked = {}
  for (const g of switchGroups(n.target)) for (const i of g.items) if (n.ids.includes(i.pane.id)) ticked[i.pane.id] = true
  picked.value = ticked
  nextTick(() => {
    const panel = document.querySelector('[data-test="signed-in-switch-panel"]')
    if (panel && panel.scrollIntoView) panel.scrollIntoView({ block: 'nearest' })
  })
}
// Its places' Check again, at once (an unknown account: its name may be
// there by now).
function recheckAccount(a) {
  for (const id of new Set(a.chips.map((c) => c.place.id))) {
    const place = places.value.find((p) => p.id === id)
    if (place && !(place.kind === 'ssh' && place.state === 'not-connected')) scan(id, { fresh: true })
  }
}

// --- Its chips (a place each) -------------------------------------------------
const chipKey = (row) => `${row.place.id}:${row.entry.agent}:${row.entry.scope}:${row.entry.id || ''}`
function chipLabel(a, row) {
  const twice = a.chips.filter((c) => c.place.id === row.place.id).length > 1
  return twice ? `${placeName(row.place)} · ${scopeShort(row.place, row.entry)}` : placeName(row.place)
}
// on: signed in there; warn: something else is used instead; off: signed
// out there; stale: the place not read now (shown as last checked).
function chipState(row) {
  if (checking.value[row.place.id]) return 'checking'
  if (row.place.state !== 'ready') return 'stale'
  if (row.entry.state !== 'signed-in') return 'off'
  return (Array.isArray(row.entry.override) && row.entry.override.length) || row.entry.linked ? 'warn' : 'on'
}
// What a chip says beside its place when it is not signed in there.
function chipStateShort(row) {
  if (row.entry.state === 'signed-in') return ''
  if (row.entry.state === 'unknown') return t('signedIn.stateShort.unknown', 'not verified')
  if (row.entry.state === 'missing') return t('signedIn.stateShort.missing', 'sign-in needed')
  return t('signedIn.stateShort.out', 'signed out')
}
function chipTitle(row) {
  return [
    placeName(row.place),
    scopeText(row.place, row.entry),
    entryPlanText(row.entry),
    stateText(row.entry),
    overrideLine(row.entry),
    seen(row.entry),
    row.place.state !== 'ready' || checking.value[row.place.id] ? placeStatus(row.place) : '',
    isDefault(row) ? t('signedIn.isDefault', 'default for new panes') : ''
  ]
    .filter(Boolean)
    .join(' · ')
}
function rowTarget(row) {
  return switchTarget(row.place, row.entry, row.place.entries || [])
}
// On an SSH host: the account new panes of that agent use there (Settings).
function defaultTarget(row) {
  if (row.place.kind !== 'ssh' || !HOST_ACCOUNT_AGENTS.includes(row.entry.agent)) return null
  return rowTarget(row)
}
function isDefault(row) {
  const target = defaultTarget(row)
  return !!target && isDefaultHostAccount(row.place.hostId, row.entry.agent, target.id)
}
function makeDefault(row) {
  const target = defaultTarget(row)
  if (!target) return
  setDefaultHostAccount(row.place.hostId, row.entry.agent, target.id)
  notice.value = t('signedIn.defaultSet', 'New {{agent}} panes on {{host}} now start on this account.', { agent: agentLabel(row.entry.agent), host: row.place.label })
}

// A chip's menu (OrcaMenu): what can be done at that place.
const chipMenu = ref(null) // { key, row, rect, el }
let lastClosed = { key: '', at: 0 }
let picking = false
// A menu item's action (its close is no press outside the menu).
const pick = (fn) => () => {
  picking = true
  fn()
}
function openChip(row, ev, { keyboard = false } = {}) {
  const key = chipKey(row)
  // The press that closed it (outside the menu) does not open it again.
  if (lastClosed.key === key && Date.now() - lastClosed.at < 300) return
  const el = ev.currentTarget
  chipMenu.value = { key, row, rect: el.getBoundingClientRect(), el }
  if (keyboard)
    nextTick(() => {
      const first = document.querySelector('.orca-menu [data-orca-menu-item]:not([disabled])')
      if (first) first.focus()
    })
}
function closeChip() {
  const m = chipMenu.value
  const picked = picking
  picking = false
  chipMenu.value = null
  if (!m) return
  if (!picked) lastClosed = { key: m.key, at: Date.now() }
  // The focus was in the menu (gone now): back to its chip.
  const inMenu = document.activeElement && document.activeElement.closest && document.activeElement.closest('.orca-menu')
  if (inMenu) nextTick(() => m.el && m.el.isConnected && m.el.focus())
}
const chipItems = computed(() => {
  const m = chipMenu.value
  if (!m) return []
  const row = m.row
  const items = [{ type: 'label', label: [placeName(row.place), scopeText(row.place, row.entry), entryPlanText(row.entry), stateText(row.entry)].filter(Boolean).join(' · ') }]
  const acts = []
  if (defaultTarget(row))
    acts.push(
      isDefault(row)
        ? { type: 'item', icon: Check, label: t('signedIn.menu.isDefault', 'Default for new panes here'), disabled: true }
        : { type: 'item', label: t('signedIn.menu.makeDefault', 'Make default here'), title: t('signedIn.makeDefaultHint', 'New panes of this agent on {{host}} start on this account', { host: row.place.label }), onSelect: pick(() => makeDefault(row)) }
    )
  if (row.entry.signOut) acts.push({ type: 'item', label: t('signedIn.signOut', 'Sign out on the host…'), disabled: isBusy('signOut', row), onSelect: pick(() => act('signOut', row)) })
  if (row.entry.removable) acts.push({ type: 'item', danger: true, label: t('signedIn.menu.remove', 'Remove from this host…'), disabled: isBusy('remove', row), onSelect: pick(() => act('remove', row)) })
  items.push(...acts)
  if (acts.length) items.push({ type: 'separator' })
  const offline = row.place.kind === 'ssh' && row.place.state === 'not-connected'
  items.push({
    type: 'item',
    label: t('signedIn.recheck', 'Check again'),
    disabled: !!checking.value[row.place.id] || offline,
    title: offline ? t('signedIn.openToCheck', 'Open a terminal there to check it') : undefined,
    onSelect: pick(() => scan(row.place.id, { fresh: true }))
  })
  return items
})

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

// --- Switch panes… (a panel under the account) ------------------------------
const switchOpen = ref('') // the account's key
const picked = ref({}) // pane id -> true
const switchGroups = (a) => switchCandidates(a, panes.value)
function toggleSwitch(a) {
  switchOpen.value = switchOpen.value === a.key ? '' : a.key
  picked.value = {}
}
function togglePick(id, on) {
  const next = { ...picked.value }
  if (on) next[id] = true
  else delete next[id]
  picked.value = next
}
const pickedCount = (a) => switchGroups(a).reduce((n, g) => n + g.items.filter((i) => picked.value[i.pane.id]).length, 0)
async function restartPicked(a) {
  const chosen = switchGroups(a).flatMap((g) => g.items).filter((i) => picked.value[i.pane.id])
  if (!chosen.length || !panesApi) return
  const key = `switch:${a.key}` // i18n-ignore
  busy.value = { ...busy.value, [key]: true }
  try {
    for (const { pane, target } of chosen) await panesApi.switchTo(pane.id, target.id)
    const account = a.email || a.login || t('signedIn.thisAccount', 'this account')
    notice.value = chosen.length === 1 ? t('signedIn.switched', '{{pane}} restarts on {{account}}.', { pane: chosen[0].pane.name, account }) : t('signedIn.switchedMany', '{{count}} panes restart on {{account}}.', { count: chosen.length, account })
    switchOpen.value = ''
    picked.value = {}
  } finally {
    const next = { ...busy.value }
    delete next[key]
    busy.value = next
  }
}

// --- The places not shown with an account -------------------------------------
const placesOpen = ref(false)
const waitingText = computed(() => {
  const names = toCheck.value.waiting.map(placeName)
  if (!names.length) return ''
  const shown = names.slice(0, 2).join(', ')
  const more = names.length - 2
  return more > 0
    ? t('signedIn.notCheckedMore', 'Not checked yet: {{names}} and {{count}} more. Open a terminal there to check.', { names: shown, count: more })
    : t('signedIn.notCheckedList', 'Not checked yet: {{names}}. Open a terminal there to check.', { names: shown })
})
const checkingText = computed(() => {
  const names = places.value.filter((p) => checking.value[p.id] && p.kind !== 'pc').map(placeName)
  return names.length ? t('signedIn.checkingList', 'Checking {{names}}…', { names: names.join(', ') }) : ''
})
const placesToggleText = computed(() => (placesOpen.value ? t('signedIn.hidePlaces', 'Hide the places') : t('signedIn.showPlaces', 'All places ({{count}})', { count: toCheck.value.all.length })))
const canRecheck = (p) => !checking.value[p.id] && !(p.kind === 'ssh' && p.state === 'not-connected') && !(p.kind === 'wsl' && p.state === 'stopped')

const clock = setInterval(() => (now.value = Date.now()), 30000)
// A Claude account's subscription checked again (main's claudePlanCheck.js,
// or a host's own check): the places read again.
let stopPlans = null
onMounted(() => {
  load()
  try {
    stopPlans = window.shellApi?.accounts?.onPlansChanged?.(() => load()) || null
  } catch {
    stopPlans = null
  }
})
onBeforeUnmount(() => {
  alive = false
  clearInterval(clock)
  if (typeof stopPlans === 'function') stopPlans()
})
</script>

<template>
  <section id="set-signed-in" class="signed-in" data-test="signed-in-places" :aria-busy="loading">
    <header class="si-head">
      <div class="si-head-text">
        <h3 class="si-title">{{ t('signedIn.title', 'Where you’re signed in') }}</h3>
        <p class="si-scope" :title="t('signedIn.scopeNote', 'Only the machines Tessel knows: this PC, its WSL distros and your saved SSH hosts. The providers do not tell Tessel which other devices an account is signed in on.')">
          {{ t('signedIn.scopeNoteShort', 'Only the machines Tessel knows: this PC, its WSL distros and your SSH hosts.') }}
        </p>
      </div>
      <button type="button" class="account-btn" data-test="signed-in-refresh" :disabled="!available" @click="load({ fresh: true })">
        {{ t('signedIn.refresh', 'Refresh') }}
      </button>
    </header>
    <p v-if="!available" class="si-empty">{{ t('signedIn.unavailable', 'Not available in this version.') }}</p>
    <p v-else-if="loading" class="si-empty" role="status">{{ t('signedIn.reading', 'Reading…') }}</p>
    <p v-if="error" class="si-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="si-notice" role="status">{{ notice }}</p>
    <div v-if="attention" class="si-attention" role="status" data-test="signed-in-no-sub" :title="t('signedIn.noSubAccounts', 'Accounts: {{names}}', { names: attention.names })">
      <span class="si-attention-text">
        <span v-text="attentionText"></span><span v-if="!attention.target" v-text="' ' + t('signedIn.noSubAdd', 'Add an account with a subscription to move them.')"></span>
      </span>
      <button v-if="attention.target" type="button" class="account-btn" data-test="signed-in-no-sub-switch" @click="switchFromNotice">
        {{ t('signedIn.switchPanes', 'Switch panes…') }}
      </button>
    </div>

    <section v-for="p in providers" :key="p.agent" class="si-provider" data-test="signed-in-provider" :aria-label="agentLabel(p.agent)">
      <h4 class="si-provider-head">
        <BrandIcon :kind="p.agent" :label="agentLabel(p.agent)" :size="14" />
        <span>{{ agentLabel(p.agent) }}</span>
        <span class="si-count">{{ p.accounts.length }}</span>
      </h4>
      <ul class="si-list">
        <li v-for="a in p.accounts" :key="a.key" class="si-item" :class="{ open: switchOpen === a.key }" data-test="signed-in-account">
          <div class="si-acct" :class="{ unknown: a.unknown }">
            <div class="si-acct-main">
              <span class="si-who" :title="accountName(a)">{{ accountName(a) }}</span>
              <template v-if="planOf(a)">
                <span v-if="planOf(a).tag" class="si-tag" :class="{ warn: planOf(a).warn === 'none' }" data-test="signed-in-plan" :title="planOf(a).title">{{ planOf(a).tag }}</span>
                <span v-if="planOf(a).warn && planOf(a).warn !== 'none'" class="si-tag warn" data-test="signed-in-plan-warn" :title="planOf(a).title">{{ planOf(a).warnText }}</span>
                <span v-if="planOf(a).trialText" class="si-tag" data-test="signed-in-plan-trial" :title="planOf(a).title">{{ planOf(a).trialText }}</span>
              </template>
              <span v-else-if="planName(a.plan)" class="si-tag" data-test="signed-in-plan">{{ planName(a.plan) }}</span>
              <span v-if="accountMeta(a)" class="si-meta" :title="a.org || accountMeta(a)">{{ accountMeta(a) }}</span>
            </div>
            <div class="si-acct-side">
              <template v-if="!a.unknown">
                <span v-if="usedBy(a).length" class="si-used" :class="{ warn: !!planOf(a)?.attention }" data-test="signed-in-used" :title="usedBy(a).map((x) => x.name).join(', ')">{{ usedByText(a) }}</span>
                <!-- Never offered toward an account with no subscription: its
                     panes are moved away from it (the notice above). -->
                <button
                  v-if="switchGroups(a).length && !planOf(a)?.attention"
                  type="button"
                  class="account-btn"
                  data-test="signed-in-switch-open"
                  :aria-expanded="switchOpen === a.key"
                  :aria-controls="`si-switch-${p.agent}-${p.accounts.indexOf(a)}`"
                  @click="toggleSwitch(a)"
                >
                  {{ t('signedIn.switchPanes', 'Switch panes…') }}
                </button>
              </template>
              <button v-else type="button" class="account-btn" data-test="signed-in-unknown-check" @click="recheckAccount(a)">
                {{ t('signedIn.recheck', 'Check again') }}
              </button>
            </div>
            <div class="si-chips" role="list" :aria-label="t('signedIn.placesOf', 'Where {{account}} is signed in', { account: accountName(a) })">
              <span v-for="row in a.chips" :key="chipKey(row)" role="listitem" class="si-chip-wrap">
                <button
                  type="button"
                  class="si-chip"
                  :class="[chipState(row), { open: chipMenu && chipMenu.key === chipKey(row) }]"
                  data-test="signed-in-chip"
                  aria-haspopup="menu"
                  :aria-expanded="!!(chipMenu && chipMenu.key === chipKey(row))"
                  :title="chipTitle(row)"
                  :aria-label="chipTitle(row)"
                  @click="openChip(row, $event, { keyboard: $event.detail === 0 })"
                >
                  <span class="si-dot" aria-hidden="true"></span>
                  <span class="si-chip-name">{{ chipLabel(a, row) }}</span>
                  <span v-if="chipStateShort(row)" class="si-chip-state" data-test="signed-in-chip-state">{{ chipStateShort(row) }}</span>
                  <span v-if="isDefault(row)" class="si-chip-default" data-test="signed-in-default">{{ t('signedIn.defaultShort', 'default') }}</span>
                </button>
              </span>
            </div>
          </div>
          <div v-if="switchOpen === a.key" :id="`si-switch-${p.agent}-${p.accounts.indexOf(a)}`" class="si-switch" data-test="signed-in-switch-panel">
            <p class="si-switch-head" v-text="t('signedIn.switchIntro', 'Restart these panes on {{account}} (same pane, its conversation resumed where it can):', { account: accountName(a) })"></p>
            <fieldset v-for="g in switchGroups(a)" :key="g.place.id" class="si-switch-group">
              <legend>{{ placeName(g.place) }}</legend>
              <label v-for="i in g.items" :key="i.pane.id" class="si-switch-pane">
                <input type="checkbox" data-test="signed-in-switch-pane" :value="i.pane.id" :checked="!!picked[i.pane.id]" @change="togglePick(i.pane.id, $event.target.checked)" />
                <span>{{ i.pane.name }}</span>
              </label>
            </fieldset>
            <div class="si-switch-actions">
              <button type="button" class="account-btn primary" data-test="signed-in-switch-go" :disabled="!pickedCount(a) || !!busy[`switch:${a.key}`]" @click="restartPicked(a)">
                {{ t('signedIn.restartOnAccount', 'Restart on this account') }}
              </button>
              <button type="button" class="account-btn account-quiet" @click="toggleSwitch(a)">{{ t('signedIn.cancel', 'Cancel') }}</button>
            </div>
          </div>
        </li>
      </ul>
    </section>

    <OrcaMenu :open="!!chipMenu" :anchor="chipMenu && chipMenu.rect" :items="chipItems" :width="260" :label="chipMenu ? chipTitle(chipMenu.row) : ''" @close="closeChip" />

    <footer v-if="toCheck.all.length" class="si-foot" data-test="signed-in-foot">
      <p v-if="checkingText" class="si-foot-line" role="status">{{ checkingText }}</p>
      <p v-for="w in toCheck.stopped" :key="w.id" class="si-foot-line" data-test="signed-in-wsl-stopped">
        <span v-text="t('signedIn.wslStopped', '{{name}} not started', { name: w.label })"></span>
        <span aria-hidden="true">·</span>
        <button type="button" class="si-link" :title="t('signedIn.startHint', 'Starts this distro to look at its sign-ins')" @click="scan(w.id, { start: true })">{{ t('signedIn.check', 'Check') }}</button>
      </p>
      <p class="si-foot-line">
        <span v-if="waitingText" data-test="signed-in-waiting">{{ waitingText }}</span>
        <button type="button" class="si-link" data-test="signed-in-places-toggle" :aria-expanded="placesOpen" aria-controls="si-all-places" @click="placesOpen = !placesOpen">
          <ChevronRight :size="12" class="si-chevron" :class="{ open: placesOpen }" aria-hidden="true" />
          <span v-text="placesToggleText"></span>
        </button>
      </p>
      <ul v-if="placesOpen" id="si-all-places" class="si-places">
        <li v-for="pl in toCheck.all" :key="pl.id" class="si-place" data-test="signed-in-place">
          <span class="si-place-name">{{ placeName(pl) }}</span>
          <span class="si-place-status" :class="{ checking: checking[pl.id] }">{{ placeStatus(pl) }}</span>
          <button v-if="pl.kind === 'wsl' && pl.state === 'stopped'" type="button" class="si-link" :disabled="!!checking[pl.id]" @click="scan(pl.id, { start: true })">{{ t('signedIn.check', 'Check') }}</button>
          <button v-else-if="canRecheck(pl)" type="button" class="si-link" @click="scan(pl.id, { fresh: true })">{{ t('signedIn.recheck', 'Check again') }}</button>
        </li>
      </ul>
    </footer>
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
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.si-head-text {
  min-width: 0;
}
.si-title {
  margin: 0 0 2px;
  font-size: 13px;
  color: var(--text-strong);
}
.si-scope,
.si-empty {
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 1.45;
}
.si-scope {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.si-error {
  color: var(--danger, var(--warn));
}
.si-notice {
  color: var(--text-dim);
}

/* A provider: a small header, then one row per account (Skills' rows). */
.si-provider {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.si-provider-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0;
  color: var(--text-dim);
  font-size: 11.5px;
  font-weight: 600;
}
.si-count {
  padding: 0 5px;
  border-radius: 8px;
  background: var(--surface-3);
  font-size: 10.5px;
  font-weight: 400;
  line-height: 16px;
}
.si-list {
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--border);
  container-type: inline-size;
}
.si-item {
  border-bottom: 1px solid var(--border);
}
.si-acct {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: 'main side' 'chips chips';
  align-items: center;
  gap: 5px 12px;
  padding: 7px 8px;
  border-radius: 6px;
}
.si-acct:hover,
.si-item.open > .si-acct {
  background: var(--surface-3);
}
.si-acct-main {
  grid-area: main;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.si-who {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.si-acct.unknown .si-who {
  color: var(--text-dim);
}
.si-tag {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--text-strong);
  font-size: 10.5px;
  line-height: 16px;
  white-space: nowrap;
}
/* No subscription (or a payment issue): the warning colour. */
.si-tag.warn {
  background: color-mix(in srgb, var(--warn, #d29922) 20%, transparent);
  color: var(--warn, #d29922);
}
.si-meta {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-dim);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.si-acct-side {
  grid-area: side;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  white-space: nowrap;
}
.si-used {
  color: var(--text-dim);
  font-size: 11px;
}
.si-used.warn {
  color: var(--warn, #d29922);
}
/* Panes on an account with no subscription: one line, its action beside it. */
.si-attention {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  padding: 7px 10px;
  border: 1px solid color-mix(in srgb, var(--warn, #d29922) 45%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--warn, #d29922) 10%, transparent);
  min-width: 0;
}
.si-attention-text {
  flex: 1 1 220px;
  min-width: 0;
  color: var(--text-strong);
  line-height: 1.45;
}
.si-chips {
  grid-area: chips;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}
.si-chip-wrap {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
}
.si-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: 11px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.si-chip:hover,
.si-chip.open {
  color: var(--text-strong);
  background: var(--surface-2, var(--surface-3));
}
.si-chip:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.si-chip-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.si-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-dim);
}
.si-chip.on .si-dot {
  background: #3fb950;
}
.si-chip.warn .si-dot {
  background: var(--warn, #d29922);
}
.si-chip.off .si-dot {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--text-dim);
}
.si-chip.stale {
  color: var(--text-dim);
}
.si-chip.checking .si-dot {
  animation: si-pulse 1s ease-in-out infinite;
}
@keyframes si-pulse {
  50% {
    opacity: 0.3;
  }
}
.si-chip-state {
  flex: 0 0 auto;
  color: var(--text-dim);
}
.si-chip-default {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--text-strong);
  font-size: 10px;
  line-height: 14px;
}

/* Switch panes…: a panel under the account, the panes by place. */
.si-switch {
  display: grid;
  gap: 8px;
  margin: 0 8px 8px 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.si-switch-head {
  color: var(--text-dim);
}
.si-switch-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.si-switch-group legend {
  float: left;
  width: 100%;
  margin-bottom: 2px;
  padding: 0;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 600;
}
.si-switch-pane {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
}
.si-switch-actions {
  display: flex;
  gap: 6px;
}

/* The places not read now: one quiet line, the list on demand. */
.si-foot {
  display: grid;
  gap: 4px;
  color: var(--text-dim);
  font-size: 11.5px;
}
.si-foot-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
  min-width: 0;
}
.si-link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.si-link:hover:not(:disabled) {
  text-decoration: underline;
}
.si-link:disabled {
  opacity: 0.5;
  cursor: default;
}
.si-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 3px;
}
.si-chevron {
  transition: transform 0.12s ease;
}
.si-chevron.open {
  transform: rotate(90deg);
}
.si-places {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0 0 0 14px;
  list-style: none;
}
.si-place {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.si-place-name {
  flex: 0 0 auto;
  max-width: 45%;
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.si-place-status {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.si-place-status.checking {
  font-style: italic;
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
.account-btn.primary {
  border-color: transparent;
  background: var(--accent);
  color: #0b1530;
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

/* Narrow (the page, or zoomed in): the name has the whole line, the panes'
   line goes beside the chips (under them when they fill it). */
@container (max-width: 560px) {
  .si-acct {
    grid-template-areas: 'main main' 'chips side';
    align-items: start;
  }
  .si-acct-side {
    align-self: start;
  }
}
</style>
