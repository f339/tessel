<script setup>
// Live Share, as the host: the guests reading a pane's conversation now
// (liveShareWindow.js readersOf, from main's presence), in the pane's
// header: a chat bubble with an eye and their count, their names in its
// tooltip. Guests see an agent pane's conversation by default; this keeps it
// from going unseen. (Watching and typing: LiveSharePresence.)
import { computed, inject } from 'vue'
import { t } from '../i18n'

const props = defineProps({ paneId: { type: String, required: true } })
const ctx = inject('panelCtx', null)
const names = computed(() => (ctx && typeof ctx.liveShareReaders === 'function' ? ctx.liveShareReaders(props.paneId) : []))
const label = computed(() => t('liveShare.readers.title', 'Reading this conversation in Live Share: {{names}}', { names: names.value.join(', ') }))
</script>

<template>
  <span v-if="names.length" class="pane-ls-readers" data-test="pane-liveshare-readers" :title="label" :aria-label="label" role="status">
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.8 2.8h12.4v8.4H7.4l-3.4 2.6v-2.6H1.8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
      <path d="M4.4 7s1.4-2 3.6-2 3.6 2 3.6 2-1.4 2-3.6 2-3.6-2-3.6-2z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
      <circle cx="8" cy="7" r="0.9" fill="currentColor" />
    </svg>
    <span>{{ names.length }}</span>
  </span>
</template>
