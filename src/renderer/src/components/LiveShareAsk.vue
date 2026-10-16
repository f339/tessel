<script setup>
// What waits for your answer in your Live Share (liveShareWindow.js asks):
// - someone asks to join: the invitation they used, its projects and rights
//   ticked (so letting them in is one click; you can change them first), at
//   least one project to allow, and the verification code their Tessel
//   shows. Once you checked that code with them, you can trust them next
//   time (their Tessel has an identity key: trustable);
// - a guest without the right to open asks to open a terminal or one of your
//   agents in a shared project (Open it or Don't open);
// - a guest asks to close an agent or a running terminal (Close it or Keep
//   it).
// Over every dialog, Live Share's included. The keyboard goes to the card,
// not to a button: keys typed for something else (Enter, Space, Escape)
// answer nothing, and the yes only answers after a moment (again each time
// the projects listed change), so a click meant for something else never
// says yes. A click beside it does not answer: it keeps waiting. Each answer
// goes to the one ask it was shown for (its key). Asks come one at a time;
// how many more wait is said.
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { UserPlus, XCircle, SquareTerminal } from 'lucide-vue-next'
import RightsChecks from './liveshare/RightsChecks.vue'
import { cleanRights } from '../../../shared/liveShareRights'
import { viaName } from '../liveShareAccess'
import { t } from '../i18n'

const ARM_MS = 900

const props = defineProps({
  // { kind: 'join', key, name, code, invite, offer, trustable }, { kind:
  // 'open', key, name, spec, projectName, agentName } or { kind: 'close',
  // key, name, paneName, detail }; null when nothing waits.
  ask: { type: Object, default: null },
  // The projects you share ({ id, name }): a guest let in sees the ones
  // ticked.
  projects: { type: Array, default: () => [] },
  // How many more asks wait after this one (shown in turn).
  more: { type: Number, default: 0 }
})
// answer({ key, yes, projects, rights, trust }): for a join, the projects
// ticked, the rights ticked, and whether they are trusted from now on.
const emit = defineEmits(['answer'])

const kind = computed(() => (props.ask ? props.ask.kind : null))
const isJoin = computed(() => kind.value === 'join')
// Its {{name}} would end a template interpolation: built here.
const title = computed(() => {
  const a = props.ask
  if (!a) return ''
  const name = a.name || t('liveShare.guest', 'A guest')
  if (a.kind === 'close') return t('liveShare.closeAsk.title', '{{name}} wants to close {{pane}}', { name, pane: a.paneName || '?' })
  if (a.kind === 'open')
    return a.agentName ? t('liveShare.openAsk.titleAgent', '{{name}} asks to open {{agent}}', { name, agent: a.agentName }) : t('liveShare.openAsk.titleTerminal', '{{name}} asks to open a terminal', { name })
  return t('liveShare.ask.title', '{{name}} wants to join your Live Share', { name })
})

// The projects this guest will see: the ones ticked. Those its invitation
// offers are ticked (without an invitation's offer: every one listed first);
// one shared while it waits is not, and your own ticks stay.
let listed = new Set()
const ticked = ref(new Set())
const rights = ref(cleanRights(null))
const codeChecked = ref(false)
const trust = ref(false)
const offered = () => {
  const offer = props.ask && props.ask.offer
  return offer ? new Set((offer.projects || []).filter((id) => props.projects.some((p) => p.id === id))) : new Set(props.projects.map((p) => p.id))
}
const chosen = computed(() => props.projects.filter((p) => ticked.value.has(p.id)).map((p) => p.id))
function toggle(p) {
  const next = new Set(ticked.value)
  if (next.has(p.id)) next.delete(p.id)
  else next.add(p.id)
  ticked.value = next
}
function toggleRight(id, on) {
  rights.value = { ...rights.value, [id]: !!on }
}
const viaText = computed(() => {
  const a = props.ask
  if (!a || !a.invite) return ''
  return t('liveShare.ask.via', 'With the invitation “{{invite}}”', { invite: viaName(a.invite) })
})
const codeText = computed(() => (props.ask && props.ask.code ? t('liveShare.ask.code', 'Their Tessel shows the code {{code}}. Check with them that it is the same before you allow.', { code: props.ask.code }) : ''))
// Trust is offered for a Tessel that can be trusted, once the code was
// checked (the person is who they say).
const canTrust = computed(() => isJoin.value && !!props.ask.trustable && !!props.ask.code)

const openText = computed(() => {
  const a = props.ask
  if (!a || a.kind !== 'open') return ''
  return t('liveShare.openAsk.text', 'It runs on your computer, in {{project}}, with your settings. Everyone in the session sees it, and those you let type can type in it.', { project: a.projectName || '?' })
})

