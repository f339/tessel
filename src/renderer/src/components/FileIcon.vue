<script setup>
// A file's icon as VS Code draws it (fileIcons/fileIcons.js): coloured by the
// file's type, or in the text's colour, or none (Settings > Appearance >
// File icons). A folder has none, as in VS Code.
import { computed } from 'vue'
import { settings } from '../settings'
import { terminalTheme } from '../themes'
import { fileIcon } from '../fileIcons/fileIcons'

const props = defineProps({
  // A file name or a path (its last part is used).
  name: { type: String, default: '' },
  dir: { type: Boolean, default: false }
})

function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
  if (!m) return false
  const n = parseInt(m[1], 16)
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) >= 128
}
const style = computed(() => (settings.fileIcons === 'mono' || settings.fileIcons === 'off' ? settings.fileIcons : 'color'))
const icon = computed(() => (style.value === 'off' ? null : fileIcon(props.name, { dir: props.dir, light: isLight(terminalTheme(settings.theme).background) })))
</script>

<template>
  <span
    v-if="icon"
    class="file-icon"
    :class="{ mono: style === 'mono' }"
    :style="style === 'color' && icon.color ? { color: icon.color } : null"
    aria-hidden="true"
    data-test="file-icon"
    >{{ icon.glyph }}</span
  >
</template>
