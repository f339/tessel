<script setup>
// Settings > General: how Tessel starts and closes, the tessel command.
import { t } from '../../i18n'
import CliSettings from '../CliSettings.vue'
import SettingsToolRows from '../SettingsToolRows.vue'
import { settings, resetSettings } from '../../settings'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const { page, searching, shown, emit } = useSettingsShell()
</script>

<template>
  <section
    id="set-general"
    class="set-page"
    data-page="general"
    :hidden="!shown('general')"
    aria-labelledby="set-general-title"
  >
    <header class="set-page-head">
      <h2 id="set-general-title">{{ PAGES.general.title }}</h2>
      <p class="set-page-desc">{{ PAGES.general.desc }}</p>
    </header>
    <div class="set-group">
      <div class="set-card">
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.general.restore', 'Reopen my workspaces at launch') }}
            <span class="set-hint">{{ t('settings.general.restoreHint', 'Off starts with a single terminal') }}</span>
          </div>
          <input v-model="settings.restoreWorkspaces" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.general.confirmClose', 'Confirm before closing running terminals') }}
            <span class="set-hint">{{ t('settings.general.confirmCloseHint', 'Ask before stopping a running agent or command when closing a terminal.') }}</span>
          </div>
          <input v-model="settings.confirmCloseAgent" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.general.confirmQuit', 'Ask before quitting while agents or terminals run') }}
            <span class="set-hint">{{ t('settings.general.confirmQuitHint', 'Closing the window quits Tessel and stops every agent and terminal.') }}</span>
          </div>
          <input v-model="settings.confirmQuitRunning" type="checkbox" class="set-switch" />
        </label>
      </div>
    </div>
    <!-- The tessel command (Settings > General, as Orca's CLI section). -->
    <CliSettings v-if="page === 'general' || searching" />
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.general.workspace', 'Workspace') }}</h3>
      <div class="set-card">
        <p class="set-hint set-card-text">{{ t('settings.general.workspaceIntro', 'Configure where new workspaces are created.') }}</p>
        <div class="set-row">
          <label class="set-label" for="settings-workspace-dir">
            {{ t('settings.general.workspaceDir', 'Workspace Directory') }}
            <span class="set-hint">{{ t('settings.general.workspaceDirHint', 'Root directory where workspace folders are created. Use a relative path (e.g. .tessel/worktrees) for a per-project location, or an absolute path for one shared folder. Empty: next to the project, in <project>.worktrees.') }}</span>
          </label>
          <div class="set-inline">
            <input
              id="settings-workspace-dir"
              class="set-number mcp-input"
              spellcheck="false"
              :placeholder="t('settings.general.workspaceDirPlaceholder', '<project>.worktrees')"
              :value="settings.workspaceDir"
              @change="settings.workspaceDir = $event.target.value.trim()"
            />
            <button
              class="exit-btn"
              type="button"
              :disabled="!settings.workspaceDir"
              @click="settings.workspaceDir = ''"
            >
              {{ t('settings.common.reset', 'Reset') }}
            </button>
          </div>
        </div>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.general.confirmDelete', 'Ask Before Deleting Workspaces') }}
            <span class="set-hint">{{ t('settings.general.confirmDeleteHint', 'Show a confirmation before deleting a workspace from the context menu. Unsaved files are always asked about.') }}</span>
          </div>
          <input v-model="settings.confirmDeleteWorkspace" type="checkbox" class="set-switch" />
        </label>
      </div>
    </div>
    <SettingsToolRows page="general" @open="emit('open-tool', $event)" />
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.general.resetGroup', 'Reset') }}</h3>
      <div class="set-card">
        <div class="set-row set-foot">
          <div class="set-label">
            {{ t('settings.general.resetAll', 'Reset every setting') }}
            <span class="set-hint">{{ t('settings.general.resetAllHint', 'Changes apply right away and are saved. This puts every setting back to its default') }}</span>
          </div>
          <button class="exit-btn" type="button" @click="resetSettings">{{ t('settings.general.resetToDefaults', 'Reset to defaults') }}</button>
        </div>
      </div>
    </div>
  </section>
</template>
