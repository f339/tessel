<script setup>
// A Settings page's "Windows and tools" group: one row per window, panel or
// tool of that page (settingsTools.js), with an Open… or Show button that
// closes Settings and opens it (App.vue runs the action). `ids` keeps some
// of the page's rows (another group, under its own `title`, shows the rest:
// General's Troubleshooting); the default slot adds rows after them.
import { computed } from 'vue'
import { t } from '../i18n'
import { SETTINGS_TOOLS } from '../settingsTools'

const props = defineProps({
  page: { type: String, required: true },
  ids: { type: Array, default: null },
  title: { type: String, default: '' }
})
const emit = defineEmits(['open'])
const rows = computed(() => (SETTINGS_TOOLS[props.page] || []).filter((r) => !props.ids || props.ids.includes(r.id)))
</script>

<template>
  <div v-if="rows.length || $slots.default" class="set-group" :data-tools="page">
    <h3 class="set-group-title">{{ title || t('settings.tools.title', 'Windows and tools') }}</h3>
    <div class="set-card">
      <div v-for="r in rows" :key="r.id" class="set-row">
        <div class="set-label">
          {{ r.title }}
          <span class="set-hint">{{ r.hint }}</span>
        </div>
        <button type="button" class="exit-btn" :data-open-tool="r.id" @click="emit('open', r.id)">{{ r.button }}</button>
      </div>
      <slot />
    </div>
  </div>
</template>