const moreText = computed(() =>
  props.more === 1 ? t('liveShare.ask.more', '{{count}} more waiting after this one', { count: 1 }) : t('liveShare.ask.more', '{{count}} more waiting after this one', { count: props.more })
)

const dialog = ref(null)
const armed = ref(false)
let armTimer = 0
let previousFocus = null
// Allowing someone in needs one project ticked at least (none listed yet: a
// share taken back after a restart, before the window found its projects).
const canAllow = computed(() => armed.value && (!isJoin.value || chosen.value.length > 0))
const waitingForProjects = computed(() => isJoin.value && !props.projects.length)

function arm() {
  armed.value = false
  clearTimeout(armTimer)
  armTimer = setTimeout(() => (armed.value = true), ARM_MS)
}
function shown() {
  if (!previousFocus) previousFocus = document.activeElement
  listed = new Set(props.projects.map((p) => p.id))
  ticked.value = offered()
  rights.value = cleanRights(props.ask && props.ask.offer ? props.ask.offer.rights : null)
  codeChecked.value = false
  trust.value = false
  arm()
  nextTick(() => dialog.value?.focus())
}
// The projects listed changed while it waits: new ones come unticked (the
// first ones, when there were none, as offered), and the yes waits a moment
// again.
function listChanged() {
  if (!isJoin.value) return
  const first = !listed.size
  const offer = offered()
  const next = new Set(ticked.value)
  for (const p of props.projects) {
    if (listed.has(p.id)) continue
    listed.add(p.id)
    if (first && offer.has(p.id)) next.add(p.id)
  }
  ticked.value = next
  arm()
}
function restoreFocus() {
  clearTimeout(armTimer)
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  previousFocus = null
}
watch(
  () => props.ask && props.ask.key,
  (key) => (key ? shown() : restoreFocus())
)
watch(() => props.projects.map((p) => p.id).join('\n'), listChanged)
watch(codeChecked, (on) => !on && (trust.value = false))
onMounted(() => {
  if (props.ask) shown()
})
onUnmounted(restoreFocus)

function answer(yes) {
  if (!props.ask || (yes && !canAllow.value)) return
  if (!isJoin.value) emit('answer', { key: props.ask.key, yes: !!yes })
  else emit('answer', { key: props.ask.key, yes: !!yes, projects: [...chosen.value], rights: { ...rights.value }, trust: !!(yes && canTrust.value && codeChecked.value && trust.value) })
}

function trapTab(event) {
  const buttons = [...(dialog.value?.querySelectorAll('button:not(:disabled), input:not(:disabled)') || [])]
  if (!buttons.length) return
  const i = buttons.indexOf(document.activeElement)
  if (event.shiftKey && i <= 0) {
    event.preventDefault()
    buttons.at(-1).focus()
  } else if (!event.shiftKey && i === buttons.length - 1) {
    event.preventDefault()
    buttons[0].focus()
  }
}
</script>

