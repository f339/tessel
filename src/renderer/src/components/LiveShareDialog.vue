<script setup>
// Live Share (src/main/liveShare.js): Share lets others join this Tessel from
// theirs (the project you share, an invite code that works for an hour, who
// asked and who is in, what each guest may do, Stop sharing); Join opens
// another Tessel's shared screen here with the code its host gave. Why a
// session ended shows here while the dialog is open (a toast says it too).
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { ScreenShare, Copy, Check, Loader2, AlertTriangle, LogIn, LogOut, UserX, RefreshCw } from 'lucide-vue-next'
import { t } from '../i18n'
import { endReason, rightsText } from '../liveShareWindow'

const props = defineProps({
  open: { type: Boolean, default: false },
  initialTab: { type: String, default: 'share' },
  // Your projects ({ id, name }) and the one you share.
  projects: { type: Array, default: () => [] },
  projectId: { type: String, default: null }
})
const emit = defineEmits(['close', 'update:projectId'])

const api = window.shellApi && window.shellApi.liveShare
const OFF_HOST = { state: 'off', invite: null, expiresAt: null, guests: [], progress: null, error: null }
const OFF_GUEST = { state: 'off', host: null, panes: [], layout: null, reason: null, rights: null, code: null }

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
const expired = computed(() => !!host.value.expiresAt && host.value.expiresAt <= now.value)
const expiryText = computed(() => {
  const at = host.value.expiresAt
  if (!at) return ''
  if (expired.value) return t('liveShare.share.expired', 'This code expired: new guests need a new one.')
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return t('liveShare.share.expires', 'New guests can join with it until {{time}}.', { time })
})

function pickProject(event) {
  emit('update:projectId', event.target.value)
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
  { key: 'open', label: () => t('liveShare.share.rightOpen', 'Open'), title: () => t('liveShare.share.rightOpenTitle', 'Open terminals and agents in the project you share') },
  { key: 'close', label: () => t('liveShare.share.rightClose', 'Close'), title: () => t('liveShare.share.rightCloseTitle', 'Ask to close panes (an agent or a running terminal waits for your yes)') }
]
function toggleRight(g, key) {
  if (!api || !api.setRights) return
  const rights = { type: false, open: false, close: false, ...(g.rights || {}) }
  rights[key] = !rights[key]
  api.setRights({ guestId: g.id, rights })
}

