<script setup>
// Live Share (src/main/liveShare.js): Share lets others join this Tessel from
// theirs (the projects you share, ticked before you start and added or taken
// out while you share; an invite code that works for an hour, who asked, who
// is in and who is offline, what each guest may do and which shared projects
// it sees, Stop sharing); Join opens another Tessel's shared projects here
// with the code its host gave. Why a session ended shows here while the
// dialog is open (a toast says it too).
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { ScreenShare, Copy, Check, Loader2, AlertTriangle, LogIn, LogOut, UserX, RefreshCw } from 'lucide-vue-next'
import { t } from '../i18n'
import { endReason, rightsText } from '../liveShareWindow'

const props = defineProps({
  open: { type: Boolean, default: false },
  initialTab: { type: String, default: 'share' },
  // Your projects ({ id, name }), and the ones ticked: shared, or picked to
  // share before you start.
  projects: { type: Array, default: () => [] },
  projectIds: { type: Array, default: () => [] }
})
// toggle-project(id, on): a project ticked or not (liveShareWindow.js setShared).
const emit = defineEmits(['close', 'toggle-project'])

const api = window.shellApi && window.shellApi.liveShare
const OFF_HOST = { state: 'off', invite: null, expiresAt: null, projectIds: [], guests: [], progress: null, error: null }
const OFF_GUEST = { state: 'off', host: null, panes: [], projects: [], reason: null, rights: null, code: null }

const tab = ref(props.initialTab === 'join' ? 'join' : 'share')
const host = ref(OFF_HOST)
const guest = ref(OFF_GUEST)
const name = ref('')
const invite = ref('')
const hostError = ref('')
const joinError = ref('')
// How the session joined from here ended ({ reason, host }): the main
// process forgets it once it said so.
const ended = ref(null)
const busy = ref(false)
const copied = ref(false)
let copiedTimer = 0
// The time, for the invite code's expiry (once a minute is enough).
const now = ref(Date.now())
let clock = 0

const card = ref(null)
let previousFocus = null
const unsubscribe = []

function onHost(status) {
  host.value = status || OFF_HOST
  if (host.value.state === 'error' && host.value.error) hostError.value = host.value.error
}
function onGuest(status) {
  guest.value = status || OFF_GUEST
  if (guest.value.state === 'ended') ended.value = { reason: guest.value.reason, host: guest.value.host }
}

async function refresh() {
  if (!api) return
  try {
    const s = await api.state()
    onHost(s.host)
    if (!(s.guest && s.guest.state === 'off' && guest.value.state === 'ended')) onGuest(s.guest)
    if (!name.value) name.value = s.defaultName || ''
  } catch {
    // Keeps what it showed.
  }
}

onMounted(() => {
  if (api) unsubscribe.push(api.onHost(onHost), api.onGuest(onGuest))
  if (props.open) opened()
  else refresh()
  clock = setInterval(() => (now.value = Date.now()), 30000)
})
onUnmounted(() => {
  for (const off of unsubscribe) if (typeof off === 'function') off()
  clearTimeout(copiedTimer)
  clearInterval(clock)
  restoreFocus()
})

function opened() {
  tab.value = props.initialTab === 'join' ? 'join' : 'share'
  previousFocus = document.activeElement
  refresh()
  nextTick(() => card.value?.focus())
}
function restoreFocus() {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  previousFocus = null
}
watch(
  () => props.open,
  (open) => (open ? opened() : restoreFocus())
)

