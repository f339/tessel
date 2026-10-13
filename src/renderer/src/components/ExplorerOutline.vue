<script setup>
// VS Code's Outline (outlinePane.ts, outlineActions.ts) at the bottom of the
// explorer: the symbols of the file in the editor in use, from the language
// services (editor/outline.js). A click shows a symbol in the editor; Follow
// Cursor selects the symbol around the cursor; Filter on Type keeps the
// symbols matching what is typed; sorted by position, name or category.
import { ref, reactive, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { settings } from '../settings'
import { t } from '../i18n'
import { activeEditor, activeMonacoEditor, revealRange } from '../editor/activeEditor'
import { outlineIfLoaded } from '../editor/loadMonaco'
import { symbolIcon } from '../editor/symbolKinds'
import { keyed, sortSymbols, symbolPathAt, parentKeys, allCollapsed, outlineRows, highlightParts, symbolKindName, OUTLINE_SORTS } from '../explorer/outlineTree'
import { rowPadding, guideX, INDENT, ROW_HEIGHT } from '../explorerRows'
import { usePaneResize } from '../explorer/paneResize'
import Codicon from './Codicon.vue'

const props = defineProps({
  // The project's folder is folded: this section takes the room left.
  fill: { type: Boolean, default: false }
})

const shown = computed(() => settings.explorerOutlineShown === true)
function toggleShown() {
  settings.explorerOutlineShown = !shown.value
}
const sectionEl = ref(null)
const { height, startResize } = usePaneResize({ key: 'explorerOutlineHeight', sectionEl })

// --- The symbols -----------------------------------------------------------------------
const followCursor = computed(() => settings.explorerOutlineFollowCursor !== false)
const filterOnType = computed(() => settings.explorerOutlineFilterOnType !== false)
const sortBy = computed(() => (OUTLINE_SORTS.includes(settings.explorerOutlineSortBy) ? settings.explorerOutlineSortBy : 'position'))

const state = reactive({ status: 'none', file: '', path: null, symbols: [] })
const fileName = (p) => String(p || '').split(/[\\/]/).pop()
let seq = 0
let loadingTimer = 0
let stopProviders = null
async function load() {
  const my = ++seq
  clearTimeout(loadingTimer)
  if (!shown.value) return
  const path = activeEditor.path
  const ed = activeMonacoEditor()
  const ol = outlineIfLoaded()
  const model = ed && ed.getModel ? ed.getModel() : null
  // A language registered later: asked again then.
  if (ol && ol.onSymbolProvidersChanged && !stopProviders) stopProviders = ol.onSymbolProvidersChanged(() => scheduleLoad(50))
  if (!path || !model || !ol || !ol.canGiveSymbols(model)) {
    Object.assign(state, { status: 'none', file: path ? fileName(path) : '', path, symbols: [] })
    return
  }
  const sameFile = state.path === path && state.status === 'ok'
  // VS Code: "Loading document symbols for '…'..." after 100 ms (a file
  // read again keeps its symbols until the new ones come).
  if (!sameFile) loadingTimer = setTimeout(() => my === seq && Object.assign(state, { status: 'loading', file: fileName(path), path, symbols: [] }), 100)
  const tree = await ol.documentSymbols(model).catch(() => null)
  if (my !== seq) return
  clearTimeout(loadingTimer)
  if (!tree) Object.assign(state, { status: 'none', file: fileName(path), path, symbols: [] })
  else Object.assign(state, { status: tree.length ? 'ok' : 'empty', file: fileName(path), path, symbols: keyed(tree) })
  nextTick(revealCursor)
}
let loadTimer = 0
function scheduleLoad(ms = 150) {
  clearTimeout(loadTimer)
  loadTimer = setTimeout(load, ms)
}
const sorted = computed(() => sortSymbols(state.symbols, sortBy.value))

// --- Folding (VS Code's outline: all unfolded at first) ----------------------------------
const collapsed = ref(new Set())
const foldsByFile = new Map()
function saveFolds(path) {
  if (path) foldsByFile.set(String(path).toLowerCase(), collapsed.value)
}
function restoreFolds(path) {
  collapsed.value = (path && foldsByFile.get(String(path).toLowerCase())) || new Set()
  selectedKey.value = null
}
function setFold(key, fold) {
  const next = new Set(collapsed.value)
  if (fold) next.add(key)
  else next.delete(key)
  collapsed.value = next
}
const everyCollapsed = computed(() => state.status === 'ok' && allCollapsed(sorted.value, collapsed.value))
function collapseAll() {
  collapsed.value = new Set(parentKeys(sorted.value))
}
function expandAll() {
  collapsed.value = new Set()
}

// --- Filter on Type (VS Code's tree find: filter, or highlight when off) ----------------
const filter = reactive({ open: false, text: '' })
const filterEl = ref(null)
const query = computed(() => (filter.open ? filter.text.trim() : ''))
function openFilter(initial = '') {
  filter.open = true
  filter.text += initial
  nextTick(() => filterEl.value && filterEl.value.focus())
}
function closeFilter() {
  filter.open = false
  filter.text = ''
}
function closeFilterAndFocus() {
  closeFilter()
  nextTick(() => treeEl.value && treeEl.value.focus())
}

const rows = computed(() => outlineRows(sorted.value, { collapsed: collapsed.value, query: query.value, highlight: !filterOnType.value }))
const noMatch = computed(() => !!query.value && !rows.value.some((r) => r.matches && r.matches.length))
const message = computed(() => {
  if (state.status === 'none') return t('explorer.outline.noEditor', 'The active editor cannot provide outline information.')
  if (state.status === 'loading') return t('explorer.outline.loading', "Loading document symbols for '{{file}}'...", { file: state.file })
  if (state.status === 'empty') return t('explorer.outline.noSymbols', "No symbols found in document '{{file}}'", { file: state.file })
  return ''
})

// --- Selection, Follow Cursor ---------------------------------------------------------------
const selectedKey = ref(null)
const treeEl = ref(null)
function scrollToKey(key) {
  nextTick(() => {
    const el = treeEl.value
    if (!el || !key) return
    const i = rows.value.findIndex((r) => r.key === key)
    if (i < 0) return
    const top = i * ROW_HEIGHT
    // VS Code reveals it in the middle when it was out of view.
    if (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 2 + ROW_HEIGHT / 2)
  })
}
function revealCursor() {
  if (!followCursor.value || state.status !== 'ok' || query.value) return
  const path = symbolPathAt(sorted.value, activeEditor.line, activeEditor.column)
  if (!path.length) return
  const deepest = path[path.length - 1]
  // Its parents unfold so it shows.
  if (path.slice(0, -1).some((k) => collapsed.value.has(k))) {
    const next = new Set(collapsed.value)
    for (const k of path.slice(0, -1)) next.delete(k)
    collapsed.value = next
  }
  if (selectedKey.value !== deepest) {
    selectedKey.value = deepest
    scrollToKey(deepest)
  }
}
watch(() => [activeEditor.line, activeEditor.column], revealCursor)
watch(followCursor, (on) => on && revealCursor())

// A click shows the symbol in the editor, the cursor on its name (the
// keyboard stays here); a double-click selects all of it in the editor and
// goes there (VS Code's outline).
function onRowClick(row) {
  selectedKey.value = row.key
  revealRange(row.symbol.selectionRange || row.symbol.range, { focus: false })
}
function onRowDblClick(row) {
  selectedKey.value = row.key
  revealRange(row.symbol.range, { focus: true, select: true })
}
function toggleRow(row) {
  if (row.hasChildren) setFold(row.key, row.open)
}

// --- Keyboard: arrows, Enter, typing filters ---------------------------------------------
function selectAt(i) {
  const list = rows.value
  if (!list.length) return
  const row = list[Math.max(0, Math.min(list.length - 1, i))]
  selectedKey.value = row.key
  scrollToKey(row.key)
}
function onTreeKey(ev) {
  const list = rows.value
  const cur = list.findIndex((r) => r.key === selectedKey.value)
  const row = cur >= 0 ? list[cur] : null
  const k = ev.key
  let done = true
  if (k === 'ArrowDown') selectAt(row ? cur + 1 : 0)
  else if (k === 'ArrowUp') selectAt(row ? cur - 1 : list.length - 1)
  else if (k === 'Home') selectAt(0)
  else if (k === 'End') selectAt(list.length - 1)
  else if (k === 'ArrowRight' && row) {
    if (row.hasChildren && !row.open) setFold(row.key, false)
    else if (row.hasChildren) selectAt(cur + 1)
  } else if (k === 'ArrowLeft' && row) {
    if (row.hasChildren && row.open && !query.value) setFold(row.key, true)
    else if (row.parent) {
      selectedKey.value = row.parent
      scrollToKey(row.parent)
    }
  } else if (k === 'Enter' && row) onRowClick(row)
  else if (k === 'Escape' && filter.open) closeFilter()
  else if (k.length === 1 && k !== ' ' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) openFilter(k)
  else done = false
  if (done) ev.preventDefault()
}
function onFilterKey(ev) {
  if (ev.key === 'Escape') {
    ev.preventDefault()
    ev.stopPropagation()
    closeFilterAndFocus()
  } else if (ev.key === 'ArrowDown') {
    ev.preventDefault()
    selectAt(0)
    treeEl.value && treeEl.value.focus()
  } else if (ev.key === 'Backspace' && !filter.text) closeFilterAndFocus()
}

// --- The header's "More Actions..." menu ---------------------------------------------------
const menu = reactive({ open: false, x: 0, y: 0 })
const menuEl = ref(null)
function openMenu(ev) {
  const r = ev.currentTarget.getBoundingClientRect()
  menu.x = r.right
  menu.y = r.bottom + 2
  menu.open = true
  nextTick(() => {
    const el = menuEl.value
    if (!el) return
    const w = el.getBoundingClientRect().width
    menu.x = Math.max(4, Math.min(r.right - w, window.innerWidth - w - 4))
    const h = el.getBoundingClientRect().height
    if (menu.y + h > window.innerHeight - 4) menu.y = Math.max(4, r.top - h - 2)
    el.focus()
  })
}
function closeMenu() {
  menu.open = false
}
function pick(what) {
  closeMenu()
  if (what === 'follow') settings.explorerOutlineFollowCursor = !followCursor.value
  else if (what === 'filter') settings.explorerOutlineFilterOnType = !filterOnType.value
  else if (OUTLINE_SORTS.includes(what)) settings.explorerOutlineSortBy = what
}

const iconOf = (row) => symbolIcon(row.symbol.kind)
const rowTitle = (row) => t('explorer.outline.rowTitle', '{{name}} ({{kind}})', { name: row.symbol.name, kind: symbolKindName(row.symbol.kind) })

// The editor in use, its text or this section changed: its symbols read again.
watch(
  () => [activeEditor.path, activeEditor.version, shown.value],
  ([path], old) => {
    // Another file: what was folded there is kept, this one's comes back.
    if (!old || old[0] !== path) {
      saveFolds(old && old[0])
      restoreFolds(path)
      closeFilter()
    }
    scheduleLoad(old && old[0] !== path ? 0 : 150)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  seq++
  clearTimeout(loadTimer)
  clearTimeout(loadingTimer)
  if (stopProviders) stopProviders()
})
</script>

<template>
  <section ref="sectionEl" class="explorer-section explorer-pane explorer-outline" :class="{ expanded: shown, fill: shown && props.fill }" :style="shown && !props.fill ? { height: height + 28 + 'px' } : null" data-test="outline">
    <div v-if="shown && !props.fill" class="explorer-sash" aria-hidden="true" data-test="outline-sash" @pointerdown="startResize"></div>
    <div
      class="explorer-section-head explorer-pane-head"
      role="button"
      tabindex="0"
      :aria-expanded="shown"
      data-test="outline-head"
      @click="toggleShown"
      @keydown.self.enter.prevent="toggleShown"
      @keydown.self.space.prevent="toggleShown"
    >
      <span class="explorer-twistie" :class="{ open: shown }" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z" /></svg></span>
      <span class="explorer-section-title">{{ t('explorer.outline.title', 'Outline') }}</span>
      <span v-if="shown" class="explorer-actions" @click.stop>
        <button
          v-if="everyCollapsed"
          class="tb-icon"
          :title="t('explorer.outline.expandAll', 'Expand All')"
          :aria-label="t('explorer.outline.expandAll', 'Expand All')"
          data-test="outline-expand-all"
          @click="expandAll"
        >
          <Codicon name="expand-all" />
        </button>
        <button
          v-else
          class="tb-icon"
          :title="t('explorer.outline.collapseAll', 'Collapse All')"
          :aria-label="t('explorer.outline.collapseAll', 'Collapse All')"
          data-test="outline-collapse-all"
          :disabled="state.status !== 'ok'"
          @click="collapseAll"
        >
          <Codicon name="collapse-all" />
        </button>
        <button
          class="tb-icon"
          :class="{ open: menu.open }"
          :title="t('explorer.moreActions', 'More Actions...')"
          :aria-label="t('explorer.moreActions', 'More Actions...')"
          aria-haspopup="menu"
          :aria-expanded="menu.open"
          data-test="outline-more"
          @click="openMenu"
        >
          <Codicon name="ellipsis" />
        </button>
      </span>
    </div>
    <div v-if="shown" class="explorer-pane-body">
      <div v-if="message" class="explorer-pane-message" data-test="outline-message">{{ message }}</div>
      <template v-else>
        <div v-if="filter.open" class="explorer-find" data-test="outline-find">
          <input
            ref="filterEl"
            v-model="filter.text"
            class="explorer-find-input"
            :class="{ 'no-match': noMatch }"
            :placeholder="filterOnType ? t('explorer.outline.typeToFilter', 'Type to filter') : t('explorer.outline.typeToSearch', 'Type to search')"
            :aria-label="filterOnType ? t('explorer.outline.typeToFilter', 'Type to filter') : t('explorer.outline.typeToSearch', 'Type to search')"
            spellcheck="false"
            data-test="outline-find-input"
            @keydown="onFilterKey"
          />
          <button class="tb-icon explorer-find-close" :title="t('explorer.outline.closeFind', 'Close')" :aria-label="t('explorer.outline.closeFind', 'Close')" @click="closeFilterAndFocus">
            <Codicon name="close" />
          </button>
          <div v-if="noMatch" class="explorer-find-message" role="status">{{ t('explorer.outline.noResults', 'No results found.') }}</div>
        </div>
        <div ref="treeEl" class="explorer-pane-tree" role="tree" tabindex="0" :aria-label="t('explorer.outline.title', 'Outline')" data-test="outline-tree" @keydown="onTreeKey">
          <div
            v-for="row in rows"
            :key="row.key"
            class="explorer-row outline-row"
            :class="{ selected: selectedKey === row.key, open: row.open, deprecated: row.symbol.deprecated }"
            role="treeitem"
            :aria-level="row.depth + 1"
            :aria-expanded="row.hasChildren ? row.open : undefined"
            :aria-selected="selectedKey === row.key"
            :style="{ paddingLeft: rowPadding(row.depth) + 'px' }"
            :title="rowTitle(row)"
            :data-key="row.key"
            data-test="outline-row"
            @click="onRowClick(row)"
            @dblclick="onRowDblClick(row)"
          >
            <span v-if="row.depth" class="explorer-guides" aria-hidden="true" :style="{ left: guideX(0) + 'px', width: row.depth * INDENT + 'px' }"></span>
            <span class="explorer-twistie" aria-hidden="true" data-test="outline-twistie" @click.stop="toggleRow(row)"><svg v-if="row.hasChildren" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z" /></svg></span>
            <Codicon class="outline-icon" :name="iconOf(row).name" :style="iconOf(row).color ? { color: iconOf(row).color } : null" :data-kind="row.symbol.kind" />
            <span class="explorer-name outline-name"><span v-for="(p, i) in highlightParts(row.symbol.name, row.matches)" :key="i" :class="{ 'outline-hit': p.hit }">{{ p.text }}</span></span>
            <span v-if="row.symbol.detail" class="open-editor-folder outline-detail">{{ row.symbol.detail }}</span>
          </div>
        </div>
      </template>
    </div>

    <div v-if="menu.open" class="explorer-menu-back" @mousedown.self="closeMenu" @contextmenu.prevent="closeMenu">
      <div ref="menuEl" class="ctx-menu explorer-menu explorer-pane-menu" role="menu" tabindex="-1" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @keydown.escape="closeMenu">
        <button role="menuitemcheckbox" class="ctx-menu-item" :aria-checked="followCursor" data-test="outline-follow" @click="pick('follow')">
          <span class="explorer-pane-check"><Codicon v-if="followCursor" name="check" /></span>{{ t('explorer.outline.followCursor', 'Follow Cursor') }}
        </button>
        <button role="menuitemcheckbox" class="ctx-menu-item" :aria-checked="filterOnType" data-test="outline-filter-on-type" @click="pick('filter')">
          <span class="explorer-pane-check"><Codicon v-if="filterOnType" name="check" /></span>{{ t('explorer.outline.filterOnType', 'Filter on Type') }}
        </button>
        <div class="ctx-menu-sep"></div>
        <button role="menuitemradio" class="ctx-menu-item" :aria-checked="sortBy === 'position'" data-test="outline-sort-position" @click="pick('position')">
          <span class="explorer-pane-check"><Codicon v-if="sortBy === 'position'" name="check" /></span>{{ t('explorer.outline.sortByPosition', 'Sort By: Position') }}
        </button>
        <button role="menuitemradio" class="ctx-menu-item" :aria-checked="sortBy === 'name'" data-test="outline-sort-name" @click="pick('name')">
          <span class="explorer-pane-check"><Codicon v-if="sortBy === 'name'" name="check" /></span>{{ t('explorer.outline.sortByName', 'Sort By: Name') }}
        </button>
        <button role="menuitemradio" class="ctx-menu-item" :aria-checked="sortBy === 'kind'" data-test="outline-sort-kind" @click="pick('kind')">
          <span class="explorer-pane-check"><Codicon v-if="sortBy === 'kind'" name="check" /></span>{{ t('explorer.outline.sortByKind', 'Sort By: Category') }}
        </button>
      </div>
    </div>
  </section>
</template>
