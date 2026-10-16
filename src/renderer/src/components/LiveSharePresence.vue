<script setup>
// Live Share, as the host: who is at one of your panes now (liveShareWindow.js
// presenceOf, from main's presence pushes), in the pane's header and on its
// row in the sidebar: an eye with their initials while they have it on
// screen, a typing mark while they type in it (gone a few seconds after
// they stop). Their conversation read as a chat shows with LiveShareReaders
// in the header; the sidebar's compact form shows it too (a chat bubble).
import { computed, inject } from 'vue'
import { initials } from '../liveShareAccess'
import { t } from '../i18n'

const props = defineProps({
  paneId: { type: String, required: true },
  // The sidebar's row: smaller, the readers included.
  compact: { type: Boolean, default: false }
})
const ctx = inject('panelCtx', null)
const all = computed(() => (ctx && typeof ctx.liveSharePresence === 'function' ? ctx.liveSharePresence(props.paneId) : []))
const typing = computed(() => all.value.filter((p) => p.typing))
const watching = computed(() => all.value.filter((p) => p.watching && !p.typing))
const reading = computed(() => (props.compact ? all.value.filter((p) => p.reading && !p.typing && !p.watching) : []))
const short = (list) => list.slice(0, 2).map((p) => p.initials || initials(p.name)).join(' ') + (list.length > 2 ? ` +${list.length - 2}` : '')
const names = (list) => list.map((p) => p.name).join(', ')
const typingLabel = computed(() => t('liveShare.presence.typing', 'Typing here in Live Share: {{names}}', { names: names(typing.value) }))
const watchingLabel = computed(() => t('liveShare.presence.watching', 'Watching this pane in Live Share: {{names}}', { names: names(watching.value) }))
const readingLabel = computed(() => t('liveShare.readers.title', 'Reading this conversation in Live Share: {{names}}', { names: names(reading.value) }))
</script>

<template>
  <span v-if="typing.length || watching.length || reading.length" class="ls-presence" :class="{ compact }" data-test="ls-presence">
    <span v-if="typing.length" class="ls-presence-chip typing" role="status" :title="typingLabel" :aria-label="typingLabel" data-test="ls-presence-typing">
      <span class="ls-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <span aria-hidden="true">{{ short(typing) }}</span>
    </span>
    <span v-if="watching.length" class="ls-presence-chip" role="status" :title="watchingLabel" :aria-label="watchingLabel" data-test="ls-presence-watching">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        <circle cx="8" cy="8" r="1.9" stroke="currentColor" stroke-width="1.4" />
      </svg>
      <span aria-hidden="true">{{ short(watching) }}</span>
    </span>
    <span v-if="reading.length" class="ls-presence-chip" role="status" :title="readingLabel" :aria-label="readingLabel" data-test="ls-presence-reading">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
        <circle cx="8" cy="7" r="1.3" fill="currentColor" />
      </svg>
      <span aria-hidden="true">{{ short(reading) }}</span>
    </span>
  </span>
</template>