// --- Share ---------------------------------------------------------------
const hostState = computed(() => host.value.state)
const preparing = computed(() => ['preparing', 'starting', 'checking'].includes(hostState.value))
const sharing = computed(() => hostState.value === 'sharing')
const progressText = computed(() => {
  const h = host.value
  if (h.state === 'preparing')
    return h.progress == null
      ? t('liveShare.share.preparing', 'Getting the Cloudflare tunnel ready…')
      : t('liveShare.share.downloading', 'Downloading the Cloudflare tunnel… {{percent}}%', { percent: Math.round(h.progress * 100) })
  if (h.state === 'starting') return t('liveShare.share.starting', 'Starting…')
  if (h.state === 'checking') return t('liveShare.share.checking', 'Checking the address…')
  return ''
})
const guests = computed(() => (Array.isArray(host.value.guests) ? host.value.guests : []))
// Guests let in who are offline now (they come back by themselves).
const offline = computed(() => (Array.isArray(host.value.offline) ? host.value.offline : []))
// The guests listed: those in or waiting, then those offline (away). What one
// in or offline may do and sees can change (one offline comes back with it).
const rows = computed(() => [...guests.value.map((g) => ({ g, away: false })), ...offline.value.map((g) => ({ g, away: true }))])
function removeKnown(g) {
  if (api && api.removeKnown) api.removeKnown({ id: g.id })
}
const expired = computed(() => !!host.value.expiresAt && host.value.expiresAt <= now.value)
const expiryText = computed(() => {
  const at = host.value.expiresAt
  if (!at) return ''
  if (expired.value) return t('liveShare.share.expired', 'This code expired: new guests need a new one.')
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return t('liveShare.share.expires', 'New guests can join with it until {{time}}.', { time })
})

// The projects ticked; while sharing, the last one can't be unticked (Stop
// sharing ends the share).
const ticked = computed(() => new Set(props.projectIds || []))
const lastShared = (p) => sharing.value && ticked.value.size === 1 && ticked.value.has(p.id)
function toggleProject(p, event) {
  const box = event && event.target
  const on = box ? !!box.checked : !ticked.value.has(p.id)
  // The box shows what is ticked until the answer changes it (sharing: once
  // main says so).
  if (box) box.checked = ticked.value.has(p.id)
  if (!on && lastShared(p)) return
  emit('toggle-project', p.id, on)
}
// The shared projects, by name (the ones this window has).
const sharedList = computed(() => props.projects.filter((p) => ticked.value.has(p.id)))

// A change to what a guest sees or may do (a guest in, or one offline: it
// comes back with it): main makes it against what the guest has then, so
// two clicks in a row never undo each other; a click on a button whose
// change is on its way does nothing. One that could not be made says so.
const pending = ref(new Set())
async function change(key, send) {
  if (pending.value.has(key)) return
  pending.value = new Set([...pending.value, key])
  hostError.value = ''
  const ok = await Promise.resolve()
    .then(send)
    .then((r) => !!(r && r.ok))
    .catch(() => false)
  const rest = new Set(pending.value)
  rest.delete(key)
  pending.value = rest
  if (!ok) hostError.value = t('liveShare.share.changeFailed', 'That change could not be made (the guest may have left or been removed).')
}

// Which shared projects a guest sees: each one on its own; a project shared
// after the guest came in is off until you turn it on.
const sees = (g, p) => Array.isArray(g.projects) && g.projects.includes(p.id)
function toggleGuestProject(g, p) {
  if (!api || !api.setGuestProject) return
  const on = !sees(g, p)
  change(`${g.id}:project:${p.id}`, () => api.setGuestProject({ guestId: g.id, project: p.id, on })) // i18n-ignore
}

async function newCode() {
  if (!api || !api.newInvite) return
  hostError.value = ''
  try {
    const r = await api.newInvite()
    if (r && r.ok) onHost(r)
  } catch {
    hostError.value = t('liveShare.share.newCodeFailed', 'A new code could not be made.')
  }
}

// What a guest may do: each right on its own, off until you turn it on.
const RIGHTS = [
  { key: 'type', label: () => t('liveShare.share.rightType', 'Type'), title: () => t('liveShare.share.rightTypeTitle', 'Type in your terminals and agents (they can run any command as you)') },
  { key: 'open', label: () => t('liveShare.share.rightOpen', 'Open'), title: () => t('liveShare.share.rightOpenTitle2', 'Open terminals and agents in the projects they see') },
  { key: 'close', label: () => t('liveShare.share.rightClose', 'Close'), title: () => t('liveShare.share.rightCloseTitle', 'Ask to close panes (an agent or a running terminal waits for your yes)') }
]
const may = (g, key) => !!(g.rights && g.rights[key])
function toggleRight(g, key) {
  if (!api || !api.setGuestRight) return
  const on = !may(g, key)
  change(`${g.id}:right:${key}`, () => api.setGuestRight({ guestId: g.id, right: key, on })) // i18n-ignore
}

