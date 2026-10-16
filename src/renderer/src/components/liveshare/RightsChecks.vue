<script setup>
// Live Share: a person's, an invitation's or an accept prompt's rights, as
// checkboxes in the catalog's order (liveShareRights.js shownRights: a right
// without words is never shown). Each box shows what the subject has now;
// a click asks for the change (toggle) and the box follows `rights` when it
// comes back (main's answer, or the form's own copy).
import { computed } from 'vue'
import { shownRights } from '../../liveShareRights'
import { t } from '../../i18n'

const props = defineProps({
  rights: { type: Object, default: () => ({}) },
  disabled: { type: Boolean, default: false },
  // One line of short labels (the full words in each box's tooltip).
  compact: { type: Boolean, default: false },
  // Shown with each box (the full form only).
  hints: { type: Boolean, default: true },
  label: { type: String, default: '' },
  // For data-test: ls-right-<id>-<testKey>.
  testKey: { type: String, default: '' },
  // A change on its way for this right: its box waits.
  busy: { type: Function, default: null }
})
// toggle(id, on)
const emit = defineEmits(['toggle'])

const rows = computed(() => shownRights())
const on = (id) => !!(props.rights && props.rights[id] === true)
function change(id, event) {
  const box = event.target
  const want = !!box.checked
  box.checked = on(id)
  emit('toggle', id, want)
}
const groupLabel = computed(() => props.label || t('liveShare.right.groupLabel', 'What they can do'))
</script>

<template>
  <div class="lsr" :class="{ compact }" role="group" :aria-label="groupLabel">
    <label v-for="r in rows" :key="r.id" class="lsr-item" :title="compact ? r.label : r.hint" :data-test="'ls-right-' + r.id + (testKey ? '-' + testKey : '')">
      <input type="checkbox" :checked="on(r.id)" :disabled="disabled || !!(busy && busy(r.id))" :aria-label="compact ? r.label : undefined" @change="change(r.id, $event)" />
      <span class="lsr-text">
        <span class="lsr-label">{{ compact ? r.short : r.label }}</span>
        <span v-if="!compact && hints" class="lsr-hint">{{ r.hint }}</span>
      </span>
    </label>
  </div>
</template>

<style scoped>
.lsr {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.lsr.compact {
  flex-direction: row;
  flex-wrap: wrap;
  gap: 4px 12px;
}
.lsr-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  padding: 2px 0;
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.35;
  cursor: pointer;
}
.compact .lsr-item {
  align-items: center;
  font-size: 12px;
}
.lsr-item input {
  flex: none;
  margin: 2px 0 0;
  accent-color: var(--accent);
}
.compact .lsr-item input {
  margin: 0;
}
.lsr-item input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.lsr-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.lsr-label {
  overflow-wrap: anywhere;
}
.lsr-hint {
  color: var(--text-dim);
  font-size: 11.5px;
  overflow-wrap: anywhere;
}
</style>
