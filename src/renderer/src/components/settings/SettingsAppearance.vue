<script setup>
// Settings > Appearance: the interface (language, theme, file icons, zoom),
// the panes, the left sidebar and the status bar. The usage menu's settings
// are on Stats & Usage, the Files panel's on Editor, the terminal padding on
// Terminal.
import { computed } from 'vue'
import ThemedSelect from '../ui/ThemedSelect.vue'
import { t, UI_LANGUAGES, intlLocale } from '../../i18n'
import { settings, clamp, MAX_LEFT_SIDEBAR_TINT_OPACITY, LIMITS } from '../../settings'
import { THEMES } from '../../themes'
import { uiZoomPercent, stepUiZoom } from '../../appearance'
import { PAGES } from './settingsPages'
import { setNumber, setRange } from './settingsFields'
import { useSettingsShell } from './settingsShell'

const { shown } = useSettingsShell()

// Settings > Appearance > Left sidebar: the left sidebar's view options, the
// same as its Options menu (WorkspaceSidebar.vue).
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
    description: t('settings.appearance.statusPortsHint', 'Show live workspace ports. Click it for every port and external listener.')
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
// A 0-1 setting shown as a percentage beside its slider, in the interface's language.
const percent = (v) => new Intl.NumberFormat(intlLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(v)

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
      <h3 class="set-group-title">{{ t('settings.appearance.interface', 'Interface') }}</h3>
      <p class="set-group-desc">{{ t('settings.appearance.interfaceDesc', 'The language, colors and size of the whole app.') }}</p>
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
            <span class="set-hint">{{ t('settings.appearance.fileIconsHint', "VS Code's icons in Files, the editor's tabs, Source Control and Go to file.") }}</span>
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
      <h3 class="set-group-title">{{ t('settings.appearance.panes', 'Panes') }}</h3>
      <p class="set-group-desc">{{ t('settings.appearance.panesDesc', 'How the panes of a workspace look side by side.') }}</p>
      <div class="set-card">
        <div class="set-row">
          <label class="set-label" for="settings-inactive-opacity">
            {{ t('settings.appearance.inactiveOpacity', 'Inactive pane opacity') }}
            <span class="set-hint">{{ t('settings.appearance.inactiveOpacityHint', 'Dims the panes you are not working in.') }}</span>
          </label>
          <div class="set-inline">
            <input
              id="settings-inactive-opacity"
              class="set-range"
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="settings.inactivePaneOpacity"
              @input="setRange('inactivePaneOpacity', $event)"
            />
            <output class="set-range-value" for="settings-inactive-opacity">{{ percent(settings.inactivePaneOpacity) }}</output>
          </div>
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-divider">
            {{ t('settings.appearance.divider', 'Divider thickness') }}
            <span class="set-hint">{{ t('settings.appearance.dividerHint', 'The line between two panes.') }}</span>
          </label>
          <div class="set-inline">
            <input
              id="settings-divider"
              class="set-range"
              type="range"
              :min="LIMITS.dividerThickness[0]"
              :max="LIMITS.dividerThickness[1]"
              step="1"
              :value="settings.dividerThickness"
              @input="setNumber('dividerThickness', $event, true)"
            />
            <output class="set-range-value" for="settings-divider">{{ settings.dividerThickness }} px</output>
          </div>
        </div>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.appearance.leftSidebar', 'Left sidebar') }}</h3>
      <p class="set-group-desc">{{ t('settings.appearance.leftSidebarDesc', 'The list of workspaces: its look, its order and what each card shows.') }}</p>
      <div class="set-card">
        <!-- Orca's Appearance > Window & Sidebar. -->
        <div class="set-row">
          <div id="settings-sidebar-appearance-label" class="set-label">
            {{ t('settings.appearance.sidebar', 'Left sidebar appearance') }}
            <span class="set-hint">{{ t('settings.appearance.sidebarHint', 'Like your terminal, the default, or with a tint.') }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-sidebar-appearance-label">
            <button
              v-for="m in SIDEBAR_APPEARANCES"
              :key="m.id"
              type="button"
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
          <label class="set-row set-row-nested">
            <div class="set-label">
              {{ t('settings.appearance.tint', 'Sidebar tint') }}
              <span class="set-hint">{{ t('settings.appearance.tintHint', 'The color mixed into the left sidebar surface.') }}</span>
            </div>
            <input v-model="settings.leftSidebarTintColor" type="color" class="set-color" :aria-label="t('settings.appearance.tint', 'Sidebar tint')" />
          </label>
          <div class="set-row set-row-nested">
            <label class="set-label" for="settings-tint-strength">
              {{ t('settings.appearance.tintStrength', 'Tint strength') }}
              <span class="set-hint">{{ t('settings.appearance.tintStrengthHint', 'How strongly the tint is mixed into the sidebar.') }}</span>
            </label>
            <div class="set-inline">
              <input
                id="settings-tint-strength"
                type="range"
                class="set-range"
                min="0"
                :max="MAX_LEFT_SIDEBAR_TINT_OPACITY"
                step="0.01"
                :value="settings.leftSidebarTintOpacity"
                @input="setTintOpacity"
              />
              <output class="set-range-value" for="settings-tint-strength">{{ percent(settings.leftSidebarTintOpacity) }}</output>
            </div>
          </div>
        </template>
        <div class="set-row">
          <div id="settings-card-layout-label" class="set-label">
            {{ t('settings.appearance.cardLayout', 'Workspace card layout') }}
            <span class="set-hint">{{ t('settings.appearance.cardLayoutHint', 'A compact card shows its details on hover.') }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-card-layout-label">
            <button
              type="button"
              class="launch-seg-btn"
              :class="{ on: !settings.compactWorktreeCards }"
              :aria-pressed="!settings.compactWorktreeCards"
              @click="settings.compactWorktreeCards = false"
            >
              {{ t('settings.appearance.detailed', 'Detailed') }}
            </button>
            <button
              type="button"
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
          <div id="settings-card-properties-label" class="set-label">
            {{ t('sidebar.options.showProperties', 'Show properties') }}
            <span class="set-hint">{{ t('settings.appearance.cardPropertiesHint', 'What a detailed workspace card shows.') }}</span>
          </div>
          <div class="set-chips" role="group" aria-labelledby="settings-card-properties-label">
            <button
              v-for="p in CARD_PROPERTIES"
              :key="p.id"
              type="button"
              class="chip"
              :class="{ on: settings.worktreeCardProperties.includes(p.id) }"
              :aria-pressed="settings.worktreeCardProperties.includes(p.id)"
              :data-card-property="p.id"
              @click="toggleCardProperty(p.id)"
            >
              {{ p.label }}
            </button>
          </div>
        </div>
        <div class="set-row">
          <div id="settings-agent-activity-label" class="set-label">
            {{ t('sidebar.options.agentActivityLayout', 'Agent activity layout') }}
            <span class="set-hint">{{ t('settings.appearance.agentActivityHint', 'The agents under a card: one compact line, or the full list.') }}</span>
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
        <div class="set-row">
          <div id="settings-sidebar-group-label" class="set-label">
            {{ t('sidebar.options.groupBy', 'Group by') }}
            <span class="set-hint">{{ t('settings.appearance.groupByHint', 'Under their project, or in one list.') }}</span>
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
        <div v-if="settings.sidebarGroupBy === 'repo'" class="set-row set-row-nested">
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
          <label class="set-label" for="settings-sidebar-sort">
            {{ t('sidebar.options.sortBy', 'Sort by') }}
            <span class="set-hint">{{ t('settings.appearance.sortByHint', 'The order of the workspaces in the left sidebar.') }}</span>
          </label>
          <ThemedSelect id="settings-sidebar-sort" v-model="settings.sidebarSortBy" class="set-select" data-setting="sidebarSortBy">
            <option v-for="o in SIDEBAR_SORT_OPTIONS" :key="o.id" :value="o.id">{{ o.label }}</option>
          </ThemedSelect>
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
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.appearance.statusBar', 'Status bar') }}</h3>
      <p class="set-group-desc">{{ t('settings.appearance.statusBarDesc', 'The bar at the bottom of the window, and the indicators it shows.') }}</p>
      <div class="set-card">
        <label class="set-row">
          <div class="set-label">{{ t('settings.appearance.statusBarVisible', 'Show status bar') }}</div>
          <input v-model="settings.statusBarVisible" type="checkbox" class="set-switch" data-setting="statusBarVisible" />
        </label>
        <label
          v-for="item in STATUS_BAR_TOGGLES"
          :key="item.id"
          class="set-row set-row-nested"
          :class="{ 'set-disabled': !settings.statusBarVisible }"
        >
          <div class="set-label">
            {{ item.title }}
            <span class="set-hint">{{ item.description }}</span>
          </div>
          <input
            type="checkbox"
            class="set-switch"
            :data-status-item="item.id"
            :checked="settings.statusBarItems.includes(item.id)"
            :disabled="!settings.statusBarVisible"
            :aria-label="item.title"
            @change="toggleStatusBarItem(item.id)"
          />
        </label>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* The status bar's indicators and the tint: lighter rows under their switch. */
.set-card .set-row.set-row-nested {
  min-height: 48px;
}
</style>
