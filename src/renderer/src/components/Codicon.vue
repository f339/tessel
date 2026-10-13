<script>
// VS Code's own icons (codicons) for the buttons that copy VS Code's: the
// codicon font (assets/codicon.ttf, the one VS Code and Monaco draw them
// with; CC BY 4.0, Microsoft), loaded the first time an icon shows. Code
// points from VS Code's codiconsLibrary.ts.
import codiconUrl from '../assets/codicon.ttf?url'

export const CODICONS = {
  'new-file': 0xea7f,
  'new-folder': 0xea80,
  refresh: 0xeb37,
  'collapse-all': 0xeac5,
  'save-all': 0xeb49,
  'close-all': 0xeac1,
  close: 0xea76,
  'circle-filled': 0xea71,
  globe: 0xeb01,
  search: 0xea6d
}

let fontAsked = false
function loadFont() {
  if (fontAsked || typeof FontFace !== 'function' || typeof document === 'undefined' || !document.fonts) return
  fontAsked = true
  new FontFace('tessel-codicon', `url(${codiconUrl})`)
    .load()
    .then((face) => document.fonts.add(face))
    .catch(() => {
      fontAsked = false
    })
}
</script>

<script setup>
// No "codicon-<name>" class: Monaco's stylesheet draws the icon again in a
// ::before of any element with one (every icon showed twice).
import { computed } from 'vue'

const props = defineProps({
  name: { type: String, required: true },
  size: { type: Number, default: 16 }
})
loadFont()
const glyph = computed(() => (CODICONS[props.name] ? String.fromCodePoint(CODICONS[props.name]) : ''))
</script>

<template>
  <span class="tessel-icon-glyph" :data-icon="name" :style="{ fontSize: size + 'px' }" aria-hidden="true">{{ glyph }}</span>
</template>

<style>
.tessel-icon-glyph {
  display: inline-block;
  width: 1em;
  height: 1em;
  font-family: 'tessel-codicon';
  font-style: normal;
  font-weight: normal;
  line-height: 1;
  text-align: center;
  -webkit-font-smoothing: antialiased;
  user-select: none;
}
</style>
