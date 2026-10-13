<script setup>
// VS Code's breadcrumbs under the editor's tabs: the file's folders (from
// the project), the file with its icon, then the symbols around the cursor
// with their icons. A symbol is shown when clicked.
import { computed } from 'vue'
import FileIcon from './FileIcon.vue'
import Codicon from './Codicon.vue'
import { symbolIcon } from '../editor/symbolKinds'

const props = defineProps({
  path: { type: String, default: '' },
  // The project folder: the folders shown start under it.
  root: { type: String, default: '' },
  // The symbols around the cursor, outermost first: [{ name, kind, selectionRange }]
  symbols: { type: Array, default: () => [] }
})
const emit = defineEmits(['reveal'])

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\/+$/, '')
const parts = computed(() => {
  const p = norm(props.path)
  const r = norm(props.root)
  const rel = r && p.toLowerCase().startsWith(r.toLowerCase() + '/') ? p.slice(r.length + 1) : p.replace(/^\/+/, '')
  return rel.split('/').filter(Boolean)
})
const folders = computed(() => parts.value.slice(0, -1))
const fileName = computed(() => parts.value[parts.value.length - 1] || '')
</script>

<template>
  <nav class="ed-crumbs" :aria-label="path" data-test="editor-breadcrumbs">
    <template v-for="(f, i) in folders" :key="'d' + i">
      <span class="ed-crumb"><span class="ed-crumb-label">{{ f }}</span></span>
      <Codicon class="ed-crumb-sep" name="chevron-right" />
    </template>
    <span v-if="fileName" class="ed-crumb ed-crumb-file"><FileIcon class="ed-crumb-icon" :name="fileName" /><span class="ed-crumb-label">{{ fileName }}</span></span>
    <template v-for="(s, i) in symbols" :key="'s' + i">
      <Codicon class="ed-crumb-sep" name="chevron-right" />
      <span class="ed-crumb ed-crumb-symbol" data-test="crumb-symbol" @click="emit('reveal', s)">
        <Codicon class="ed-crumb-icon" :name="symbolIcon(s.kind).name" :style="symbolIcon(s.kind).color ? { color: symbolIcon(s.kind).color } : null" /><span class="ed-crumb-label">{{ s.name }}</span>
      </span>
    </template>
  </nav>
</template>
