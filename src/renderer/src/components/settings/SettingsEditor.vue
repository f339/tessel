<script setup>
// Settings > Editor: the code editor in Tessel panes.
import { computed } from 'vue'
import { t } from '../../i18n'
import SettingsToolRows from '../SettingsToolRows.vue'
import { settings, FONT_FAMILIES } from '../../settings'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const { shown, emit } = useSettingsShell()

const OFF_ON = computed(() => [
  { id: false, label: t('settings.common.off', 'Off') },
  { id: true, label: t('settings.common.on', 'On') }
])
</script>

<template>
  <section
    id="set-editor"
    class="set-page"
    data-page="editor"
    :hidden="!shown('editor')"
    aria-labelledby="set-editor-title"
  >
    <header class="set-page-head">
      <h2 id="set-editor-title">{{ PAGES.editor.title }}</h2>
      <p class="set-page-desc">{{ PAGES.editor.desc }}</p>
    </header>
    <div class="set-group">
      <div class="set-card">
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.editor.autoSave', 'Save automatically') }}
            <span class="set-hint">{{ t('settings.editor.autoSaveHint', 'A moment after you stop typing (never over a file that changed on disk)') }}</span>
          </div>
          <input v-model="settings.editorAutoSave" type="checkbox" class="set-switch" />
        </label>
        <div v-if="settings.editorAutoSave" class="set-row">
          <label class="set-label" for="settings-autosave-ms">
            {{ t('settings.editor.saveAfter', 'Save after') }}
            <span class="set-hint">{{ t('settings.editor.saveAfterHint', 'Milliseconds without typing (250 to 10000)') }}</span>
          </label>
          <input
            id="settings-autosave-ms"
            class="set-number"
            type="number"
            min="250"
            max="10000"
            step="250"
            :value="settings.editorAutoSaveDelayMs"
            @change="
              settings.editorAutoSaveDelayMs = Math.min(10000, Math.max(250, parseInt($event.target.value, 10) || 1000));
              $event.target.value = settings.editorAutoSaveDelayMs
            "
          />
        </div>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.editor.wordWrap', 'Word wrap') }}
            <span class="set-hint">{{ t('settings.editor.wordWrapHint', 'Long lines wrap to the pane\'s width (Alt+Z in the editor)') }}</span>
          </div>
          <input v-model="settings.editorWordWrap" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">{{ t('settings.editor.minimap', 'Minimap') }}</div>
          <input v-model="settings.editorMinimap" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.editor.previewTabs', 'Preview tabs') }}
            <span class="set-hint">{{ t('settings.editor.previewTabsHint', 'A file opened with one click replaces the previous one until you edit it or double-click its tab') }}</span>
          </div>
          <input v-model="settings.editorPreviewTabs" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.editor.sideBySide', 'Changes side by side') }}
            <span class="set-hint">{{ t('settings.editor.sideBySideHint', 'Otherwise inline, in one column') }}</span>
          </div>
          <input v-model="settings.diffSideBySide" type="checkbox" class="set-switch" />
        </label>
        <div class="set-row">
          <label class="set-label" for="settings-editor-font">
            {{ t('settings.editor.font', 'Editor Font Family') }}
            <span class="set-hint">{{ t('settings.editor.fontHint', "Font used by file editors and diff views. Leave empty for VS Code's (Consolas).") }}</span>
          </label>
          <input
            id="settings-editor-font"
            class="set-number mcp-input"
            list="settings-editor-fonts"
            spellcheck="false"
            :placeholder="t('settings.editor.fontPlaceholder', 'Consolas (like VS Code)')"
            :value="settings.editorFontFamily"
            @change="settings.editorFontFamily = $event.target.value.trim()"
          />
          <datalist id="settings-editor-fonts">
            <option v-for="f in FONT_FAMILIES" :key="f" :value="f"></option>
          </datalist>
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-editor-font-size">
            {{ t('settings.editor.fontSize', 'Editor Font Size') }}
            <span class="set-hint">{{ t('settings.editor.fontSizeHint', 'In pixels (VS Code: 14)') }}</span>
          </label>
          <input
            id="settings-editor-font-size"
            class="set-number"
            type="number"
            min="6"
            max="100"
            :value="settings.editorFontSize"
            @change="settings.editorFontSize = Math.min(100, Math.max(6, parseInt($event.target.value, 10) || 14)); $event.target.value = settings.editorFontSize"
          />
        </div>
        <div class="set-row">
          <div id="settings-diff-ws-label" class="set-label">
            {{ t('settings.editor.diffWhitespace', 'Diff Show Whitespace') }}
            <span class="set-hint">{{ t('settings.editor.diffWhitespaceHint', 'Show leading and trailing whitespace differences in diffs.') }}</span>
          </div>
          <div class="launch-seg set-seg set-seg-small" role="group" aria-labelledby="settings-diff-ws-label">
            <button
              v-for="o in OFF_ON"
              :key="String(o.id)"
              type="button"
              class="launch-seg-btn"
              :class="{ on: settings.diffShowWhitespace === o.id }"
              :aria-pressed="settings.diffShowWhitespace === o.id"
              @click="settings.diffShowWhitespace = o.id"
            >
              {{ o.label }}
            </button>
          </div>
        </div>
        <div class="set-row">
          <div id="settings-diff-collapse-label" class="set-label">
            {{ t('settings.editor.collapseUnchanged', 'Collapse Unchanged Regions') }}
            <span class="set-hint">{{ t('settings.editor.collapseUnchangedHint', 'Show only changed lines and a little surrounding context in a file diff, hiding the rest behind expandable bands.') }}</span>
          </div>
          <div class="launch-seg set-seg set-seg-small" role="group" aria-labelledby="settings-diff-collapse-label">
            <button
              v-for="o in OFF_ON"
              :key="String(o.id)"
              type="button"
              class="launch-seg-btn"
              :class="{ on: settings.diffCollapseUnchanged === o.id }"
              :aria-pressed="settings.diffCollapseUnchanged === o.id"
              @click="settings.diffCollapseUnchanged = o.id"
            >
              {{ o.label }}
            </button>
          </div>
        </div>
        <div class="set-row">
          <div id="settings-diff-wrap-label" class="set-label">
            {{ t('settings.editor.diffWordWrap', 'Diff Word Wrap') }}
            <span class="set-hint">{{ t('settings.editor.diffWordWrapHint', 'Wrap long lines in diff editors instead of requiring horizontal scrolling.') }}</span>
          </div>
          <div class="launch-seg set-seg set-seg-small" role="group" aria-labelledby="settings-diff-wrap-label">
            <button
              v-for="o in OFF_ON"
              :key="String(o.id)"
              type="button"
              class="launch-seg-btn"
              :class="{ on: settings.diffWordWrap === o.id }"
              :aria-pressed="settings.diffWordWrap === o.id"
              @click="settings.diffWordWrap = o.id"
            >
              {{ o.label }}
            </button>
          </div>
        </div>

      </div>
    </div>
    <SettingsToolRows page="editor" @open="emit('open-tool', $event)" />
  </section>
</template>
