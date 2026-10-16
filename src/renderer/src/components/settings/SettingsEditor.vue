<script setup>
// Settings > Editor: the code editor in Tessel panes, its diffs, and the
// Files panel (moved from Appearance).
import { t } from '../../i18n'
import SettingsToolRows from '../SettingsToolRows.vue'
import { settings, FONT_FAMILIES } from '../../settings'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const { shown, emit } = useSettingsShell()
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
      <h3 class="set-group-title">{{ t('settings.editor.editing', 'Editing') }}</h3>
      <div class="set-card">
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.editor.autoSave', 'Save automatically') }}
            <span class="set-hint">{{ t('settings.editor.autoSaveHint', 'A moment after you stop typing (never over a file that changed on disk)') }}</span>
          </div>
          <input v-model="settings.editorAutoSave" type="checkbox" class="set-switch" />
        </label>
        <div v-if="settings.editorAutoSave" class="set-row set-row-nested">
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
        <div class="set-row">
          <label class="set-label" for="settings-editor-font">
            {{ t('settings.editor.font', 'Editor font family') }}
            <span class="set-hint">{{ t('settings.editor.fontHint', "For file editors and diffs. Empty: VS Code's (Consolas).") }}</span>
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
            {{ t('settings.editor.fontSize', 'Editor font size') }}
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
      </div>
    </div>
    <div class="set-group" data-group="diffs">
      <h3 class="set-group-title">{{ t('settings.editor.diffs', 'Diffs') }}</h3>
      <p class="set-group-desc">{{ t('settings.editor.diffsDesc', 'How a file\'s changes show, in Source Control and in the editor.') }}</p>
      <div class="set-card">
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.editor.sideBySide', 'Changes side by side') }}
            <span class="set-hint">{{ t('settings.editor.sideBySideHint', 'Otherwise inline, in one column') }}</span>
          </div>
          <input v-model="settings.diffSideBySide" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.editor.diffWhitespace', 'Show whitespace in diffs') }}
            <span class="set-hint">{{ t('settings.editor.diffWhitespaceHint', 'Show leading and trailing whitespace differences in diffs.') }}</span>
          </div>
          <input v-model="settings.diffShowWhitespace" type="checkbox" class="set-switch" data-setting="diffShowWhitespace" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.editor.collapseUnchanged', 'Collapse unchanged regions') }}
            <span class="set-hint">{{ t('settings.editor.collapseUnchangedHint', 'Only the changed lines and a little context; the rest folds into bands.') }}</span>
          </div>
          <input v-model="settings.diffCollapseUnchanged" type="checkbox" class="set-switch" data-setting="diffCollapseUnchanged" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.editor.diffWordWrap', 'Wrap lines in diffs') }}
            <span class="set-hint">{{ t('settings.editor.diffWordWrapHint', 'Long lines wrap instead of scrolling sideways.') }}</span>
          </div>
          <input v-model="settings.diffWordWrap" type="checkbox" class="set-switch" data-setting="diffWordWrap" />
        </label>
      </div>
    </div>
    <div class="set-group" data-group="files">
      <h3 class="set-group-title">{{ t('settings.editor.files', 'Files') }}</h3>
      <p class="set-group-desc">{{ t('settings.editor.filesDesc', 'The Files panel of the sidebar.') }}</p>
      <div class="set-card">
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.appearance.gitIgnored', 'Show Git-ignored files') }}
            <span class="set-hint">{{ t('settings.appearance.gitIgnoredHint', 'Files matched by .gitignore.') }}</span>
          </div>
          <input v-model="settings.showGitIgnoredFiles" type="checkbox" class="set-switch" data-setting="showGitIgnoredFiles" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.appearance.compactFolders', 'Compact folders') }}
            <span class="set-hint">{{
              t('settings.appearance.compactFoldersHint', 'In Files, a folder holding a single folder shares its row with it, like a/b/c.')
            }}</span>
          </div>
          <input v-model="settings.explorerCompactFolders" type="checkbox" class="set-switch" data-test="settings-compact-folders" />
        </label>
      </div>
    </div>
    <SettingsToolRows page="editor" @open="emit('open-tool', $event)" />
  </section>
</template>
