<script setup>
// Settings > Appearance: theme, zoom, the left sidebar and the status bar.
import { computed } from 'vue'
import ThemedSelect from '../ui/ThemedSelect.vue'
import { t, UI_LANGUAGES } from '../../i18n'
import { settings, clamp, MAX_LEFT_SIDEBAR_TINT_OPACITY, LIMITS, USAGE_REFRESH_MINUTES } from '../../settings'
import { THEMES } from '../../themes'
import { uiZoomPercent, stepUiZoom } from '../../appearance'
import { PAGES } from './settingsPages'
import { setNumber } from './settingsFields'
import { useSettingsShell } from './settingsShell'

const { shown } = useSettingsShell()

// Settings > Appearance, "Usage refresh": Off, or every N minutes.
const usageRefreshLabel = (m) =>
  m === 0
    ? t('settings.appearance.usageRefreshOff', 'Off')
    : t('settings.appearance.usageRefreshMinutes', '{{count}} min', { count: m })

// Settings > Appearance > Window & Sidebar (Orca's AppearanceWindowSidebarSection).
// Settings > Appearance > Sidebar: the left sidebar's view options, the same
// as its Options menu (WorkspaceSidebar.vue).
const SIDEBAR_SORT_OPTIONS = computed(() => [
  { id: 'name', label: t('sidebar.options.sortName', 'Name') },
  { id: 'smart', label: t('sidebar.options.sortSmart', 'Agent activity') },
  { id: 'recent', label: t('sidebar.options.recent', 'Recent') },
  { id: 'repo', label: t('sidebar.options.project', 'Project') },
  { id: 'manual', label: t('sidebar.options.manual', 'Manual') }
])
const SIDEBAR_GROUPS = computed(() => [
  { id: 'none', label: t('sidebar.options.groupNone', 'None') },
  { id: 'repo', label: t('sidebar.options.project', 'Project') }
])
const CARD_PROPERTIES = computed(() => [
  { id: 'ports', label: t('sidebar.options.ports', 'Ports') },
  { id: 'inline-agents', label: t('sidebar.options.agentActivity', 'Agent activity') },
  { id: 'host', label: t('sidebar.options.host', 'Host') }
])
const AGENT_ACTIVITY_LAYOUTS = computed(() => [
  { id: 'compact', label: t('sidebar.options.compact', 'Compact') },
  { id: 'full', label: t('sidebar.options.fullList', 'Full list') }
])
function toggleCardProperty(id) {
  const list = settings.worktreeCardProperties
  settings.worktreeCardProperties = list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}
const SIDEBAR_APPEARANCES = computed(() => [
  { id: 'default', label: t('settings.appearance.sidebarDefault', 'Default') },
  { id: 'match-terminal', label: t('settings.appearance.sidebarMatchTerminal', 'Match terminal') },
  { id: 'tinted', label: t('settings.appearance.sidebarTinted', 'Tinted') }
])
const STATUS_BAR_TOGGLES = computed(() => [
  {
    id: 'ssh',
    title: t('settings.appearance.statusSsh', 'Remote Hosts'),
    description: t('settings.appearance.statusSshHint', 'Show configured SSH and remote Tessel hosts when any are available.')
  },
  {
    id: 'resource-usage',
    title: t('settings.appearance.statusResources', 'Resource Manager'),
    description: t('settings.appearance.statusResourcesHint', 'Show the Resource Manager. Click it for CPU, memory and sessions.')
  },
  {
    id: 'ports',
    title: t('settings.appearance.statusPorts', 'Ports'),
    description: t('settings.appearance.statusPortsHint', 'Show live workspace ports. Click it for workspace-scoped ports and external listeners.')
  }
])
function toggleStatusBarItem(id) {
  const list = settings.statusBarItems
  settings.statusBarItems = list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}
function setTintOpacity(e) {
  const n = parseFloat(e.target.value)
  if (Number.isFinite(n)) settings.leftSidebarTintOpacity = clamp(n, 0, MAX_LEFT_SIDEBAR_TINT_OPACITY)
  e.target.value = settings.leftSidebarTintOpacity
}

const zoomPercent = computed(() => uiZoomPercent(settings.uiZoomLevel))
function zoom(direction) {
  settings.uiZoomLevel = stepUiZoom(settings.uiZoomLevel, direction)
}
</script>

