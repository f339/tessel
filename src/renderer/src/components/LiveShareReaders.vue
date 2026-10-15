<script setup>
// Live Share, as the host: the guests reading a pane's conversation now
// (liveShareWindow.js readersOf), in the pane's header: an eye and their
// count, their names in its tooltip. Guests see an agent pane's conversation
// by default; this keeps it from going unseen.
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
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
      <circle cx="8" cy="8" r="1.9" stroke="currentColor" stroke-width="1.4" />
    </svg>
    <span>{{ names.length }}</span>
  </span>
</template>
