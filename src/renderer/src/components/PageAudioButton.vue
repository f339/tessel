<script setup>
// A browser page's speaker (its tab above the panes, its pane's header, its
// tab in the side panel): shown while the page makes sound, and all the time
// it is muted (to give it its sound back). A click mutes or unmutes it, as in
// a browser; BrowserPane applies leaf.muted to the page.
import { Volume2, VolumeX } from 'lucide-vue-next'
import { t } from '../i18n'

const props = defineProps({
  // A browser leaf (or a side panel page): audible, muted.
  leaf: { type: Object, required: true },
  size: { type: Number, default: 13 }
})

function toggle() {
  props.leaf.muted = !props.leaf.muted
}
</script>

<template>
  <button
    v-if="leaf.audible || leaf.muted"
    type="button"
    class="page-audio"
    :class="{ muted: !!leaf.muted }"
    tabindex="-1"
    data-test="page-audio"
    :aria-pressed="!!leaf.muted"
    :title="leaf.muted ? t('browser.audio.muted', 'Muted: click to unmute') : t('browser.audio.playing', 'This page is playing sound: click to mute it')"
    :aria-label="leaf.muted ? t('browser.audio.unmute', 'Unmute this page') : t('browser.audio.mute', 'Mute this page')"
    @pointerdown.stop
    @mousedown.stop.prevent
    @dblclick.stop
    @click.stop="toggle"
  >
    <VolumeX v-if="leaf.muted" :size="size" aria-hidden="true" />
    <Volume2 v-else :size="size" aria-hidden="true" />
  </button>
</template>

<style scoped>
.page-audio {
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
}
.page-audio:hover {
  background: var(--surface-3);
  color: var(--text);
}
</style>