async function startSharing() {
  if (!api || busy.value || !props.projectIds.length) return
  busy.value = true
  hostError.value = ''
  try {
    const r = await api.start({ name: name.value.trim(), projects: [...props.projectIds] })
    if (r && !r.ok && r.error) hostError.value = r.error
  } catch {
    hostError.value = t('liveShare.share.failed', 'Sharing could not start.')
  }
  busy.value = false
}
function stopSharing() {
  if (api) api.stop()
}
function removeGuest(g) {
  if (api) api.removeGuest({ guestId: g.id })
}
async function copyInvite() {
  const code = host.value.invite
  if (!code) return
  try {
    if (window.shellApi && window.shellApi.writeClipboard) await window.shellApi.writeClipboard(code)
    else await navigator.clipboard.writeText(code)
    copied.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = false), 1500)
  } catch {
    hostError.value = t('liveShare.share.copyFailed', 'Could not copy to the clipboard.')
  }
}
const copyLabel = computed(() => (copied.value ? t('liveShare.share.copied', 'Copied') : t('liveShare.share.copy', 'Copy')))
const guestStateText = (g) =>
  g.state === 'joined' ? t('liveShare.share.guestJoined', 'Joined') : g.code ? t('liveShare.share.guestWaitingCode', 'Waiting for your answer (code {{code}})', { code: g.code }) : t('liveShare.share.guestWaiting', 'Waiting for your answer')

// --- Join ----------------------------------------------------------------
const guestState = computed(() => guest.value.state)
const inSession = computed(() => ['connecting', 'waiting', 'joined', 'reconnecting'].includes(guestState.value))
const joinedText = computed(() => t('liveShare.join.joined2', 'You joined {{host}}’s Live Share. Each project they share with you opens as a Live Share project in the sidebar.', { host: guest.value.host || '?' }))
const noProjectsText = computed(() =>
  guest.value.state === 'joined' && !(guest.value.projects || []).length ? t('liveShare.join.noProjects', '{{host}} has not given you a project to see yet.', { host: guest.value.host || '?' }) : ''
)
const rightsLine = computed(() => rightsText(guest.value.rights))
// Its {{host}} would end a template interpolation: built here.
const reconnectingText = computed(() => t('liveShare.join.reconnecting', 'Connection lost: reconnecting to {{host}}…', { host: guest.value.host || '?' }))
const codeLine = computed(() => (guest.value.code ? t('liveShare.join.code', 'Your code is {{code}}. Tell your host, so they know it is you.', { code: guest.value.code }) : ''))

const endedText = computed(() => (ended.value ? endReason(ended.value.reason) : ''))

async function join() {
  const code = invite.value.trim()
  if (!api || !code || busy.value) return
  busy.value = true
  joinError.value = ''
  ended.value = null
  try {
    const r = await api.join({ invite: code, name: name.value.trim() })
    if (r && !r.ok) joinError.value = r.error || t('liveShare.join.failed', 'Could not join.')
  } catch {
    joinError.value = t('liveShare.join.failed', 'Could not join.')
  }
  busy.value = false
}
function leave() {
  if (api) api.leave()
}

