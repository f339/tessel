<script setup>
// What waits for your answer in your Live Share (liveShareWindow.js asks):
// someone asks to join (Allow or Deny, with the verification code their
// Tessel shows), or a guest asks to close an agent or a running terminal
// (Close it or Keep it). Over every dialog, Live Share's included. The
// keyboard starts on Deny / Keep it, and the yes only answers after a
// moment: an Enter or a click meant for something else never says yes. A
// click beside it does not answer: it keeps waiting. Each answer goes to the
// one ask it was shown for (its key).
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { UserPlus, XCircle, ShieldAlert } from 'lucide-vue-next'
import { t } from '../i18n'

const ARM_MS = 900

const props = defineProps({
  // { kind: 'join', key, name, code, forward } or { kind: 'close', key, name,
  // paneName, detail }; null when nothing waits.
  ask: { type: Object, default: null },
  // The project you share (its name), said in the join question.
  project: { type: String, default: '' }
})
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
const joinText = computed(() =>
  props.project
    ? t('liveShare.ask.textProject', 'They will see {{project}} live. They can only watch until you let them type (Live Share, in the toolbar).', { project: props.project })
    : t('liveShare.ask.text', 'They will see the project you share live. They can only watch until you let them type (Live Share, in the toolbar).')
)
const codeText = computed(() => (props.ask && props.ask.code ? t('liveShare.ask.code', 'Their Tessel shows the code {{code}}. Check with them that it is the same before you allow.', { code: props.ask.code }) : ''))

const dialog = ref(null)
const noEl = ref(null)
const armed = ref(false)
let armTimer = 0
let previousFocus = null

function shown() {
  if (!previousFocus) previousFocus = document.activeElement
  armed.value = false
  clearTimeout(armTimer)
  armTimer = setTimeout(() => (armed.value = true), ARM_MS)
  nextTick(() => noEl.value?.focus())
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
onMounted(() => {
  if (props.ask) shown()
})
onUnmounted(restoreFocus)

function answer(yes) {
  if (!props.ask || (yes && !armed.value)) return
  emit('answer', { key: props.ask.key, yes: !!yes })
}

function trapTab(event) {
  const buttons = [...(dialog.value?.querySelectorAll('button:not(:disabled)') || [])]
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
      data-test="live-share-ask"
      @focusin.stop
      @keydown.escape.prevent.stop="answer(false)"
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
          <p v-if="codeText" class="ls-ask-p ls-ask-code" data-test="ls-ask-code">{{ codeText }}</p>
          <p v-if="!ask.forward" class="ls-ask-p ls-ask-old" data-test="ls-ask-old">
            <ShieldAlert :size="14" aria-hidden="true" />
            <span>{{ t('liveShare.ask.older', 'Their Tessel is older: the session is encrypted with the invite code only.') }}</span>
          </p>
        </template>
      </div>
      <div class="confirm-actions">
        <button ref="noEl" class="confirm-btn" data-test="ls-ask-deny" @click="answer(false)">
          {{ isClose ? t('liveShare.closeAsk.keep', 'Keep it') : t('liveShare.ask.deny', 'Deny') }}
        </button>
        <button class="confirm-btn primary" :class="{ danger: isClose }" :disabled="!armed" data-test="ls-ask-allow" @click="answer(true)">
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
.ls-ask-old {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  color: var(--warn);
}
.ls-ask-old svg {
  flex: 0 0 auto;
  margin-top: 2px;
}
</style>
