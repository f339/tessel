<script setup>
// Settings > Terminal: shell, scrollback, drawing, copy and paste.
import { computed } from 'vue'
import ThemedSelect from '../ui/ThemedSelect.vue'
import { t } from '../../i18n'
import BrandIcon from '../BrandIcon.vue'
import SettingsToolRows from '../SettingsToolRows.vue'
import { settings, clamp, DEFAULT_SETTINGS } from '../../settings'
import { LIGHT_BG_MIN_CONTRAST, DEFAULT_WORD_SEPARATOR } from '../../terminalOptions'
import { PAGES } from './settingsPages'
import { setNumber, setRange } from './settingsFields'
import { useSettingsShell } from './settingsShell'

defineProps({
  shells: { type: Array, default: () => [] },
  defaultShell: { type: String, default: null }
})
const { shown, emit } = useSettingsShell()

function setScrollback(e) {
  const n = parseInt(e.target.value, 10)
  if (Number.isFinite(n)) settings.scrollback = clamp(n, 500, 100000)
  e.target.value = settings.scrollback
}
const GPU_MODES = computed(() => [
  { id: 'auto', label: t('settings.terminal.gpuAuto', 'Auto') },
  { id: 'on', label: t('settings.common.on', 'On') },
  { id: 'off', label: t('settings.common.off', 'Off') }
])
const gpuHint = computed(() =>
  settings.gpuAcceleration === 'off'
    ? t('settings.terminal.gpuOffHint', 'WebGL disabled; DOM renderer for max compatibility.')
    : settings.gpuAcceleration === 'on'
      ? t('settings.terminal.gpuOnHint', 'WebGL is always attempted for terminal panes.')
      : t('settings.terminal.gpuAutoHint', 'Auto tries WebGL, with DOM fallback for unsupported or risky renderers.')
)

// Color Contrast (Orca's): Automatic (null), Off (1) or a custom ratio.
const CONTRAST_MODES = computed(() => [
  { id: 'auto', label: t('settings.terminal.contrastAuto', 'Automatic') },
  { id: 'off', label: t('settings.common.off', 'Off') },
  { id: 'custom', label: t('settings.terminal.contrastCustom', 'Custom') }
])
const contrastMode = computed(() =>
  settings.minimumContrastRatio === null ? 'auto' : settings.minimumContrastRatio === 1 ? 'off' : 'custom'
)
let lastCustomContrast = LIGHT_BG_MIN_CONTRAST
function setContrastMode(mode) {
  if (contrastMode.value === 'custom') lastCustomContrast = settings.minimumContrastRatio
  settings.minimumContrastRatio = mode === 'auto' ? null : mode === 'off' ? 1 : lastCustomContrast
}
const contrastHint = computed(() =>
  contrastMode.value === 'auto'
    ? t('settings.terminal.contrastAutoHint', 'Balances readability with your terminal theme. Recommended.')
    : contrastMode.value === 'off'
      ? t('settings.terminal.contrastOffHint', 'Keeps program colors unchanged, including dim text and Powerline separators.')
      : t('settings.terminal.contrastCustomHint', 'Choose how much to increase contrast between text and its background.')
)

function resetScrollSpeed() {
  settings.scrollSensitivity = DEFAULT_SETTINGS.scrollSensitivity
  settings.fastScrollSensitivity = DEFAULT_SETTINGS.fastScrollSensitivity
}
</script>

