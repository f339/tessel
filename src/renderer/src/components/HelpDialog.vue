<script setup>
// Keyboard shortcuts and help (F1, the command palette's "Keyboard shortcuts
// and help"). The shortcuts by group, in the interface's language: each key
// of a chord in its own key cap (Ctrl, Shift, T), key names translated
// (French: Maj, Échap, Pg préc), and the alternatives of one row (F7 or
// Shift+F7) told apart by "or", never drawn as a key. A search box filters
// the rows by what they do or by their keys; the groups flow in columns so a
// short group leaves no hole beside a long one. The keyboard goes to the
// search box; Escape clears a search, then closes.
import { ref, computed, onMounted } from 'vue'
import { X, Search } from 'lucide-vue-next'
import { t } from '../i18n'
import { shortcutGroups, filterShortcuts } from '../helpShortcuts'

const emit = defineEmits(['close'])

const groups = computed(() => shortcutGroups())
const query = ref('')
const shown = computed(() => filterShortcuts(groups.value, query.value))

const searchEl = ref(null)
onMounted(() => searchEl.value?.focus())
function onEscape() {
  if (query.value) query.value = ''
  else emit('close')
}
</script>

<template>
  <div class="help-backdrop" @pointerdown.self="emit('close')">
    <div class="help-card hd-card" role="dialog" :aria-label="t('app.help.title', 'Keyboard shortcuts')" tabindex="-1" data-test="help-dialog" @keydown.escape.prevent.stop="onEscape">
      <div class="help-head">
        <span>{{ t('app.help.title', 'Keyboard shortcuts') }}</span>
        <button class="tb-icon" :title="t('app.help.close', 'Close (Esc)')" :aria-label="t('app.help.close', 'Close (Esc)')" @click="emit('close')">
          <X :size="14" aria-hidden="true" />
        </button>
      </div>
      <label class="hd-search">
        <Search :size="13" class="hd-search-icon" aria-hidden="true" />
        <input ref="searchEl" v-model="query" type="search" spellcheck="false" :placeholder="t('app.help.search', 'Search shortcuts')" :aria-label="t('app.help.search', 'Search shortcuts')" data-test="help-search" />
      </label>
      <p v-if="!shown.length" class="hd-none" data-test="help-none">{{ t('app.help.noMatch', 'No shortcut matches.') }}</p>
      <div v-else class="hd-columns">
        <section v-for="group in shown" :key="group.title" class="hd-group" :data-test="'help-group'">
          <h3>{{ group.title }}</h3>
          <div v-for="row in group.rows" :key="row.keys + row.text" class="help-row" data-test="help-row">
            <span>{{ row.text }}</span>
            <span class="hd-keys">
              <template v-for="(chord, ci) in row.chords" :key="ci">
                <span v-if="ci" class="hd-or">{{ t('app.help.or', 'or') }}</span>
                <span class="hd-chord">
                  <template v-for="(key, ki) in chord" :key="ki">
                    <span v-if="ki" class="hd-plus" aria-hidden="true">+</span>
                    <kbd>{{ key }}</kbd>
                  </template>
                </span>
              </template>
            </span>
          </div>
        </section>
      </div>
      <p class="help-foot">
        {{ t('app.help.foot', 'Drop files on a pane to paste their paths. Select text to copy it, right-click to paste. Shift+right-click a pane for more.') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.hd-search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface-2);
}
.hd-search:focus-within {
  border-color: var(--accent);
}
.hd-search-icon {
  flex: none;
  color: var(--text-dim);
}
.hd-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
}
.hd-none {
  margin: 18px 0 4px;
  color: var(--text-dim);
  font-size: 12.5px;
  text-align: center;
}
/* Groups flow in columns (no hole beside a short group); one column when
   the dialog is narrow. */
.hd-columns {
  margin-top: 14px;
  column-width: 300px;
  column-gap: 28px;
}
/* Spacing as padding, not margins: a column's top truncates margins, and the
   two columns' first titles must line up. */
.hd-group {
  break-inside: avoid;
  padding-bottom: 14px;
}
.hd-group h3 {
  margin: 0 0 6px;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.hd-keys {
  display: inline-flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}
.hd-chord {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
}
.hd-chord kbd {
  margin: 0;
}
.hd-plus,
.hd-or {
  color: var(--text-dim);
  font-size: 10.5px;
}
</style>
