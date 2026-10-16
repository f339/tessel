<script setup>
// Settings > Git & Source Control: branch naming and Source Control.
import { computed } from 'vue'
import { t } from '../../i18n'
import SettingsToolRows from '../SettingsToolRows.vue'
import ThemedSelect from '../ui/ThemedSelect.vue'
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
// What the chosen prefix gives: under Branch prefix (Git username, None), or
// under the custom prefix's own row, where it can say what is wrong with it.
const branchPrefixFeedback = computed(() => {
  if (settings.branchPrefix === 'none') return { text: t('settings.git.noPrefixHint', 'New branches get no prefix.'), error: false }
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
  return { text: raw.trim() ? t('settings.git.noPrefix', 'No prefix will be applied') : t('settings.git.customEmpty', 'Type the text to put in front of branch names.'), error: false }
})
const groupOrder = computed(() =>
  GROUP_ORDERS.value.some((o) => o.id === settings.sourceControlGroupOrder) ? settings.sourceControlGroupOrder : 'changes-first'
)
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
      <h3 class="set-group-title">{{ t('settings.git.branchesGroup', 'Branches') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <div id="settings-branch-prefix-label" class="set-label">
            {{ t('settings.git.branchPrefix', 'Branch prefix') }}
            <span
              v-if="settings.branchPrefix !== 'custom'"
              class="set-hint"
              data-test="branch-prefix-feedback"
              >{{ branchPrefixFeedback.text }}</span
            >
            <span v-else class="set-hint">{{ t('settings.git.branchPrefixHintShort', 'Put in front of the name of each new branch.') }}</span>
          </div>
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
        </div>
        <!-- The custom prefix on its own line, under its choice. -->
        <div v-if="settings.branchPrefix === 'custom'" class="set-row set-row-nested">
          <label class="set-label" for="settings-branch-prefix-custom">
            {{ t('settings.git.customPrefixShort', 'Custom prefix') }}
            <span
              class="set-hint"
              data-test="branch-prefix-feedback"
              :class="{ 'set-error': branchPrefixFeedback.error }"
              >{{ branchPrefixFeedback.text }}</span
            >
          </label>
          <input
            id="settings-branch-prefix-custom"
            class="set-number git-prefix-input"
            :aria-label="t('settings.git.customPrefix', 'Custom branch prefix')"
            spellcheck="false"
            :placeholder="t('settings.git.prefixExample', 'e.g. feature')"
            :value="settings.branchPrefixCustom"
            @input="settings.branchPrefixCustom = $event.target.value"
          />
        </div>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.git.scmGroup', 'Source Control') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <label class="set-label" for="settings-group-order">
            {{ t('settings.git.groupOrderShort', 'Group order') }}
            <span class="set-hint">{{ t('settings.git.groupOrderHintShort', 'Which group Source Control lists first.') }}</span>
          </label>
          <ThemedSelect
            id="settings-group-order"
            :model-value="groupOrder"
            class="set-select"
            data-setting="sourceControlGroupOrder"
            @update:model-value="settings.sourceControlGroupOrder = $event"
          >
            <option v-for="o in GROUP_ORDERS" :key="o.id" :value="o.id">{{ o.label }}</option>
          </ThemedSelect>
        </div>
        <div class="set-row">
          <div id="settings-scm-view-label" class="set-label">
            {{ t('settings.git.viewModeShort', 'Show changed files as') }}
            <span class="set-hint">{{ t('settings.git.viewModeHintShort', 'A folder tree or a flat list.') }}</span>
          </div>
          <div class="launch-seg set-seg git-view-seg" role="group" aria-labelledby="settings-scm-view-label" data-setting="sourceControlViewMode">
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

<style scoped>
.git-prefix-input {
  width: 200px;
}
.git-view-seg {
  width: 200px;
}
</style>