// --- Keyboard ------------------------------------------------------------
function trapTab(event) {
  const items = [...(card.value?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)') || [])]
  if (!items.length) return
  const i = items.indexOf(document.activeElement)
  if (event.shiftKey && i <= 0) {
    event.preventDefault()
    items.at(-1).focus()
  } else if (!event.shiftKey && i === items.length - 1) {
    event.preventDefault()
    items[0].focus()
  }
}
</script>

<template>
  <div v-if="open" class="help-backdrop" @pointerdown.self="emit('close')">
    <div
      ref="card"
      class="help-card ls-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ls-title"
      tabindex="-1"
      data-test="live-share-dialog"
      @focusin.stop
      @keydown.escape.prevent.stop="emit('close')"
      @keydown.tab.stop="trapTab"
    >
      <div class="help-head">
        <span id="ls-title"><ScreenShare :size="16" aria-hidden="true" /> {{ t('liveShare.title', 'Live Share') }}</span>
        <button class="tb-icon" :title="t('liveShare.closeEsc', 'Close (Esc)')" :aria-label="t('liveShare.closeEsc', 'Close (Esc)')" @click="emit('close')">✕</button>
      </div>

      <div class="ls-tabs" role="tablist" :aria-label="t('liveShare.title', 'Live Share')">
        <button type="button" role="tab" class="ls-tab" :class="{ on: tab === 'share' }" :aria-selected="tab === 'share'" data-test="ls-tab-share" @click="tab = 'share'">
          {{ t('liveShare.tabs.share', 'Share') }}
        </button>
        <button type="button" role="tab" class="ls-tab" :class="{ on: tab === 'join' }" :aria-selected="tab === 'join'" data-test="ls-tab-join" @click="tab = 'join'">
          {{ t('liveShare.tabs.join', 'Join') }}
        </button>
      </div>

      <div v-if="!api" class="ls-error" role="alert">{{ t('liveShare.unavailable', 'Live Share is not available in this version.') }}</div>

      <!-- Share -->
      <section v-else-if="tab === 'share'" role="tabpanel" data-test="ls-share-panel">
        <p class="ls-intro">
          {{ t('liveShare.share.intro3', 'Others join from their own Tessel and see the projects you share, live (their terminals and agents, not their history). Each one waits for your yes, then can only watch.') }}
        </p>

        <div class="ls-warn" role="note">
          <AlertTriangle :size="15" aria-hidden="true" />
          <span>{{ t('liveShare.share.warning2', 'A guest you let type can run any command on this PC as you. Only let people you trust type.') }}</span>
        </div>

        <fieldset class="ls-field ls-projects" data-test="ls-projects">
          <legend class="ls-label">{{ sharing ? t('liveShare.share.projectsShared', 'Projects you share (tick or untick at any time)') : t('liveShare.share.projects', 'Projects to share') }}</legend>
          <p v-if="!projects.length" class="ls-empty">{{ t('liveShare.share.noProject', 'No project to share') }}</p>
          <ul v-else class="ls-project-list">
            <li v-for="p in projects" :key="p.id">
              <label
                class="ls-project"
                :class="{ locked: lastShared(p) }"
                :title="lastShared(p) ? t('liveShare.share.lastProject', 'To stop sharing your last project, use Stop sharing.') : ''"
                :data-test="'ls-project-' + p.id"
              >
                <input type="checkbox" :checked="ticked.has(p.id)" :disabled="preparing || lastShared(p)" @change="toggleProject(p, $event)" />
                <span class="ls-project-name">{{ p.name }}</span>
              </label>
            </li>
          </ul>
          <p v-if="!sharing && !preparing && projects.length && !projectIds.length" class="ls-hint" data-test="ls-need-project">{{ t('liveShare.share.needProject', 'Tick at least one project.') }}</p>
          <p v-if="sharing && ticked.size === 1" class="ls-hint" data-test="ls-last-project">{{ t('liveShare.share.lastProject', 'To stop sharing your last project, use Stop sharing.') }}</p>
        </fieldset>

        <label v-if="!sharing && !preparing" class="ls-field">
          <span class="ls-label">{{ t('liveShare.share.name', 'Your name (guests see it)') }}</span>
          <input v-model="name" class="ls-input" type="text" spellcheck="false" maxlength="40" data-test="ls-share-name" @keydown.enter="startSharing" />
        </label>

        <div v-if="preparing" class="ls-status" data-test="ls-progress">
          <Loader2 :size="15" class="bp-spin" aria-hidden="true" />
          <span>{{ progressText }}</span>
        </div>

        <template v-if="sharing">
          <label class="ls-field">
            <span class="ls-label">{{ t('liveShare.share.invite', 'Invite code: send it to your guests') }}</span>
            <span class="ls-row">
              <input class="ls-input ls-code" :class="{ expired }" type="text" readonly spellcheck="false" :value="host.invite" data-test="ls-invite" @focus="$event.target.select()" />
              <button class="confirm-btn ls-copy" :disabled="expired" data-test="ls-copy" @click="copyInvite">
                <Check v-if="copied" :size="14" aria-hidden="true" />
                <Copy v-else :size="14" aria-hidden="true" />
                {{ copyLabel }}
              </button>
            </span>
          </label>
          <div v-if="host.inviteBlocked" class="ls-error" role="alert" data-test="ls-blocked">
            {{ t('liveShare.share.blocked', 'Several connections used this code without joining (someone may be trying to get in): it no longer lets anyone in. Make a new code to let guests join.') }}
          </div>
          <div class="ls-expiry" :class="{ expired }" data-test="ls-expiry">
            <span>{{ expiryText }}</span>
            <button class="confirm-btn ls-small" :title="t('liveShare.share.newCodeTitle', 'A new code: the old one stops letting anyone in (guests already in stay)')" data-test="ls-new-code" @click="newCode">
              <RefreshCw :size="13" aria-hidden="true" /> {{ t('liveShare.share.newCode', 'New code') }}
            </button>
          </div>

          <div class="ls-guests">
            <div class="ls-label">{{ t('liveShare.share.guests', 'Guests') }}</div>
            <p v-if="!guests.length && !offline.length" class="ls-empty">{{ t('liveShare.share.noGuests', 'No one has joined yet.') }}</p>
            <p v-else-if="sharedList.length > 1 || guests.some((g) => g.state === 'joined' && sharedList.some((p) => !sees(g, p)))" class="ls-hint" data-test="ls-added-note">
              {{ t('liveShare.share.addedNote', 'Each guest sees only the projects turned on next to their name. A project you share later stays off for guests already in until you turn it on.') }}
            </p>
            <ul v-if="guests.length || offline.length" class="ls-guest-list">
              <li v-for="{ g, away } in rows" :key="g.id" class="ls-guest" :class="{ 'ls-guest-offline': away }" :data-test="(away ? 'ls-offline-' : 'ls-guest-') + g.id">
                <div class="ls-guest-row">
                  <span class="ls-guest-name">{{ g.name || t('liveShare.guest', 'A guest') }}</span>
                  <span v-if="!away && g.state !== 'joined'" class="ls-guest-state">{{ guestStateText(g) }}</span>
                  <span v-else class="ls-rights" role="group" :aria-label="t('liveShare.share.rightsLabel', 'What {{name}} can do', { name: g.name })">
                    <button
                      v-for="r in RIGHTS"
                      :key="r.key"
                      type="button"
                      class="ls-right"
                      :class="{ on: may(g, r.key) }"
                      :aria-pressed="may(g, r.key)"
                      :title="r.title()"
                      :data-test="'ls-right-' + r.key + '-' + g.id"
                      @click="toggleRight(g, r.key)"
                    >
                      {{ r.label() }}
                    </button>
                  </span>
                  <button class="confirm-btn ls-small" :data-test="(away ? 'ls-remove-known-' : 'ls-remove-') + g.id" @click="away ? removeKnown(g) : removeGuest(g)">
                    <UserX :size="13" aria-hidden="true" /> {{ t('liveShare.share.remove', 'Remove') }}
                  </button>
                </div>
                <div v-if="away" class="ls-guest-state">{{ t('liveShare.share.offline', 'Offline: comes back by itself') }}</div>
                <div v-if="(away || g.state === 'joined') && sharedList.length" class="ls-guest-row ls-sees" role="group" :aria-label="t('liveShare.share.seesLabel', 'What {{name}} sees', { name: g.name || t('liveShare.guest', 'A guest') })">
                  <span class="ls-sees-label">{{ t('liveShare.share.sees', 'Sees:') }}</span>
                  <button
                    v-for="p in sharedList"
                    :key="p.id"
                    type="button"
                    class="ls-right ls-project-chip"
                    :class="{ on: sees(g, p) }"
                    :aria-pressed="sees(g, p)"
                    :title="sees(g, p) ? t('liveShare.share.seesOnTitle', 'Click to take {{project}} away from this guest', { project: p.name }) : t('liveShare.share.seesOffTitle', 'Click to let this guest see {{project}}', { project: p.name })"
                    :data-test="'ls-sees-' + p.id + '-' + g.id"
                    @click="toggleGuestProject(g, p)"
                  >
                    {{ p.name }}
                  </button>
                </div>
              </li>
            </ul>
          </div>
        </template>

        <div v-if="hostError" class="ls-error" role="alert" data-test="ls-host-error">{{ hostError }}</div>

        <div class="confirm-actions">
          <button class="confirm-btn" @click="emit('close')">{{ t('liveShare.close', 'Close') }}</button>
          <button v-if="preparing" class="confirm-btn" data-test="ls-cancel-share" @click="stopSharing">{{ t('liveShare.share.cancel', 'Cancel') }}</button>
          <button v-else-if="sharing" class="confirm-btn primary danger" data-test="ls-stop" @click="stopSharing">{{ t('liveShare.share.stop', 'Stop sharing') }}</button>
          <button v-else class="confirm-btn primary" :disabled="busy || !projectIds.length" data-test="ls-start" @click="startSharing">
            {{ t('liveShare.share.start', 'Start sharing') }}
          </button>
        </div>
      </section>

      <!-- Join -->
      <section v-else role="tabpanel" data-test="ls-join-panel">
        <template v-if="!inSession">
          <p class="ls-intro">{{ t('liveShare.join.intro', 'Paste the invite code your host sent you. Their panes open here, in a Live Share project.') }}</p>
          <label class="ls-field">
            <span class="ls-label">{{ t('liveShare.join.invite', 'Invite code') }}</span>
            <input v-model="invite" class="ls-input ls-code" type="text" spellcheck="false" autocomplete="off" data-test="ls-join-invite" @keydown.enter="join" />
          </label>
          <label class="ls-field">
            <span class="ls-label">{{ t('liveShare.join.name', 'Your name (the host sees it)') }}</span>
            <input v-model="name" class="ls-input" type="text" spellcheck="false" maxlength="40" data-test="ls-join-name" @keydown.enter="join" />
          </label>
          <div v-if="ended" class="ls-ended" role="status" data-test="ls-ended">{{ endedText }}</div>
        </template>

        <div v-else-if="guestState === 'connecting'" class="ls-status" data-test="ls-connecting">
          <Loader2 :size="15" class="bp-spin" aria-hidden="true" />
          <span>{{ t('liveShare.join.connecting', 'Connecting…') }}</span>
        </div>
        <div v-else-if="guestState === 'reconnecting'" class="ls-status" data-test="ls-reconnecting">
          <Loader2 :size="15" class="bp-spin" aria-hidden="true" />
          <span>{{ reconnectingText }}</span>
        </div>
        <template v-else-if="guestState === 'waiting'">
          <div class="ls-status" data-test="ls-waiting">
            <Loader2 :size="15" class="bp-spin" aria-hidden="true" />
            <span>{{ t('liveShare.join.waiting', 'Waiting for the host to accept…') }}</span>
          </div>
          <div v-if="codeLine" class="ls-joined" data-test="ls-code">{{ codeLine }}</div>
        </template>
        <template v-else>
          <div class="ls-joined" data-test="ls-joined">{{ joinedText }}</div>
          <p v-if="noProjectsText" class="ls-intro ls-rights-line" data-test="ls-no-projects">{{ noProjectsText }}</p>
          <p class="ls-intro ls-rights-line" data-test="ls-rights">{{ rightsLine }}</p>
        </template>

        <div v-if="joinError" class="ls-error" role="alert" data-test="ls-join-error">{{ joinError }}</div>

        <div class="confirm-actions">
          <button class="confirm-btn" @click="emit('close')">{{ t('liveShare.close', 'Close') }}</button>
          <button v-if="guestState === 'joined' || guestState === 'reconnecting'" class="confirm-btn primary danger" data-test="ls-leave" @click="leave">
            <LogOut :size="14" aria-hidden="true" /> {{ t('liveShare.join.leave', 'Leave') }}
          </button>
          <button v-else-if="inSession" class="confirm-btn" data-test="ls-cancel-join" @click="leave">{{ t('liveShare.join.cancel', 'Cancel') }}</button>
          <button v-else class="confirm-btn primary" :disabled="busy || !invite.trim()" data-test="ls-join" @click="join">
            <LogIn :size="14" aria-hidden="true" /> {{ t('liveShare.join.join', 'Join') }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ls-card {
  width: min(500px, 100%);
}
.help-head span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.ls-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 9px;
}
.ls-tab {
  flex: 1;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.ls-tab:hover {
  background: var(--surface-3);
  color: var(--text);
}
.ls-tab.on {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--text-strong);
}
.ls-tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.ls-intro {
  margin: 0 0 12px;
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.45;
}
.ls-warn {
  display: flex;
  gap: 8px;
  padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--warn) 50%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--warn) 12%, transparent);
  color: var(--text);
  font-size: 12px;
  line-height: 1.45;
}
.ls-warn svg {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--warn);
}
.ls-field {
  display: block;
  margin-top: 14px;
}
.ls-label {
  display: block;
  margin-bottom: 5px;
  color: var(--text-dim);
  font-size: 12px;
}
.ls-row {
  display: flex;
  gap: 8px;
}
.ls-input {
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
}
.ls-input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.ls-code {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
}
.ls-code.expired {
  color: var(--text-dim);
  text-decoration: line-through;
}
.ls-projects {
  min-width: 0;
  margin: 14px 0 0;
  padding: 0;
  border: 0;
}
.ls-projects legend {
  padding: 0;
}
.ls-project-list {
  margin: 0;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 9px;
  list-style: none;
  max-height: 22vh;
  overflow-y: auto;
}
.ls-project {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 7px;
  color: var(--text);
  font-size: 12.5px;
  cursor: pointer;
}
.ls-project:hover {
  background: var(--surface-3);
}
.ls-project.locked {
  cursor: default;
}
.ls-project input {
  margin: 0;
  accent-color: var(--accent);
}
.ls-project-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ls-hint {
  margin: 6px 0 0;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.4;
}
.ls-expiry {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
  color: var(--text-dim);
  font-size: 12px;
}
.ls-expiry span {
  flex: 1;
  min-width: 0;
}
.ls-expiry.expired span {
  color: var(--warn);
}
.ls-rights {
  display: inline-flex;
  gap: 4px;
}
.ls-right {
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.ls-right:hover {
  background: var(--surface-3);
  color: var(--text);
}
.ls-right.on {
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--text-strong);
}
.ls-right:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.ls-rights-line {
  margin: 10px 0 0;
}
.ls-copy {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}
.ls-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  color: var(--text);
  font-size: 12.5px;
}
.ls-guests {
  margin-top: 14px;
}
.ls-empty {
  margin: 0;
  color: var(--text-dim);
  font-size: 12.5px;
}
.ls-guest-list {
  margin: 0;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 9px;
  list-style: none;
  max-height: 30vh;
  overflow-y: auto;
}
.ls-guest {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 5px 6px;
  border-radius: 7px;
  font-size: 12.5px;
}
.ls-guest-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ls-sees {
  flex-wrap: wrap;
  gap: 4px;
}
.ls-sees-label {
  margin-right: 2px;
  color: var(--text-dim);
  font-size: 11.5px;
}
.ls-project-chip {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ls-guest:hover {
  background: var(--surface-3);
}
.ls-guest-offline .ls-guest-name {
  color: var(--text-dim);
}
.ls-guest-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ls-guest-state {
  color: var(--warn);
  font-size: 11.5px;
}
.ls-guest-state.joined {
  color: var(--text-dim);
}
.confirm-btn.ls-small {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  font-size: 12px;
}
.confirm-actions .confirm-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ls-joined,
.ls-ended {
  margin-top: 14px;
  padding: 9px 11px;
  border-radius: 8px;
  color: var(--text-strong);
  font-size: 12.5px;
  line-height: 1.45;
}
.ls-joined {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.ls-ended {
  background: var(--surface-2);
  color: var(--text);
}
.ls-error {
  margin-top: 12px;
  color: var(--danger);
  font-size: 12.5px;
}
</style>
