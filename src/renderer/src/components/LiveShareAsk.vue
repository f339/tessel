<script setup>
// What waits for your answer in your Live Share (liveShareWindow.js asks):
// someone asks to join (Allow or Deny, with the verification code their
// Tessel shows, and the shared projects they will see: the ones shown first
// ticked, one shared while it waits unticked, at least one to allow), or a
// guest asks to close an agent or a running terminal (Close it or Keep it).
// Over every dialog, Live Share's included. The keyboard goes to the card,
// not to a button: keys typed for something else (Enter, Space, Escape)
// answer nothing, and the yes only answers after a moment (again each time
// the projects listed change), so a click meant for something else never
// says yes. A click beside it does not answer: it keeps waiting. Each answer
// goes to the one ask it was shown for (its key).
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { UserPlus, XCircle } from 'lucide-vue-next'
import { t } from '../i18n'

const ARM_MS = 900

const props = defineProps({
  // { kind: 'join', key, name, code } or { kind: 'close', key, name,
  // paneName, detail }; null when nothing waits.
  ask: { type: Object, default: null },
  // The projects you share ({ id, name }): a guest let in sees the ones
  // ticked.
  projects: { type: Array, default: () => [] }
})
// answer({ key, yes, projects }): projects (a join) are the ids ticked.
const emit = defineEmits(['answer'])

const isClose = computed(() => !!(props.ask && props.ask.kind === 'close'))
// Its {{name}} would end a template interpolation: built here.
const title = computed(() => {
  const a = props.ask
  if (!a) return ''
  const name = a.name || t('liveShare.guest', 'A guest')
  return a.kind === 'close'
    ? t('liveShare.closeAsk.title', '{{name}} wants to close {{pane}}', { name, pane: a.paneName || '?' })
    : t('liveShare.ask.title', '{{name}} wants to join your Live Share', { name })
})
// The projects this guest will see: the ones ticked. Those listed first are
// ticked (once the window has them); one shared while it waits is not, and
// your own ticks stay. With one project shared and ticked, nothing to
// choose.
let listed = new Set(props.projects.map((p) => p.id)) // the projects listed so far for this ask
const ticked = ref(new Set(listed))
const choosing = computed(() => !isClose.value && (props.projects.length > 1 || (props.projects.length === 1 && !ticked.value.has(props.projects[0].id))))
const chosen = computed(() => props.projects.filter((p) => ticked.value.has(p.id)).map((p) => p.id))
function toggle(p) {
  const next = new Set(ticked.value)
  if (next.has(p.id)) next.delete(p.id)
  else next.add(p.id)
  ticked.value = next
}
const joinText = computed(() =>
  choosing.value
    ? t('liveShare.ask.textProjects', 'Tick what they will see live. They can only watch until you let them type (Live Share, in the toolbar).')
    : props.projects.length === 1
      ? t('liveShare.ask.textProject', 'They will see {{project}} live. They can only watch until you let them type (Live Share, in the toolbar).', { project: props.projects[0].name })
      : t('liveShare.ask.text', 'They will see the project you share live. They can only watch until you let them type (Live Share, in the toolbar).')
)
const codeText = computed(() => (props.ask && props.ask.code ? t('liveShare.ask.code', 'Their Tessel shows the code {{code}}. Check with them that it is the same before you allow.', { code: props.ask.code }) : ''))

const dialog = ref(null)
const armed = ref(false)
let armTimer = 0
let previousFocus = null
// Allowing someone in needs one project ticked at least (none listed yet: a
// share taken back after a restart, before the window found its projects).
const canAllow = computed(() => armed.value && (isClose.value || chosen.value.length > 0))
const waitingForProjects = computed(() => !!props.ask && !isClose.value && !props.projects.length)

function arm() {
  armed.value = false
  clearTimeout(armTimer)
  armTimer = setTimeout(() => (armed.value = true), ARM_MS)
}
function shown() {
  if (!previousFocus) previousFocus = document.activeElement
  listed = new Set(props.projects.map((p) => p.id))
  ticked.value = new Set(listed)
  arm()
  nextTick(() => dialog.value?.focus())
}
// The projects listed changed while it waits: new ones come unticked (the
// first ones, when there were none, ticked), and the yes waits a moment
// again.
function listChanged() {
  if (!props.ask || isClose.value) return
  const first = !listed.size
  const next = new Set(ticked.value)
  for (const p of props.projects) {
    if (listed.has(p.id)) continue
    listed.add(p.id)
    if (first) next.add(p.id)
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
onMounted(() => {
  if (props.ask) shown()
})
onUnmounted(restoreFocus)

function answer(yes) {
  if (!props.ask || (yes && !canAllow.value)) return
  if (isClose.value) emit('answer', { key: props.ask.key, yes: !!yes })
  else emit('answer', { key: props.ask.key, yes: !!yes, projects: [...chosen.value] })
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
      class="help-card confirm-card"
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
        <XCircle v-if="isClose" :size="16" aria-hidden="true" />
        <UserPlus v-else :size="16" aria-hidden="true" />
        <span>{{ title }}</span>
      </h2>
      <div id="ls-ask-text" class="confirm-text">
        <template v-if="isClose">
          <p class="ls-ask-p">{{ ask.detail }}</p>
          <p class="ls-ask-p ls-ask-dim">{{ t('liveShare.closeAsk.text', 'It closes on your computer, for everyone in the session.') }}</p>
        </template>
        <template v-else>
          <p class="ls-ask-p">{{ joinText }}</p>
          <ul v-if="choosing" class="ls-ask-projects" role="group" :aria-label="t('liveShare.ask.projectsLabel', 'Projects they will see')" data-test="ls-ask-projects">
            <li v-for="p in projects" :key="p.id">
              <label class="ls-ask-project" :data-test="'ls-ask-project-' + p.id">
                <input type="checkbox" :checked="ticked.has(p.id)" @change="toggle(p)" />
                <span>{{ p.name }}</span>
              </label>
            </li>
          </ul>
          <p v-if="choosing && !chosen.length" class="ls-ask-p ls-ask-dim" data-test="ls-ask-need-project">{{ t('liveShare.ask.needProject', 'Tick at least one project to allow them in.') }}</p>
          <p v-if="waitingForProjects" class="ls-ask-p ls-ask-dim" data-test="ls-ask-no-projects">
            {{ t('liveShare.ask.noProjects', 'Tessel is still finding the projects you share: wait a moment to allow them in.') }}
          </p>
          <p v-if="codeText" class="ls-ask-p ls-ask-code" data-test="ls-ask-code">{{ codeText }}</p>
        </template>
      </div>
      <div class="confirm-actions">
        <button class="confirm-btn" data-test="ls-ask-deny" @click="answer(false)">
          {{ isClose ? t('liveShare.closeAsk.keep', 'Keep it') : t('liveShare.ask.deny', 'Deny') }}
        </button>
        <button class="confirm-btn primary" :class="{ danger: isClose }" :disabled="!canAllow" data-test="ls-ask-allow" @click="answer(true)">
          {{ isClose ? t('liveShare.closeAsk.close', 'Close it') : t('liveShare.ask.allow', 'Allow') }}
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
.ls-ask-code {
  color: var(--text-strong);
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
.ls-ask-project {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 6px;
  border-radius: 6px;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.ls-ask-project:hover {
  background: var(--surface-3);
}
.ls-ask-project input {
  margin: 0;
  accent-color: var(--accent);
}
.help-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
