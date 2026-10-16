<script setup>
// "Restart and update" confirmation: what's new (the release notes as
// formatted text, sanitized; the release's page on GitHub one click away),
// and what happens to the panes. A link in the notes opens in the browser,
// never in the window.
import { ref, computed, onMounted } from 'vue'
import { X, ExternalLink } from 'lucide-vue-next'
import { t } from '../i18n'
import { releaseNotesHtml } from '../releaseNotes'

const props = defineProps({
  status: { type: Object, required: true },
  panes: { type: Number, default: 0 },
  installing: { type: Boolean, default: false },
  // This version's GitHub release page.
  releaseUrl: { type: String, default: '' }
})
const emit = defineEmits(['install', 'close'])

const headText = computed(() => t('app.update.title', 'Update to Tessel {{version}}', { version: props.status.version }))
const currentText = computed(() =>
  t('app.update.current', 'You have version {{version}}. The new version is downloaded and ready.', {
    version: props.status.current
  })
)
const panesText = computed(() =>
  props.panes === 1
    ? t('app.update.panesOne', 'Your 1 pane reopens where it was, with their recent output, and Claude and Codex resume their conversations.'
      )
    : t('app.update.panesOther', 'Your {{count}} panes reopen where they were, with their recent output, and Claude and Codex resume their conversations.',
        { count: props.panes }
      )
)

const notesHtml = computed(() => releaseNotesHtml(props.status))
const openExternal = (url) => {
  const api = window.shellApi
  if (url && api && typeof api.openExternal === 'function') api.openExternal(url)
}
function onNotesClick(event) {
  const a = event.target && event.target.closest ? event.target.closest('a[href]') : null
  if (!a) return
  event.preventDefault()
  if (/^https?:/i.test(a.getAttribute('href') || '')) openExternal(a.getAttribute('href'))
}
const close = () => !props.installing && emit('close')

const cardEl = ref(null)
onMounted(() => {
  if (cardEl.value) cardEl.value.focus()
})
</script>

<template>
  <div class="help-backdrop" @pointerdown.self="close">
    <div
      ref="cardEl"
      class="help-card update-card"
      role="dialog"
      :aria-label="t('app.update.label', 'Update Tessel')"
      tabindex="-1"
      @keydown.escape.prevent.stop="close"
    >
      <div class="help-head">
        <span>{{ headText }}</span>
        <button class="tb-icon" :disabled="installing" :title="t('app.update.close', 'Close (Esc)')" :aria-label="t('app.update.close', 'Close (Esc)')" data-test="update-close" @click="close">
          <X :size="14" aria-hidden="true" />
        </button>
      </div>

      <p class="update-line">
        {{ currentText }}
      </p>

      <!-- Sanitized (releaseNotes.js): GitHub's HTML or the notes as markdown. -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="notesHtml" class="update-notes" data-test="update-notes" @click="onNotesClick" v-html="notesHtml"></div>
      <button v-if="releaseUrl" type="button" class="update-link" data-test="update-release-notes" @click="openExternal(releaseUrl)">
        {{ t('app.update.releaseNotes', 'Release notes') }} <ExternalLink :size="11" aria-hidden="true" />
      </button>

      <p class="update-line">
        {{ t('app.update.willRestart', 'Tessel will close, install the update and open again.') }}
        <template v-if="panes">
          {{ panesText }}
        </template>
      </p>
      <p class="update-line dim">
        {{
          t('app.update.warning', "Programs running in the terminals are stopped. Let an agent finish what it's doing first. Windows may ask for permission to install."
          )
        }}
      </p>

      <div class="update-actions">
        <button class="exit-btn" :disabled="installing" @click="emit('close')">
          {{ t('app.update.later', 'Later') }}
        </button>
        <button class="exit-btn primary" :disabled="installing" @click="emit('install')">
          {{ installing ? t('app.update.restarting', 'Restarting…') : t('app.update.restart', 'Restart and update') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The notes as formatted text (headings, lists, links), not a <pre>. */
.update-notes {
  white-space: normal;
}
.update-notes :deep(h1),
.update-notes :deep(h2),
.update-notes :deep(h3),
.update-notes :deep(h4) {
  margin: 10px 0 4px;
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 600;
}
.update-notes :deep(:first-child) {
  margin-top: 0;
}
.update-notes :deep(p),
.update-notes :deep(ul),
.update-notes :deep(ol) {
  margin: 4px 0;
}
.update-notes :deep(ul),
.update-notes :deep(ol) {
  padding-left: 18px;
}
.update-notes :deep(li) {
  margin: 2px 0;
}
/* An image is never loaded (sanitized): nothing left to show. */
.update-notes :deep(img) {
  display: none;
}
.update-notes :deep(a) {
  color: var(--accent);
}
.update-notes :deep(code) {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--surface-3);
  font-family: var(--mono, 'Cascadia Mono', Consolas, monospace);
  font-size: 11px;
}
.update-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: -4px 0 4px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.update-link:hover {
  text-decoration: underline;
}
.update-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 3px;
}
</style>
