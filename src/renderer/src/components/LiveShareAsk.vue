<script setup>
// Someone asks to join your Live Share (src/main/liveShare.js askApproval):
// Allow or Deny. Over every dialog, Live Share's included. The keyboard
// starts on Deny: an Enter typed for something else never lets anyone in.
// A click beside it does not answer: the guest keeps waiting.
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { UserPlus } from 'lucide-vue-next'
import { t } from '../i18n'

const props = defineProps({
  // { guestId, name }, or null when no one is waiting.
  ask: { type: Object, default: null }
})
const emit = defineEmits(['answer'])

// Its {{name}} would end a template interpolation: built here.
const title = computed(() => (props.ask ? t('liveShare.ask.title', '{{name}} wants to join your Live Share', { name: props.ask.name || t('liveShare.guest', 'A guest') }) : ''))
const dialog = ref(null)
const denyEl = ref(null)
let previousFocus = null

function shown() {
  if (!previousFocus) previousFocus = document.activeElement
  nextTick(() => denyEl.value?.focus())
}
function restoreFocus() {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  previousFocus = null
}
watch(
  () => props.ask && props.ask.guestId,
  (id) => (id ? shown() : restoreFocus())
)
onMounted(() => {
  if (props.ask) shown()
})
onUnmounted(restoreFocus)

function answer(yes) {
  if (props.ask) emit('answer', !!yes)
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
        <UserPlus :size="16" aria-hidden="true" />
        <span>{{ title }}</span>
      </h2>
      <p id="ls-ask-text" class="confirm-text">
        {{ t('liveShare.ask.text', 'They will see your screen and can type in your terminals and agents.') }}
      </p>
      <div class="confirm-actions">
        <button ref="denyEl" class="confirm-btn" data-test="ls-ask-deny" @click="answer(false)">{{ t('liveShare.ask.deny', 'Deny') }}</button>
        <button class="confirm-btn primary" data-test="ls-ask-allow" @click="answer(true)">{{ t('liveShare.ask.allow', 'Allow') }}</button>
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
</style>
