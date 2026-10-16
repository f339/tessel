<script setup>
// Live Share: who is there, as initials in small circles (the first `max`,
// then +N), every name in the tooltip. Each person keeps one colour (from
// its id). Muted: nobody connected (a grey dot says it).
import { computed } from 'vue'
import { initials } from '../../liveShareAccess'
import { t } from '../../i18n'

const props = defineProps({
  // [{ id, name }]
  people: { type: Array, default: () => [] },
  max: { type: Number, default: 3 },
  size: { type: Number, default: 16 },
  // The words before the names in the tooltip.
  lead: { type: String, default: '' }
})

const COLORS = ['#e5484d', '#6c9cff', '#30a46c', '#f5a524', '#a970ff', '#12a594']
function colorOf(id) {
  let h = 0
  for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}
const shown = computed(() => props.people.slice(0, props.max).map((p) => ({ id: p.id, text: initials(p.name), color: colorOf(p.id) })))
const more = computed(() => Math.max(0, props.people.length - props.max))
const names = computed(() => props.people.map((p) => p.name || t('liveShare.guest', 'A guest')).join(', '))
const title = computed(() => (props.lead ? `${props.lead} ${names.value}` : names.value))
</script>

<template>
  <span v-if="people.length" class="lsa" :title="title" :aria-label="title" role="img" data-test="ls-avatars" :style="{ '--lsa-size': size + 'px' }">
    <span v-for="p in shown" :key="p.id" class="lsa-dot" :style="{ background: p.color }" aria-hidden="true">{{ p.text }}</span>
    <span v-if="more" class="lsa-dot lsa-more" aria-hidden="true">+{{ more }}</span>
  </span>
</template>

<style scoped>
.lsa {
  display: inline-flex;
  flex: none;
  align-items: center;
}
.lsa-dot {
  display: inline-grid;
  place-items: center;
  min-width: var(--lsa-size);
  height: var(--lsa-size);
  margin-left: -4px;
  padding: 0 2px;
  border: 1.5px solid var(--surface);
  border-radius: calc(var(--lsa-size) / 2);
  color: #fff;
  font-size: calc(var(--lsa-size) * 0.5);
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0;
  box-sizing: border-box;
}
.lsa-dot:first-child {
  margin-left: 0;
}
.lsa-more {
  background: var(--surface-3);
  color: var(--text);
}
</style>
