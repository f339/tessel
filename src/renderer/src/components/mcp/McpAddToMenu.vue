<script setup>
// "Add to…": one menu for the agents installed here that do not have the
// server yet (instead of one "Add to <agent>" button per agent). Arrow keys
// move through it, Escape closes it.
import { ref, nextTick, onBeforeUnmount } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import BrandIcon from '../BrandIcon.vue'
import { t } from '../../i18n'
import { AGENT_NAME } from './mcpShared'

const props = defineProps({
  agents: { type: Array, default: () => [] }, // the agents it can be added to
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['pick'])

const open = ref(false)
const root = ref(null)
const button = ref(null)
const items = ref([])

function onOutside(e) {
  if (root.value && !root.value.contains(e.target)) close(false)
}
async function show() {
  if (!props.agents.length || props.disabled) return
  open.value = true
  document.addEventListener('pointerdown', onOutside, true)
  await nextTick()
  items.value[0]?.focus()
}
function close(refocus = true) {
  open.value = false
  document.removeEventListener('pointerdown', onOutside, true)
  if (refocus) button.value?.focus()
}
function toggle() {
  if (open.value) close()
  else show()
}
function pick(agent) {
  close()
  emit('pick', agent)
}
function onKey(e) {
  const list = items.value.filter(Boolean)
  const i = list.indexOf(document.activeElement)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const step = e.key === 'ArrowDown' ? 1 : -1
    list[(i + step + list.length) % list.length]?.focus()
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault()
    list[e.key === 'Home' ? 0 : list.length - 1]?.focus()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    close()
  } else if (e.key === 'Tab') {
    close(false)
  }
}
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside, true))
</script>

<template>
  <span ref="root" class="mcp-addto">
    <button
      ref="button"
      type="button"
      class="exit-btn small"
      aria-haspopup="menu"
      :aria-expanded="open ? 'true' : 'false'"
      :disabled="disabled || !agents.length"
      :title="agents.length ? '' : t('mcp.installed.everyAgent', 'Every agent installed here has it')"
      @click="toggle"
      @keydown.down.prevent="show"
    >
      {{ t('mcp.installed.addToMenu', 'Add to…') }}
      <ChevronDown :size="12" aria-hidden="true" />
    </button>
    <ul v-if="open" class="mcp-addto-menu" role="menu" @keydown="onKey">
      <li v-for="(a, i) in agents" :key="a" role="none">
        <button :ref="(el) => (items[i] = el)" type="button" role="menuitem" class="mcp-addto-item" @click="pick(a)">
          <BrandIcon :kind="a" :size="14" />{{ AGENT_NAME[a] }}
        </button>
      </li>
    </ul>
  </span>
</template>

<style scoped>
.mcp-addto {
  position: relative;
  display: inline-flex;
}
.mcp-addto-menu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  right: 0;
  min-width: 180px;
  margin: 0;
  padding: 4px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface-2);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  /* It opens from a section heading: none of its uppercase. */
  font-weight: 400;
  letter-spacing: 0;
  list-style: none;
  text-transform: none;
}
.mcp-addto-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.mcp-addto-item:hover,
.mcp-addto-item:focus-visible {
  background: var(--surface-3);
  outline: none;
  color: var(--text-strong);
}
</style>