<template>
  <section
    id="set-terminal"
    class="set-page"
    data-page="terminal"
    :hidden="!shown('terminal')"
    aria-labelledby="set-terminal-title"
  >
    <header class="set-page-head">
      <h2 id="set-terminal-title">{{ PAGES.terminal.title }}</h2>
      <p class="set-page-desc">{{ PAGES.terminal.desc }}</p>
    </header>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.terminal.shell', 'Shell') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <label class="set-label" for="settings-shell">
            {{ t('settings.terminal.defaultShell', 'Default shell') }} <span class="set-hint">{{ t('settings.terminal.defaultShellHint', 'Agents run in it too') }}</span>
          </label>
          <div class="set-shell">
            <BrandIcon :kind="defaultShell || ''" :size="15" />
            <ThemedSelect
              id="settings-shell"
              class="set-select"
              :value="defaultShell"
              @change="emit('set-default-shell', $event.target.value)"
            >
              <option v-for="s in shells" :key="s.id" :value="s.id">{{ s.name }}</option>
            </ThemedSelect>
          </div>
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-scrollback">
            {{ t('settings.terminal.scrollback', 'Scrollback lines') }} <span class="set-hint">{{ t('settings.terminal.scrollbackHint', 'Applies to new panes') }}</span>
          </label>
          <input
            id="settings-scrollback"
            class="set-number"
            type="number"
            min="500"
            max="100000"
            step="500"
            :value="settings.scrollback"
            @change="setScrollback"
          />
        </div>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.terminal.rendering', 'Rendering') }}</h3>
      <div class="set-card">
        <p class="set-hint set-card-text">{{ t('settings.terminal.renderingIntro', 'Terminal renderer behavior for live panes and new panes.') }}</p>
        <div class="set-row">
          <div id="settings-gpu-label" class="set-label">
            {{ t('settings.terminal.gpu', 'GPU acceleration') }}
            <span class="set-hint">{{ gpuHint }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-gpu-label">
            <button
              v-for="m in GPU_MODES"
              :key="m.id"
              type="button"
              class="launch-seg-btn"
              :class="{ on: settings.gpuAcceleration === m.id }"
              :aria-pressed="settings.gpuAcceleration === m.id"
              @click="settings.gpuAcceleration = m.id"
            >
              {{ m.label }}
            </button>
          </div>
        </div>
        <div class="set-row">
          <div id="settings-contrast-label" class="set-label">
            {{ t('settings.terminal.contrast', 'Color contrast') }}
            <span class="set-hint">{{ contrastHint }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-contrast-label">
            <button
              v-for="m in CONTRAST_MODES"
              :key="m.id"
              type="button"
              class="launch-seg-btn"
              :class="{ on: contrastMode === m.id }"
              :aria-pressed="contrastMode === m.id"
              @click="setContrastMode(m.id)"
            >
              {{ m.label }}
            </button>
          </div>
        </div>
        <div v-if="contrastMode === 'custom'" class="set-row">
          <label class="set-label" for="settings-contrast-ratio">
            {{ t('settings.terminal.contrastTarget', 'Contrast target') }}
            <span class="set-hint">{{ t('settings.terminal.contrastTargetHint', 'Higher values increase contrast where possible. Background colors stay unchanged.') }}</span>
          </label>
          <div class="set-inline">
            <input
              class="set-range"
              type="range"
              min="1.1"
              max="21"
              step="0.1"
              :aria-label="t('settings.terminal.contrastTarget', 'Contrast target')"
              :value="settings.minimumContrastRatio"
              @input="setRange('minimumContrastRatio', $event)"
            />
            <input
              id="settings-contrast-ratio"
              class="set-number set-number-short"
              type="number"
              min="1"
              max="21"
              step="0.1"
              :value="settings.minimumContrastRatio"
              @change="setNumber('minimumContrastRatio', $event)"
            />
          </div>
        </div>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.terminal.copyPaste', 'Copy and paste') }}</h3>
      <div class="set-card">
        <label class="set-row">
          <div class="set-label">{{ t('settings.terminal.copyOnSelect', 'Copy text when you select it') }}</div>
          <input v-model="settings.copyOnSelect" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.terminal.rightClickPaste', 'Right-click pastes') }}
            <span class="set-hint">{{ t('settings.terminal.rightClickPasteHint', 'Pastes the selection, or the clipboard. Shift+right-click opens the menu') }}</span>
          </div>
          <input v-model="settings.rightClickPaste" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.terminal.confirmMultiline', 'Ask before pasting several lines') }}
            <span class="set-hint">{{ t('settings.terminal.confirmMultilineHint', 'So an accidental paste can\'t run commands') }}</span>
          </div>
          <input v-model="settings.confirmMultilinePaste" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.terminal.alwaysSelect', 'Always select with the mouse') }}
            <span class="set-hint">{{ t('settings.terminal.alwaysSelectHint', 'Even in programs that use the mouse (GitHub Copilot, htop). They no longer get clicks or the wheel. Otherwise, hold Shift to select') }}</span>
          </div>
          <input v-model="settings.alwaysSelect" type="checkbox" class="set-switch" />
        </label>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.terminal.interaction', 'Terminal interaction') }}</h3>
      <div class="set-card">
        <p class="set-hint set-card-text">{{ t('settings.terminal.interactionIntro', 'Mouse and clipboard behavior for terminal panes.') }}</p>
        <div class="set-row">
          <div class="set-label">
            {{ t('settings.terminal.scrollSpeed', 'Scroll speed') }}
            <span class="set-hint">{{ t('settings.terminal.scrollSpeedHint', 'Adjust how wheel input feels in scrollback and in mouse-aware terminal apps.') }}</span>
          </div>
          <button class="exit-btn" type="button" @click="resetScrollSpeed">{{ t('settings.common.reset', 'Reset') }}</button>
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-scroll-normal">
            {{ t('settings.terminal.scrollNormal', 'Normal') }}
            <span class="set-hint">{{ t('settings.terminal.scrollNormalHint', 'Scrollback wheel multiplier.') }}</span>
          </label>
          <div class="set-inline">
            <input
              class="set-range"
              type="range"
              min="0.5"
              max="3"
              step="0.05"
              :aria-label="t('settings.terminal.scrollNormalLabel', 'Normal scroll speed')"
              :value="settings.scrollSensitivity"
              @input="setRange('scrollSensitivity', $event)"
            />
            <input
              id="settings-scroll-normal"
              class="set-number set-number-short"
              type="number"
              min="0.5"
              max="3"
              step="0.05"
              :value="settings.scrollSensitivity"
              @change="setNumber('scrollSensitivity', $event)"
            />
          </div>
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-scroll-fast">
            {{ t('settings.terminal.scrollFast', 'Fast') }}
            <span class="set-hint">{{ t('settings.terminal.scrollFastHint', 'Extra multiplier while scrolling with a modifier key.') }}</span>
          </label>
          <div class="set-inline">
            <input
              class="set-range"
              type="range"
              min="1"
              max="10"
              step="0.5"
              :aria-label="t('settings.terminal.scrollFastLabel', 'Fast scroll speed')"
              :value="settings.fastScrollSensitivity"
              @input="setRange('fastScrollSensitivity', $event)"
            />
            <input
              id="settings-scroll-fast"
              class="set-number set-number-short"
              type="number"
              min="1"
              max="10"
              step="0.5"
              :value="settings.fastScrollSensitivity"
              @change="setNumber('fastScrollSensitivity', $event)"
            />
          </div>
        </div>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.terminal.focusFollowsMouse', 'Focus follows mouse') }}
            <span class="set-hint">{{ t('settings.terminal.focusFollowsMouseHint', 'Hovering a terminal pane activates it without needing to click.') }}</span>
          </div>
          <input v-model="settings.focusFollowsMouse" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.terminal.trimGutter', 'Trim gutter on copy') }}
            <span class="set-hint">{{ t('settings.terminal.trimGutterHint', 'Drop the left gutter agent output is painted behind, so copied text is not indented. Only the indent every selected line shares is removed.') }}</span>
          </div>
          <input v-model="settings.copyTrimsGutter" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.terminal.osc52', 'Allow TUI clipboard writes (OSC 52)') }}
            <span class="set-hint">{{ t('settings.terminal.osc52Hint', 'Let programs in the terminal (Zellij, tmux, Neovim, fzf, Grok, SSH) copy to your system clipboard.') }}</span>
          </div>
          <input v-model="settings.allowOsc52Clipboard" type="checkbox" class="set-switch" />
        </label>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.terminal.advanced', 'Advanced') }}</h3>
      <div class="set-card">
        <p class="set-hint set-card-text">{{ t('settings.terminal.advancedIntro', 'Scrollback, word boundaries, and platform-specific terminal behaviors.') }}</p>
        <div class="set-row">
          <label class="set-label" for="settings-word-separators">
            {{ t('settings.terminal.wordSeparators', 'Word separators') }}
            <span class="set-hint">{{ t('settings.terminal.wordSeparatorsHint', 'Characters treated as word boundaries for double-click selection.') }}</span>
          </label>
          <input
            id="settings-word-separators"
            class="set-number mcp-input set-mono"
            spellcheck="false"
            :placeholder="DEFAULT_WORD_SEPARATOR"
            :value="settings.wordSeparator"
            @input="settings.wordSeparator = $event.target.value"
          />
        </div>
      </div>
    </div>
    <SettingsToolRows page="terminal" @open="emit('open-tool', $event)" />
  </section>
</template>
