<script setup>
// Resume a session: Past conversations in a dialog, from the palette. The
// same surface as the right side panel's tab (SessionHistoryPanel.vue): its
// list, scope, search (and session search, the opt-in index of what was
// said), rows, details and menus. Resuming a conversation or going to the
// pane it is open in closes the dialog (App.vue).
import SessionHistoryPanel from './SessionHistoryPanel.vue'
import { t } from '../i18n'

defineProps({
  cwd: { type: String, default: null }, // current workspace folder
  openIds: { type: Object, default: () => ({}) } // sessionId -> paneId
})
const emit = defineEmits(['close', 'resume', 'show', 'open-editor', 'toast'])
</script>

<template>
  <div class="help-backdrop" @pointerdown.self="emit('close')">
    <div
      class="help-card sessions-card"
      role="dialog"
      aria-modal="true"
      :aria-label="t('sessionHistory.title', 'Past conversations')"
      tabindex="-1"
      data-test="sessions-dialog"
      @keydown.escape.prevent.stop="emit('close')"
    >
      <SessionHistoryPanel
        embedded
        :cwd="cwd"
        :open-ids="openIds"
        @resume="(s) => emit('resume', s)"
        @focus-pane="(id) => emit('show', id)"
        @open-editor="(file) => emit('open-editor', file)"
        @toast="(text) => emit('toast', text)"
      >
        <template #actions>
          <button class="sh-icon-btn" :title="t('app.sessions.close', 'Close (Esc)')" :aria-label="t('app.sessions.close', 'Close (Esc)')" data-test="sessions-close" @click="emit('close')">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>
        </template>
      </SessionHistoryPanel>
    </div>
  </div>
</template>

<style scoped>
/* The panel fills the card: its header stays, its list scrolls. */
.sessions-card {
  display: flex;
  flex-direction: column;
  width: min(720px, 100%);
  height: min(680px, calc(100vh - 60px));
  padding: 0;
  overflow: hidden;
}
.sessions-card > :deep(.sh-panel) {
  flex: 1 1 auto;
  min-height: 0;
  border-radius: inherit;
}
.sessions-card :deep(.sh-head) {
  padding: 12px 14px 10px;
}
.sessions-card :deep(.sh-title) {
  font-size: 14px;
}
</style>
