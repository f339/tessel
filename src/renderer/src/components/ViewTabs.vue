<script setup>
// The tabs above the panes (paneViews.js): Terminal (the grid of terminals
// and agents), then each editor and browser pane of the grid on screen, each
// shown alone in the whole room. A click shows one; an editor's or a
// browser's × (or a middle-click) closes it. Drawn above the grid on the
// Terminal tab, and in the header of the editor or browser on screen, so it
// is always the one line at the top: Terminal first, always.
import { computed } from 'vue'
import { Globe, SquareTerminal, X } from 'lucide-vue-next'
import { t } from '../i18n'
import { fileName, docPathOf, samePath } from '../editor/editorTabs'
import { BLANK_URL, displayUrl, hostOf } from '../../../shared/browserUrl'

const props = defineProps({
  // The view's editor and browser panes, in the order of its tree.
  leaves: { type: Array, default: () => [] },
  // The tab on screen: 'terminal' or a pane's id.
  shown: { type: String, default: 'terminal' }
})
// select / close (id, path): path: a file of an editor (its tab); keep (id,
// path): a preview file's tab double-clicked stays open.
const emit = defineEmits(['select', 'close', 'keep'])

// An editor: a tab per file it has open (its path on hover; in italics while
// it is a preview, replaced by the next file opened with one click); with
// none, one "Editor" tab. A browser: its page's title, else its host.
function editorTabs(leaf) {
  const files = leaf.files || []
  if (!files.length) return [{ key: leaf.id, id: leaf.id, path: null, kind: 'editor', label: t('app.viewTabs.editor', 'Editor'), hint: t('app.viewTabs.editor', 'Editor') }]
  return files.map((f) => {
    const path = docPathOf(f)
    const label = f.diff ? t('app.viewTabs.diff', '{{name}} (diff)', { name: fileName(path) }) : fileName(path)
    return {
      key: `${leaf.id}|${f.path}`,
      id: leaf.id,
      path: f.path,
      kind: 'editor',
      label,
      hint: f.preview ? t('app.viewTabs.previewHint', '{{path}}\nPreview: double-click to keep it open', { path }) : path,
      preview: !!f.preview,
      current: samePath(f.path, leaf.activePath)
    }
  })
}
function browserTab(leaf) {
  const url = leaf.url && leaf.url !== BLANK_URL ? leaf.url : ''
  const label = leaf.title || (url && hostOf(url)) || t('app.viewTabs.browser', 'Browser')
  return { key: leaf.id, id: leaf.id, path: null, kind: 'browser', label, hint: url ? displayUrl(url) : label }
}
const tabs = computed(() => [
  { key: 'terminal', id: 'terminal', path: null, kind: 'terminal', label: t('app.viewTabs.terminal', 'Terminal'), hint: t('app.viewTabs.terminalHint', 'The terminals and agents of this project') },
  ...props.leaves.flatMap((leaf) => (leaf.kind === 'editor' ? editorTabs(leaf) : [browserTab(leaf)]))
])
// On screen: its view, and for a file its editor's current file.
const isActive = (tab) => tab.id === props.shown && (!tab.path || tab.current)

function onAuxClick(e, tab) {
  if (e.button === 1 && tab.kind !== 'terminal') emit('close', tab.id, tab.path)
}
</script>

<template>
  <div
    class="view-tabs"
    role="tablist"
    data-test="view-tabs"
    :aria-label="t('app.viewTabs.aria', 'Terminal, editors and browsers')"
    @mousedown.stop
    @pointerdown.stop
    @dblclick.stop
  >
    <div
      v-for="tab in tabs"
      :key="tab.key"
      class="view-tab"
      :class="[tab.kind, { active: isActive(tab), preview: tab.preview }]"
      role="tab"
      tabindex="0"
      data-test="view-tab"
      :data-tab="tab.id"
      :data-path="tab.path || undefined"
      :aria-selected="isActive(tab)"
      :title="tab.hint"
      @click="emit('select', tab.id, tab.path)"
      @dblclick="tab.preview && emit('keep', tab.id, tab.path)"
      @keydown.enter.prevent="emit('select', tab.id, tab.path)"
      @keydown.space.prevent="emit('select', tab.id, tab.path)"
      @mousedown.middle.prevent
      @auxclick="onAuxClick($event, tab)"
    >
      <SquareTerminal v-if="tab.kind === 'terminal'" class="view-tab-icon" :size="14" aria-hidden="true" />
      <svg v-else-if="tab.kind === 'editor'" class="view-tab-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <Globe v-else class="view-tab-icon" :size="14" aria-hidden="true" />
      <span class="view-tab-label">{{ tab.label }}</span>
      <button
        v-if="tab.kind !== 'terminal'"
        type="button"
        class="view-tab-close"
        tabindex="-1"
        data-test="view-tab-close"
        :title="t('app.viewTabs.close', 'Close {{name}}', { name: tab.label })"
        :aria-label="t('app.viewTabs.close', 'Close {{name}}', { name: tab.label })"
        @click.stop="emit('close', tab.id, tab.path)"
      >
        <X :size="12" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
/* A preview file (one click): in italics, like VS Code's. */
.view-tab.preview .view-tab-label {
  font-style: italic;
}
.view-tabs {
  display: flex;
  align-items: stretch;
  align-self: stretch;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.view-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 220px;
  padding: 0 4px 0 10px;
  border-right: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  outline: none;
}
.view-tab.terminal {
  flex-shrink: 0;
  padding-right: 12px;
}
.view-tab:hover {
  color: var(--text);
  background: var(--surface-2);
}
/* The tab on screen: the colour of the pane under it, a line of the accent
   on top (VS Code's and a browser's tabs). */
.view-tab.active {
  color: var(--text-strong);
  background: var(--surface);
}
.view-tab.active::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 2px;
  background: var(--accent);
}
.view-tab:focus-visible {
  box-shadow: inset 0 0 0 1px var(--accent);
}
.view-tab-icon {
  flex: 0 0 auto;
}
.view-tab.active .view-tab-icon {
  color: var(--accent);
}
.view-tab-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.view-tab-close {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  visibility: hidden;
}
.view-tab:hover .view-tab-close,
.view-tab.active .view-tab-close {
  visibility: visible;
}
.view-tab-close:hover {
  background: var(--surface-3);
  color: var(--text);
}
</style>
