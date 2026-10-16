<script setup>
// One row of a Settings list (settingsList.css): the row is a button that
// opens the item's details under it. Put it in a <ul class="sl-list">.
//   <SettingsListItem :open="openId === s.id" :name="s.name" :desc="s.desc" @toggle="toggle(s.id)">
//     <template #icon><BrandIcon :kind="s.agent" :size="20" /></template>
//     <template #tags><span class="tag tag-ok">{{ t('…', 'Running') }}</span></template>
//     <template #meta><span class="tag tag-scope">{{ s.scope }}</span></template>
//     …the details (shown while open)…
//   </SettingsListItem>
// Attributes (data-*, @keydown) go on the <li>; `row` (exposed) is the row
// button, for a list that moves the focus with the arrow keys.
import { ref, useId } from 'vue'

defineProps({
  open: { type: Boolean, default: false },
  name: { type: String, default: '' },
  // The one-line description under the name (the #desc slot replaces it).
  desc: { type: String, default: '' }
})
const emit = defineEmits(['toggle'])

const id = useId()
const row = ref(null)
defineExpose({ row })
</script>

<template>
  <li class="sl-item" :class="{ open }">
    <button
      :id="`${id}-row`"
      ref="row"
      type="button"
      class="sl-row"
      :aria-expanded="open"
      :aria-controls="`${id}-details`"
      @click="emit('toggle')"
    >
      <span v-if="$slots.icon" class="sl-row-icon"><slot name="icon" /></span>
      <span class="sl-row-main">
        <span class="sl-row-top">
          <span class="sl-row-name"><slot name="name">{{ name }}</slot></span>
          <slot name="tags" />
        </span>
        <span v-if="$slots.desc || desc" class="sl-row-desc" :title="desc || undefined"><slot name="desc">{{ desc }}</slot></span>
      </span>
      <span v-if="$slots.meta" class="sl-row-meta"><slot name="meta" /></span>
      <svg class="sl-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <div v-if="open" :id="`${id}-details`" class="sl-details" role="region" :aria-labelledby="`${id}-row`">
      <slot />
    </div>
  </li>
</template>
