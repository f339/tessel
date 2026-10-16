<script setup>
// Settings > Text: the terminals' font, size and cursor.
import { computed } from 'vue'
import ThemedSelect from '../ui/ThemedSelect.vue'
import { t } from '../../i18n'
import { settings, FONT_FAMILIES, clamp } from '../../settings'
import { PAGES } from './settingsPages'
import { setNumber } from './settingsFields'
import { useSettingsShell } from './settingsShell'

const { shown } = useSettingsShell()

function stepFont(d) {
  settings.fontSize = clamp(settings.fontSize + d, 8, 28)
}

const CURSORS = computed(() => [
  { id: 'block', label: t('settings.text.cursorBlock', 'Block') },
  { id: 'bar', label: t('settings.text.cursorBar', 'Bar') },
  { id: 'underline', label: t('settings.text.cursorUnderline', 'Underline') }
])
</script>

<template>
  <section
    id="set-text"
    class="set-page"
    data-page="text"
    :hidden="!shown('text')"
    aria-labelledby="set-text-title"
  >
    <header class="set-page-head">
      <h2 id="set-text-title">{{ PAGES.text.title }}</h2>
      <p class="set-page-desc">{{ PAGES.text.desc }}</p>
    </header>
    <div class="set-group">
      <div class="set-card">
        <div class="set-row">
          <label class="set-label" for="settings-font">
            {{ t('settings.text.font', 'Font') }}
            <span class="set-hint">{{ t('settings.text.fontHint', 'The typeface of every terminal') }}</span>
          </label>
          <ThemedSelect id="settings-font" v-model="settings.fontFamily" class="set-select">
            <option v-for="f in FONT_FAMILIES" :key="f" :value="f">{{ f }}</option>
          </ThemedSelect>
        </div>
        <div class="set-row">
          <div class="set-label">
            {{ t('settings.text.size', 'Size') }}
            <span class="set-hint">{{ t('settings.text.sizeHint', 'Also Ctrl+= and Ctrl+-') }}</span>
          </div>
          <div class="set-stepper">
            <button :title="t('settings.text.smaller', 'Smaller')" @click="stepFont(-1)">−</button>
            <span>{{ settings.fontSize }}</span>
            <button :title="t('settings.text.bigger', 'Bigger')" @click="stepFont(1)">+</button>
          </div>
        </div>
        <div class="set-row">
          <div id="settings-cursor-label" class="set-label">{{ t('settings.text.cursor', 'Cursor') }}</div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-cursor-label">
            <button
              v-for="c in CURSORS"
              :key="c.id"
              class="launch-seg-btn"
              :class="{ on: settings.cursorStyle === c.id }"
              :aria-pressed="settings.cursorStyle === c.id"
              @click="settings.cursorStyle = c.id"
            >
              {{ c.label }}
            </button>
          </div>
        </div>
        <label class="set-row">
          <div class="set-label">{{ t('settings.text.blink', 'Blinking cursor') }}</div>
          <input v-model="settings.cursorBlink" type="checkbox" class="set-switch" />
        </label>
        <div class="set-row">
          <label class="set-label" for="settings-cursor-opacity">
            {{ t('settings.text.cursorOpacity', 'Cursor opacity') }}
            <span class="set-hint">{{ t('settings.text.cursorOpacityHint', 'Opacity of the terminal cursor. 0-1') }}</span>
          </label>
          <input
            id="settings-cursor-opacity"
            class="set-number"
            type="number"
            min="0"
            max="1"
            step="0.05"
            :value="settings.cursorOpacity"
            @change="setNumber('cursorOpacity', $event)"
          />
        </div>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.text.typography', 'Terminal typography') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <label class="set-label" for="settings-font-weight">
            {{ t('settings.text.fontWeight', 'Font weight') }}
            <span class="set-hint">{{ t('settings.text.fontWeightHint', 'Controls the terminal text font weight. 100-900') }}</span>
          </label>
          <input
            id="settings-font-weight"
            class="set-number"
            type="number"
            min="100"
            max="900"
            step="100"
            :value="settings.fontWeight"
            @change="setNumber('fontWeight', $event, true)"
          />
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-font-weight-bold">
            {{ t('settings.text.boldWeight', 'Bold font weight') }}
            <span class="set-hint">{{ t('settings.text.boldWeightHint', 'Adjust independently from the font weight. Some fonts map several values to one face, so lower the font weight or choose another font if bold looks unchanged. 100-900') }}</span>
          </label>
          <input
            id="settings-font-weight-bold"
            class="set-number"
            type="number"
            min="100"
            max="900"
            step="100"
            :value="settings.fontWeightBold"
            @change="setNumber('fontWeightBold', $event, true)"
          />
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-line-height">
            {{ t('settings.text.lineHeight', 'Line height') }}
            <span class="set-hint">{{ t('settings.text.lineHeightHint', 'Controls the terminal line height multiplier. 1-3') }}</span>
          </label>
          <input
            id="settings-line-height"
            class="set-number"
            type="number"
            min="1"
            max="3"
            step="0.1"
            :value="settings.lineHeight"
            @change="setNumber('lineHeight', $event)"
          />
        </div>
      </div>
    </div>
  </section>
</template>