<template>
  <section
    id="set-appearance"
    class="set-page"
    data-page="appearance"
    :hidden="!shown('appearance')"
    aria-labelledby="set-appearance-title"
  >
    <header class="set-page-head">
      <h2 id="set-appearance-title">{{ PAGES.appearance.title }}</h2>
      <p class="set-page-desc">{{ PAGES.appearance.desc }}</p>
    </header>
    <div class="set-group">
      <div class="set-card">
        <div class="set-row" data-setting="ui-language">
          <label class="set-label" for="appearance-language">
            {{ t('settings.language.title', 'Language') }}
            <span class="set-hint">{{
              t('settings.language.hint', "The language of Tessel's interface. System follows Windows.")
            }}</span>
          </label>
          <ThemedSelect id="appearance-language" v-model="settings.uiLanguage" class="set-select">
            <option v-for="lang in UI_LANGUAGES" :key="lang.value" :value="lang.value">
              {{ t(lang.key, lang.label) }}
            </option>
          </ThemedSelect>
        </div>
        <div class="set-row">
          <label class="set-label" for="appearance-theme">
            {{ t('settings.appearance.theme', 'Theme') }}
            <span class="set-hint">{{ t('settings.appearance.themeHint', 'Applies immediately. Your sessions keep running.') }}</span>
          </label>
          <ThemedSelect id="appearance-theme" v-model="settings.theme" class="set-select">
            <option v-for="theme in THEMES" :key="theme.id" :value="theme.id">
              {{ theme.label }}
            </option>
          </ThemedSelect>
        </div>
        <div class="set-row" data-setting="fileIcons">
          <label class="set-label" for="appearance-file-icons">
            {{ t('settings.appearance.fileIcons', 'File icons') }}
            <span class="set-hint">{{ t('settings.appearance.fileIconsHint', "VS Code's icons in the file explorer, the editor's tabs, Source Control and Go to file.") }}</span>
          </label>
          <ThemedSelect id="appearance-file-icons" v-model="settings.fileIcons" class="set-select">
            <option value="color">{{ t('settings.appearance.fileIconsColor', 'In colour, like VS Code') }}</option>
            <option value="mono">{{ t('settings.appearance.fileIconsMono', 'One colour') }}</option>
            <option value="off">{{ t('settings.appearance.fileIconsOff', 'None') }}</option>
          </ThemedSelect>
        </div>
        <div class="set-row" data-setting="ui-zoom">
          <div class="set-label">
            {{ t('settings.appearance.zoom', 'UI zoom') }}
            <span class="set-hint">{{ t('settings.appearance.zoomHint', 'Scale the entire application interface.') }}</span>
          </div>
          <div class="set-inline">
            <div class="set-stepper">
              <button
                type="button"
                :title="t('settings.appearance.zoomOut', 'Zoom out')"
                :aria-label="t('settings.appearance.zoomOut', 'Zoom out')"
                :disabled="settings.uiZoomLevel <= LIMITS.uiZoomLevel[0]"
                @click="zoom('out')"
              >
                −
              </button>
              <span data-test="ui-zoom-percent">{{ zoomPercent }}%</span>
              <button
                type="button"
                :title="t('settings.appearance.zoomIn', 'Zoom in')"
                :aria-label="t('settings.appearance.zoomIn', 'Zoom in')"
                :disabled="settings.uiZoomLevel >= LIMITS.uiZoomLevel[1]"
                @click="zoom('in')"
              >
                +
              </button>
            </div>
            <button class="exit-btn" type="button" :disabled="settings.uiZoomLevel === 0" @click="zoom('reset')">
              {{ t('settings.common.reset', 'Reset') }}
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.appearance.terminalPanes', 'Terminal panes') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <label class="set-label" for="settings-inactive-opacity">
            {{ t('settings.appearance.inactiveOpacity', 'Inactive pane opacity') }}
            <span class="set-hint">{{ t('settings.appearance.inactiveOpacityHint', 'Dim unfocused panes. 0-1') }}</span>
          </label>
          <input
            id="settings-inactive-opacity"
            class="set-number"
            type="number"
            min="0"
            max="1"
            step="0.05"
            :value="settings.inactivePaneOpacity"
            @change="setNumber('inactivePaneOpacity', $event)"
          />
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-divider">
            {{ t('settings.appearance.divider', 'Divider thickness') }}
            <span class="set-hint">{{ t('settings.appearance.dividerHint', 'Thickness of the pane divider line. px') }}</span>
          </label>
          <input
            id="settings-divider"
            class="set-number"
            type="number"
            min="1"
            max="32"
            step="1"
            :value="settings.dividerThickness"
            @change="setNumber('dividerThickness', $event, true)"
          />
        </div>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.appearance.window', 'Window') }}</h3>
      <div class="set-card">
        <p class="set-hint set-card-text">{{ t('settings.appearance.windowIntro', 'Window appearance and background settings.') }}</p>
        <div class="set-row">
          <label class="set-label" for="settings-pad-x">
            {{ t('settings.appearance.padX', 'Horizontal padding') }}
            <span class="set-hint">{{ t('settings.appearance.padXHint', 'Horizontal padding around the terminal grid in pixels.') }}</span>
          </label>
          <input
            id="settings-pad-x"
            class="set-number"
            type="number"
            min="0"
            max="512"
            step="1"
            :value="settings.terminalPaddingX"
            @change="setNumber('terminalPaddingX', $event, true)"
          />
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-pad-y">
            {{ t('settings.appearance.padY', 'Vertical padding') }}
            <span class="set-hint">{{ t('settings.appearance.padYHint', 'Vertical padding around the terminal grid in pixels.') }}</span>
          </label>
          <input
            id="settings-pad-y"
            class="set-number"
            type="number"
            min="0"
            max="512"
            step="1"
            :value="settings.terminalPaddingY"
            @change="setNumber('terminalPaddingY', $event, true)"
          />
        </div>
        <label class="set-row">
          <div class="set-label">{{ t('settings.appearance.hideMouse', 'Hide mouse while typing') }}</div>
          <input v-model="settings.hideMouseWhileTyping" type="checkbox" class="set-switch" />
        </label>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.appearance.windowSidebar', 'Window & sidebar') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <div id="settings-usage-pct-label" class="set-label">
            {{ t('settings.appearance.usagePct', 'Usage percentages') }}
            <span class="set-hint">{{ t('settings.appearance.usagePctHint', 'Choose whether provider limits show the percentage used or remaining.') }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-usage-pct-label">
            <button
              v-for="o in [
                { id: 'used', label: t('settings.appearance.used', 'Used') },
                { id: 'remaining', label: t('settings.appearance.remaining', 'Remaining') }
              ]"
              :key="o.id"
              type="button"
              class="launch-seg-btn"
              :class="{ on: settings.usagePercentageDisplay === o.id }"
              :aria-pressed="settings.usagePercentageDisplay === o.id"
              @click="settings.usagePercentageDisplay = o.id"
            >
              {{ o.label }}
            </button>
          </div>
        </div>
        <div class="set-row">
          <div id="settings-usage-refresh-label" class="set-label">
            {{ t('settings.appearance.usageRefresh', 'Usage refresh') }}
            <span class="set-hint">{{ t('settings.appearance.usageRefreshHint', 'How often provider limits are read again while Tessel is in use. Off: only when you open Usage.') }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-usage-refresh-label">
            <button
              v-for="m in USAGE_REFRESH_MINUTES"
              :key="m"
              type="button"
              class="launch-seg-btn"
              :class="{ on: settings.usageRefreshMinutes === m }"
              :aria-pressed="settings.usageRefreshMinutes === m"
              @click="settings.usageRefreshMinutes = m"
            >
              {{ usageRefreshLabel(m) }}
            </button>
          </div>
        </div>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.appearance.gitIgnored', 'Show Git-ignored files') }}
            <span class="set-hint">{{ t('settings.appearance.gitIgnoredHint', 'Files matched by .gitignore.') }}</span>
          </div>
          <input v-model="settings.showGitIgnoredFiles" type="checkbox" class="set-switch" />
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
        <!-- Orca's Appearance > Window & Sidebar (same section). -->
        <div class="set-row">
          <div id="settings-sidebar-appearance-label" class="set-label">
            {{ t('settings.appearance.sidebar', 'Left sidebar appearance') }}
            <span class="set-hint">{{ t('settings.appearance.sidebarHint', 'Make the left sidebar match your terminal, stay default, or use a tint.') }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-sidebar-appearance-label">
            <button
              v-for="m in SIDEBAR_APPEARANCES"
              :key="m.id"
              class="launch-seg-btn"
              :class="{ on: settings.leftSidebarAppearanceMode === m.id }"
              :aria-pressed="settings.leftSidebarAppearanceMode === m.id"
              @click="settings.leftSidebarAppearanceMode = m.id"
            >
              {{ m.label }}
            </button>
          </div>
        </div>
        <template v-if="settings.leftSidebarAppearanceMode === 'tinted'">
          <label class="set-row">
            <div class="set-label">
              {{ t('settings.appearance.tint', 'Sidebar tint') }}
              <span class="set-hint">{{ t('settings.appearance.tintHint', 'The color mixed into the left sidebar surface.') }}</span>
            </div>
            <input v-model="settings.leftSidebarTintColor" type="color" class="set-color" :aria-label="t('settings.appearance.tint', 'Sidebar tint')" />
          </label>
          <label class="set-row">
            <div class="set-label">
              {{ t('settings.appearance.tintStrength', 'Tint strength') }}
              <span
                class="set-hint"
                v-text="t('settings.appearance.tintStrengthHint', 'Controls how strongly the tint is mixed into the sidebar. 0 to {{max}}', { max: MAX_LEFT_SIDEBAR_TINT_OPACITY })"
              ></span>
            </div>
            <input
              type="number"
              class="set-number"
              min="0"
              :max="MAX_LEFT_SIDEBAR_TINT_OPACITY"
              step="0.01"
              :value="settings.leftSidebarTintOpacity"
              :aria-label="t('settings.appearance.tintStrength', 'Tint strength')"
              @change="setTintOpacity"
            />
          </label>
        </template>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.appearance.statusBarVisible', 'Show status bar') }}
            <span class="set-hint">{{ t('settings.appearance.statusBarVisibleHint', 'The bar at the bottom of the window.') }}</span>
          </div>
          <input v-model="settings.statusBarVisible" type="checkbox" class="set-switch" />
        </label>
        <div class="set-row">
          <div class="set-label">
            {{ t('settings.appearance.statusBar', 'Status bar') }}
            <span class="set-hint">{{ t('settings.appearance.statusBarHint', 'Choose which indicators appear in the status bar.') }}</span>
          </div>
        </div>
        <label v-for="item in STATUS_BAR_TOGGLES" :key="item.id" class="set-row set-row-nested">
          <div class="set-label">
            {{ item.title }}
            <span class="set-hint">{{ item.description }}</span>
          </div>
          <input
            type="checkbox"
            class="set-switch"
            :checked="settings.statusBarItems.includes(item.id)"
            :aria-label="item.title"
            @change="toggleStatusBarItem(item.id)"
          />
        </label>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.appearance.sidebarGroup', 'Sidebar') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <div id="settings-card-layout-label" class="set-label">
            {{ t('settings.appearance.cardLayout', 'Workspace card layout') }}
            <span class="set-hint">{{ t('settings.appearance.cardLayoutHint', 'Workspace cards can use compact or detailed layouts.') }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-card-layout-label">
            <button
              class="launch-seg-btn"
              :class="{ on: !settings.compactWorktreeCards }"
              :aria-pressed="!settings.compactWorktreeCards"
              @click="settings.compactWorktreeCards = false"
            >
              {{ t('settings.appearance.detailed', 'Detailed') }}
            </button>
            <button
              class="launch-seg-btn"
              :class="{ on: settings.compactWorktreeCards }"
              :aria-pressed="settings.compactWorktreeCards"
              @click="settings.compactWorktreeCards = true"
            >
              {{ t('settings.appearance.compact', 'Compact') }}
            </button>
          </div>
        </div>
        <div class="set-row">
          <div id="settings-sidebar-group-label" class="set-label">
            {{ t('sidebar.options.groupBy', 'Group by') }}
            <span class="set-hint">{{ t('settings.appearance.groupByHint', 'Show the workspaces under their project, or in one list.') }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-sidebar-group-label" data-setting="sidebarGroupBy">
            <button
              v-for="o in SIDEBAR_GROUPS"
              :key="o.id"
              type="button"
              class="launch-seg-btn"
              :class="{ on: settings.sidebarGroupBy === o.id }"
              :aria-pressed="settings.sidebarGroupBy === o.id"
              @click="settings.sidebarGroupBy = o.id"
            >
              {{ o.label }}
            </button>
          </div>
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-sidebar-sort">
            {{ t('sidebar.options.sortBy', 'Sort by') }}
            <span class="set-hint">{{ t('settings.appearance.sortByHint', 'The order of the workspaces in the left sidebar.') }}</span>
          </label>
          <ThemedSelect id="settings-sidebar-sort" v-model="settings.sidebarSortBy" class="set-select" data-setting="sidebarSortBy">
            <option v-for="o in SIDEBAR_SORT_OPTIONS" :key="o.id" :value="o.id">{{ o.label }}</option>
          </ThemedSelect>
        </div>
        <div v-if="settings.sidebarGroupBy === 'repo'" class="set-row">
          <label class="set-label" for="settings-project-order">
            {{ t('sidebar.options.projectOrder', 'Project order') }}
            <span class="set-hint">{{ t('settings.appearance.projectOrderHint', 'Manual: drag projects to arrange them. Recent: most recent workspace activity first.') }}</span>
          </label>
          <ThemedSelect id="settings-project-order" v-model="settings.sidebarProjectOrderBy" class="set-select" data-setting="sidebarProjectOrderBy">
            <option value="manual">{{ t('sidebar.options.manual', 'Manual') }}</option>
            <option value="recent">{{ t('sidebar.options.recent', 'Recent') }}</option>
          </ThemedSelect>
        </div>
        <div class="set-row">
          <div class="set-label">
            {{ t('sidebar.options.showProperties', 'Show properties') }}
            <span class="set-hint">{{ t('settings.appearance.cardPropertiesHint', 'What a detailed workspace card shows (a compact card shows them on hover).') }}</span>
          </div>
        </div>
        <label v-for="p in CARD_PROPERTIES" :key="p.id" class="set-row set-row-nested">
          <div class="set-label">{{ p.label }}</div>
          <input
            type="checkbox"
            class="set-switch"
            :data-card-property="p.id"
            :checked="settings.worktreeCardProperties.includes(p.id)"
            :aria-label="p.label"
            @change="toggleCardProperty(p.id)"
          />
        </label>
        <div class="set-row">
          <div id="settings-agent-activity-label" class="set-label">
            {{ t('sidebar.options.agentActivityLayout', 'Agent activity layout') }}
            <span class="set-hint">{{ t('settings.appearance.agentActivityHint', 'The agents under a workspace card: a compact line, or the full list.') }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-agent-activity-label" data-setting="agentActivityDisplayMode">
            <button
              v-for="o in AGENT_ACTIVITY_LAYOUTS"
              :key="o.id"
              type="button"
              class="launch-seg-btn"
              :class="{ on: settings.agentActivityDisplayMode === o.id }"
              :aria-pressed="settings.agentActivityDisplayMode === o.id"
              @click="settings.agentActivityDisplayMode = o.id"
            >
              {{ o.label }}
            </button>
          </div>
        </div>
        <label class="set-row">
          <div class="set-label">
            {{ t('sidebar.options.hideSleeping', 'Hide sleeping') }}
            <span class="set-hint">{{ t('settings.appearance.hideSleepingHint', 'Hide the workspaces whose agents are asleep.') }}</span>
          </div>
          <input
            type="checkbox"
            class="set-switch"
            data-setting="hideSleeping"
            :checked="!settings.showSleepingWorkspaces"
            @change="settings.showSleepingWorkspaces = !$event.target.checked"
          />
        </label>
        <label v-if="!settings.showSleepingWorkspaces" class="set-row set-row-nested">
          <div class="set-label">
            {{ t('sidebar.options.exceptDefault', 'Except default branch') }}
            <span class="set-hint">{{ t('sidebar.options.exceptDefaultHint', 'Keep the default branch visible while hiding sleeping workspaces') }}</span>
          </div>
          <input v-model="settings.alwaysShowDefaultBranchWorkspace" type="checkbox" class="set-switch" data-setting="alwaysShowDefaultBranchWorkspace" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('sidebar.options.hideDefault', 'Hide default branch') }}
            <span class="set-hint">{{ t('settings.appearance.hideDefaultHint', 'Hide the workspace of each project that is on its default branch.') }}</span>
          </div>
          <input v-model="settings.hideDefaultBranchWorkspace" type="checkbox" class="set-switch" data-setting="hideDefaultBranchWorkspace" />
        </label>
      </div>
    </div>
  </section>
</template>