<template>
  <div v-if="ask" class="help-backdrop confirm-backdrop ls-ask-backdrop">
    <div
      ref="dialog"
      class="help-card confirm-card ls-ask-card"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="ls-ask-title"
      aria-describedby="ls-ask-text"
      tabindex="-1"
      data-test="live-share-ask"
      @focusin.stop
      @keydown.escape.prevent.stop
      @keydown.tab.stop="trapTab"
    >
      <h2 id="ls-ask-title" class="confirm-title ls-ask-title">
        <XCircle v-if="kind === 'close'" :size="16" aria-hidden="true" />
        <SquareTerminal v-else-if="kind === 'open'" :size="16" aria-hidden="true" />
        <UserPlus v-else :size="16" aria-hidden="true" />
        <span>{{ title }}</span>
      </h2>
      <div id="ls-ask-text" class="confirm-text">
        <template v-if="kind === 'close'">
          <p class="ls-ask-p">{{ ask.detail }}</p>
          <p class="ls-ask-p ls-ask-dim">{{ t('liveShare.closeAsk.text', 'It closes on your computer, for everyone in the session.') }}</p>
        </template>
        <template v-else-if="kind === 'open'">
          <p class="ls-ask-p" data-test="ls-ask-open-text">{{ openText }}</p>
          <p class="ls-ask-p ls-ask-dim">{{ t('liveShare.openAsk.hint', 'To let them open without asking, give them “Can open terminals and agents” in Live Share.') }}</p>
        </template>
        <template v-else>
          <p v-if="viaText" class="ls-ask-p ls-ask-via" data-test="ls-ask-invite">{{ viaText }}</p>
          <p v-if="codeText" class="ls-ask-p ls-ask-code" data-test="ls-ask-code">{{ codeText }}</p>
          <div class="ls-ask-section">
            <div class="ls-ask-label">{{ t('liveShare.ask.projectsLabel', 'Projects they will see') }}</div>
            <ul v-if="projects.length" class="ls-ask-projects" role="group" :aria-label="t('liveShare.ask.projectsLabel', 'Projects they will see')" data-test="ls-ask-projects">
              <li v-for="p in projects" :key="p.id">
                <label class="ls-ask-project" :data-test="'ls-ask-project-' + p.id">
                  <input type="checkbox" :checked="ticked.has(p.id)" @change="toggle(p)" />
                  <span>{{ p.name }}</span>
                </label>
              </li>
            </ul>
            <p v-if="projects.length && !chosen.length" class="ls-ask-p ls-ask-dim" data-test="ls-ask-need-project">{{ t('liveShare.ask.needProject', 'Tick at least one project to allow them in.') }}</p>
            <p v-if="waitingForProjects" class="ls-ask-p ls-ask-dim" data-test="ls-ask-no-projects">
              {{ t('liveShare.ask.noProjects', 'Tessel is still finding the projects you share: wait a moment to allow them in.') }}
            </p>
          </div>
          <div class="ls-ask-section" data-test="ls-ask-rights">
            <div class="ls-ask-label">{{ t('liveShare.ask.rightsLabel', 'What they can do (they can always watch)') }}</div>
            <RightsChecks :rights="rights" :hints="false" test-key="ask" :label="t('liveShare.ask.rightsLabel', 'What they can do (they can always watch)')" @toggle="toggleRight" />
          </div>
          <div v-if="canTrust" class="ls-ask-section ls-ask-trust" data-test="ls-ask-trust">
            <label class="ls-ask-check" data-test="ls-ask-code-checked">
              <input v-model="codeChecked" type="checkbox" />
              <span>{{ t('liveShare.ask.codeChecked', 'I checked the code with them: it is the same') }}</span>
            </label>
            <label v-if="codeChecked" class="ls-ask-check" data-test="ls-ask-trust-box">
              <input v-model="trust" type="checkbox" />
              <span>{{ t('liveShare.ask.trust', 'Trust this person: next time they get in without asking, with these projects and rights') }}</span>
            </label>
          </div>
        </template>
      </div>
      <p v-if="more > 0" class="ls-ask-more" data-test="ls-ask-more" v-text="moreText"></p>
      <div class="confirm-actions">
        <button class="confirm-btn" data-test="ls-ask-deny" @click="answer(false)">
          {{ kind === 'close' ? t('liveShare.closeAsk.keep', 'Keep it') : kind === 'open' ? t('liveShare.openAsk.no', 'Don’t open') : t('liveShare.ask.deny', 'Deny') }}
        </button>
        <button class="confirm-btn primary" :class="{ danger: kind === 'close' }" :disabled="!canAllow" data-test="ls-ask-allow" @click="answer(true)">
          {{ kind === 'close' ? t('liveShare.closeAsk.close', 'Close it') : kind === 'open' ? t('liveShare.openAsk.yes', 'Open it') : t('liveShare.ask.allow', 'Allow') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Above Live Share's own dialog and the confirmations. */
.ls-ask-backdrop {
  z-index: 650;
}
.ls-ask-card {
  width: min(480px, 100%);
}
.ls-ask-title {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  overflow-wrap: anywhere;
}
.ls-ask-title svg {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--accent);
}
.ls-ask-p {
  margin: 0 0 8px;
  overflow-wrap: anywhere;
}
.ls-ask-dim {
  color: var(--text-dim);
}
.ls-ask-via {
  color: var(--text);
}
.ls-ask-code {
  color: var(--text-strong);
}
.ls-ask-section {
  margin: 0 0 10px;
}
.ls-ask-label {
  margin-bottom: 4px;
  color: var(--text-dim);
  font-size: 12px;
}
.ls-ask-projects {
  max-height: 24vh;
  margin: 0 0 8px;
  padding: 4px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  list-style: none;
}
.ls-ask-project,
.ls-ask-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 3px 6px;
  border-radius: 6px;
  color: var(--text);
  cursor: pointer;
  overflow-wrap: anywhere;
}
.ls-ask-project {
  align-items: center;
}
.ls-ask-project:hover,
.ls-ask-check:hover {
  background: var(--surface-3);
}
.ls-ask-project input,
.ls-ask-check input {
  flex: none;
  margin: 2px 0 0;
  accent-color: var(--accent);
}
.ls-ask-project input {
  margin: 0;
}
.ls-ask-more {
  margin: 4px 0 0;
  color: var(--warn);
  font-size: 12px;
}
.ls-ask-trust {
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.help-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
