<script setup>
// Settings > Git & Source Control: branch naming and Source Control.
import { computed } from 'vue'
import { t } from '../../i18n'
import SettingsToolRows from '../SettingsToolRows.vue'
import { settings } from '../../settings'
import { getBranchPrefixIssue, normalizeBranchPrefix } from '../../../../shared/worktreeNaming'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const { shown, emit } = useSettingsShell()

// Settings > Git: Source Control's files as a tree or a list (ChangesPanel.vue).
const SCM_VIEWS = computed(() => [
  { id: 'tree', label: t('settings.git.viewTree', 'Tree') },
  { id: 'list', label: t('settings.git.viewList', 'List') }
])
const scmView = computed(() => (settings.sourceControlViewMode === 'list' ? 'list' : 'tree'))

// Settings > Git & Source Control.
const BRANCH_PREFIX_MODES = computed(() => [
  { id: 'git-username', label: t('settings.git.prefixGitUsername', 'Git username') },
  { id: 'custom', label: t('settings.git.prefixCustom', 'Custom') },
  { id: 'none', label: t('settings.git.prefixNone', 'None') }
])
const GROUP_ORDERS = computed(() => [
  { id: 'changes-first', label: t('settings.git.changesFirst', 'Changes first') },
  { id: 'staged-first', label: t('settings.git.stagedFirst', 'Staged first') },
  { id: 'untracked-first', label: t('settings.git.untrackedFirst', 'Untracked first') }
])
const branchPrefixFeedback = computed(() => {
  if (settings.branchPrefix === 'none') return { text: '', error: false }
  if (settings.branchPrefix === 'git-username')
    return {
      text: t('settings.git.usernameHint', 'Uses git config github.user or user.username, else your GitHub CLI login'),
      error: false
    }
  const raw = settings.branchPrefixCustom || ''
  if (getBranchPrefixIssue(raw))
    return {
      text: t('settings.git.prefixInvalid', 'Prefix cannot contain spaces or special characters like ~ ^ : ? * [ \\'),
      error: true
    }
  const p = normalizeBranchPrefix(raw)
  if (p) return { text: t('settings.git.prefixExampleName', 'Branches will be named {{prefix}}/feature', { prefix: p }), error: false }
  return { text: raw.trim() ? t('settings.git.noPrefix', 'No prefix will be applied') : '', error: false }
})
</script>

<template>
  <section
    id="set-git"
    class="set-page"
    data-page="git"
    :hidden="!shown('git')"
    aria-labelledby="set-git-title"
  >
    <header class="set-page-head">
      <h2 id="set-git-title">{{ PAGES.git.title }}</h2>
      <p class="set-page-desc">{{ PAGES.git.desc }}</p>
    </header>
    <div class="set-group">
      <div class="set-card">
        <div class="set-row set-row-wrap">
          <div id="settings-branch-prefix-label" class="set-label">
            {{ t('settings.git.branchPrefix', 'Branch prefix') }}
            <span class="set-hint">{{ t('settings.git.branchPrefixHint', 'Choose whether branch names use your Git username, a custom prefix, or no prefix.') }}</span>
          </div>
          <div class="set-branch-prefix">
            <div class="launch-seg set-seg" role="group" aria-labelledby="settings-branch-prefix-label">
              <button
                v-for="m in BRANCH_PREFIX_MODES"
                :key="m.id"
                type="button"
                class="launch-seg-btn"
                :class="{ on: settings.branchPrefix === m.id }"
                :aria-pressed="settings.branchPrefix === m.id"
                @click="settings.branchPrefix = m.id"
              >
                {{ m.label }}
              </button>
            </div>
            <input
              v-if="settings.branchPrefix === 'custom'"
              class="set-number mcp-input"
              :aria-label="t('settings.git.customPrefix', 'Custom branch prefix')"
              spellcheck="false"
              :placeholder="t('settings.git.prefixExample', 'e.g. feature')"
              :value="settings.branchPrefixCustom"
              @input="settings.branchPrefixCustom = $event.target.value"
            />
            <span
              class="set-hint"
              data-test="branch-prefix-feedback"
              :class="{ 'set-error': branchPrefixFeedback.error }"
              >{{ branchPrefixFeedback.text }}</span
            >
          </div>
        </div>
        <div class="set-row">
          <div id="settings-group-order-label" class="set-label">
            {{ t('settings.git.groupOrder', 'Source Control group order') }}
            <span class="set-hint">{{ t('settings.git.groupOrderHint', 'Choose whether Changes, Staged Changes, or Untracked Files appear first in Source Control.') }}</span>
          </div>
          <div class="launch-seg set-seg set-seg-wide" role="group" aria-labelledby="settings-group-order-label">
            <button
              v-for="o in GROUP_ORDERS"
              :key="String(o.id)"
              type="button"
              class="launch-seg-btn"
              :class="{ on: settings.sourceControlGroupOrder === o.id }"
              :aria-pressed="settings.sourceControlGroupOrder === o.id"
              @click="settings.sourceControlGroupOrder = o.id"
            >
              {{ o.label }}
            </button>
          </div>
        </div>
        <div class="set-row">
          <div id="settings-scm-view-label" class="set-label">
            {{ t('settings.git.viewMode', 'Source Control view') }}
            <span class="set-hint">{{ t('settings.git.viewModeHint', 'Show the changed files as a folder tree or as a flat list.') }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-scm-view-label" data-setting="sourceControlViewMode">
            <button
              v-for="o in SCM_VIEWS"
              :key="o.id"
              type="button"
              class="launch-seg-btn"
              :class="{ on: scmView === o.id }"
              :aria-pressed="scmView === o.id"
              @click="settings.sourceControlViewMode = o.id"
            >
              {{ o.label }}
            </button>
          </div>
        </div>
      </div>
    </div>
    <SettingsToolRows page="git" @open="emit('open-tool', $event)" />
  </section>
</template>