async function startSharing() {
  if (!api || busy.value || !props.projectId) return
  busy.value = true
  hostError.value = ''
  try {
    const r = await api.start({ name: name.value.trim() })
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
const inSession = computed(() => ['connecting', 'waiting', 'joined'].includes(guestState.value))
const joinedText = computed(() => t('liveShare.join.joined', 'You joined {{host}}’s Live Share. Their panes are open in the Live Share project.', { host: guest.value.host || '?' }))
const rightsLine = computed(() => rightsText(guest.value.rights))
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
          {{ t('liveShare.share.intro2', 'Others join from their own Tessel and see the project you share, live (its terminals and agents, not their history). Each one waits for your yes, then can only watch.') }}
        </p>

        <div class="ls-warn" role="note">
          <AlertTriangle :size="15" aria-hidden="true" />
          <span>{{ t('liveShare.share.warning2', 'A guest you let type can run any command on this PC as you. Only let people you trust type.') }}</span>
        </div>

        <label class="ls-field">
          <span class="ls-label">{{ t('liveShare.share.project', 'Project to share') }}</span>
          <select class="ls-input ls-select" :value="projectId || ''" :disabled="preparing || !projects.length" data-test="ls-project" @change="pickProject">
            <option v-if="!projects.length" value="" disabled>{{ t('liveShare.share.noProject', 'No project to share') }}</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>

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
          <div class="ls-expiry" :class="{ expired }" data-test="ls-expiry">
            <span>{{ expiryText }}</span>
            <button class="confirm-btn ls-small" :title="t('liveShare.share.newCodeTitle', 'A new code: the old one stops letting anyone in (guests already in stay)')" data-test="ls-new-code" @click="newCode">
              <RefreshCw :size="13" aria-hidden="true" /> {{ t('liveShare.share.newCode', 'New code') }}
            </button>
          </div>

          <div class="ls-guests">
            <div class="ls-label">{{ t('liveShare.share.guests', 'Guests') }}</div>
            <p v-if="!guests.length" class="ls-empty">{{ t('liveShare.share.noGuests', 'No one has joined yet.') }}</p>
            <ul v-else class="ls-guest-list">
              <li v-for="g in guests" :key="g.id" class="ls-guest" :data-test="'ls-guest-' + g.id">
                <span class="ls-guest-name">{{ g.name }}</span>
                <span v-if="g.state !== 'joined'" class="ls-guest-state">{{ guestStateText(g) }}</span>
                <span v-else class="ls-rights" role="group" :aria-label="t('liveShare.share.rightsLabel', 'What {{name}} can do', { name: g.name })">
                  <button
                    v-for="r in RIGHTS"
                    :key="r.key"
                    type="button"
                    class="ls-right"
                    :class="{ on: g.rights && g.rights[r.key] }"
                    :aria-pressed="!!(g.rights && g.rights[r.key])"
                    :title="r.title()"
                    :data-test="'ls-right-' + r.key + '-' + g.id"
                    @click="toggleRight(g, r.key)"
                  >
                    {{ r.label() }}
                  </button>
                </span>
                <button class="confirm-btn ls-small" :data-test="'ls-remove-' + g.id" @click="removeGuest(g)">
                  <UserX :size="13" aria-hidden="true" /> {{ t('liveShare.share.remove', 'Remove') }}
                </button>
              </li>
            </ul>
          </div>
        </template>

        <div v-if="hostError" class="ls-error" role="alert" data-test="ls-host-error">{{ hostError }}</div>

        <div class="confirm-actions">
          <button class="confirm-btn" @click="emit('close')">{{ t('liveShare.close', 'Close') }}</button>
          <button v-if="preparing" class="confirm-btn" data-test="ls-cancel-share" @click="stopSharing">{{ t('liveShare.share.cancel', 'Cancel') }}</button>
          <button v-else-if="sharing" class="confirm-btn primary danger" data-test="ls-stop" @click="stopSharing">{{ t('liveShare.share.stop', 'Stop sharing') }}</button>
          <button v-else class="confirm-btn primary" :disabled="busy || !projectId" data-test="ls-start" @click="startSharing">
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
        <template v-else-if="guestState === 'waiting'">
          <div class="ls-status" data-test="ls-waiting">
            <Loader2 :size="15" class="bp-spin" aria-hidden="true" />
            <span>{{ t('liveShare.join.waiting', 'Waiting for the host to accept…') }}</span>
          </div>
          <div v-if="codeLine" class="ls-joined" data-test="ls-code">{{ codeLine }}</div>
        </template>
        <template v-else>
          <div class="ls-joined" data-test="ls-joined">{{ joinedText }}</div>
          <p class="ls-intro ls-rights-line" data-test="ls-rights">{{ rightsLine }}</p>
        </template>

        <div v-if="joinError" class="ls-error" role="alert" data-test="ls-join-error">{{ joinError }}</div>

        <div class="confirm-actions">
          <button class="confirm-btn" @click="emit('close')">{{ t('liveShare.close', 'Close') }}</button>
          <button v-if="guestState === 'joined'" class="confirm-btn primary danger" data-test="ls-leave" @click="leave">
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
.ls-select {
  cursor: pointer;
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
  align-items: center;
  gap: 10px;
  padding: 5px 6px;
  border-radius: 7px;
  font-size: 12.5px;
}
.ls-guest:hover {
  background: var(--surface-3);
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
