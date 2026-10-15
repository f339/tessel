<script setup>
// Agent skills (a folder with a SKILL.md), for every agent CLI that reads
// them, in one place, like the MCP servers window:
//   Installed - each skill with its copies: which agents see it, all projects
//               or this project, where it is; open its folder, update one
//               added from GitHub, remove it (Recycle Bin or delete).
//   Add       - from a GitHub repository or a folder. The SKILL.md and every
//               file are shown first; then it is copied into the skill folder
//               of each chosen agent. Nothing from a skill is ever run: a
//               setup command it mentions is only offered, in a pane the
//               user sees.
// The work is done in the main process (src/main/skillsManager.js).
import { ref, reactive, computed, onMounted, inject } from 'vue'
import BrandIcon from './BrandIcon.vue'
import { t, intlLocale } from '../i18n'
import { isRemotePath } from '../../../shared/remotePath'

const props = defineProps({
  cwd: { type: String, default: null }, // current workspace's project folder
  agents: { type: Array, default: () => [] },
  // Shown as a Settings page: no backdrop, card, title bar or Escape to close.
  embedded: { type: Boolean, default: false }
})
const emit = defineEmits(['close', 'run'])

// The agents that read skills (same ids as Settings > Agents).
const ALL_AGENTS = ['claude', 'codex', 'opencode', 'copilot', 'gemini', 'antigravity']
const AGENT_NAME = {
  claude: 'Claude Code', // i18n-ignore
  codex: 'Codex', // i18n-ignore
  opencode: 'OpenCode', // i18n-ignore
  copilot: 'Copilot CLI', // i18n-ignore
  gemini: 'Gemini CLI', // i18n-ignore
  antigravity: 'Antigravity CLI' // i18n-ignore
}
const installed = computed(() =>
  Object.fromEntries(ALL_AGENTS.map((id) => [id, !!props.agents.find((a) => a.id === id && a.available)]))
)
// Installed here, and Claude Code and Codex always (the dialog is never empty).
const AGENTS = computed(() => ALL_AGENTS.filter((a) => installed.value[a] || a === 'claude' || a === 'codex'))
// A remote project (ssh://…) has no skill folders on this computer.
const project = computed(() => (props.cwd && !isRemotePath(props.cwd) ? props.cwd : null))

function agentList(names) {
  try {
    return new Intl.ListFormat(intlLocale(), { type: 'conjunction' }).format(names)
  } catch {
    return names.join(', ')
  }
}
const scopeLabel = (scope) =>
  scope === 'project' ? t('skills.scope.project', 'This project') : t('skills.scope.user', 'All projects')
function managedLabel(reason) {
  if (reason === 'synced') return t('skills.managed.synced', 'Synced from your Claude account')
  if (reason === 'system') return t('skills.managed.system', 'Built into the agent')
  return t('skills.managed.nested', 'Managed by the agent')
}
function size(bytes) {
  const n = Number(bytes) || 0
  const fmt = (v) => v.toLocaleString(intlLocale(), { maximumFractionDigits: 1 })
  if (n < 1024) return t('skills.size.bytes', '{{n}} B', { n: fmt(n) })
  if (n < 1024 * 1024) return t('skills.size.kb', '{{n}} KB', { n: fmt(n / 1024) })
  return t('skills.size.mb', '{{n}} MB', { n: fmt(n / 1024 / 1024) })
}
const seenByLabel = (copy) =>
  t('skills.installed.seenBy', 'Seen by {{agents}}', {
    agents: agentList(copy.seenBy.filter((a) => AGENTS.value.includes(a)).map((a) => AGENT_NAME[a]))
  })
const sourceLabel = (source) =>
  source.kind === 'github'
    ? t('skills.source.github', 'From GitHub: {{repo}}', { repo: `${source.owner}/${source.repo}${source.path ? '/' + source.path : ''}` }) // i18n-ignore path
    : t('skills.source.folder', 'From a folder: {{path}}', { path: source.path })
const skillsLabel = (count) =>
  count === 1
    ? t('skills.installed.count', '{{count}} skill', { count })
    : t('skills.installed.count', '{{count}} skills', { count })
const filesLabel = (pkg) =>
  pkg.files.length === 1
    ? t('skills.preview.files', '{{count}} file, {{size}}', { count: 1, size: size(pkg.totalBytes) })
    : t('skills.preview.files', '{{count}} files, {{size}}', { count: pkg.files.length, size: size(pkg.totalBytes) })
const scriptsLabel = (pkg) =>
  t('skills.preview.scripts', 'It includes scripts or programs ({{names}}). Tessel never runs them, but an agent using the skill may.', {
    names: pkg.scripts.slice(0, 5).join(', ') + (pkg.scripts.length > 5 ? '…' : '')
  })
const installLabel = (pkg) =>
  updating.value ? t('skills.preview.update', 'Update {{name}}', { name: pkg.name }) : t('skills.preview.install', 'Install {{name}}', { name: pkg.name })

const cardEl = ref(null)
const tab = ref('installed')
const message = reactive({ text: '', kind: 'ok' })
const busy = ref('')
function say(text, kind = 'ok') {
  message.text = text
  message.kind = kind
}
const askConfirm = inject('askConfirm', (o) => Promise.resolve(window.confirm(o.title)))

// ---------------------------------------------------------------- Installed
const loading = ref(true)
const listed = ref({ skills: [], roots: [] })
const query = ref('')

async function refresh() {
  loading.value = true
  try {
    const res = await window.shellApi.skillsList(project.value)
    if (res && res.ok === false) say(res.error, 'error')
    else listed.value = { skills: (res && res.skills) || [], roots: (res && res.roots) || [] }
  } catch (err) {
    say((err && err.message) || String(err), 'error')
  } finally {
    loading.value = false
  }
}

// One row per skill name, with each copy (one per folder it is in).
const rows = computed(() => {
  const q = query.value.trim().toLowerCase()
  const map = new Map()
  for (const s of listed.value.skills) {
    if (q && !`${s.name} ${s.description || ''}`.toLowerCase().includes(q)) continue
    if (!map.has(s.name)) map.set(s.name, { name: s.name, description: s.description, copies: [] })
    const row = map.get(s.name)
    if (!row.description && s.description) row.description = s.description
    row.copies.push(s)
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
})

async function openFolder(copy) {
  const res = await window.shellApi.skillsOpen({ dir: copy.dir, cwd: project.value })
  if (res && res.ok === false) say(res.error, 'error')
}

async function remove(copy) {
  const answer = await askConfirm({
    title: t('skills.remove.confirm', 'Remove the skill "{{name}}"?', { name: copy.name }),
    text: t('skills.remove.text', '{{agents}} will no longer have it. Running agents notice at their next session.', {
      agents: agentList(copy.seenBy.filter((a) => AGENTS.value.includes(a)).map((a) => AGENT_NAME[a]))
    }),
    code: copy.dir,
    confirmLabel: t('skills.remove.trash', 'Move to the Recycle Bin'),
    altLabel: t('skills.remove.delete', 'Delete permanently'),
    danger: true
  })
  if (!answer) return
  let mode = 'trash'
  if (answer === 'alt') {
    const sure = await askConfirm({
      title: t('skills.remove.sure', 'Delete "{{name}}" permanently?', { name: copy.name }),
      text: t('skills.remove.sureText', 'Its folder and every file in it are deleted. This cannot be undone.'),
      code: copy.dir,
      confirmLabel: t('skills.remove.delete', 'Delete permanently'),
      danger: true
    })
    if (sure !== true) return
    mode = 'delete'
  }
  busy.value = `rm:${copy.dir}` // i18n-ignore
  try {
    const res = await window.shellApi.skillsRemove({ dir: copy.dir, mode, cwd: project.value })
    if (res && res.ok) say(mode === 'delete' ? t('skills.remove.deleted', 'Deleted "{{name}}".', { name: copy.name }) : t('skills.remove.trashed', 'Moved "{{name}}" to the Recycle Bin.', { name: copy.name }))
    else say((res && res.error) || t('skills.remove.failed', 'It could not be removed.'), 'error')
  } finally {
    busy.value = ''
  }
  refresh()
}

// Update: the same source again, shown in the Add tab before it replaces it.
const updating = ref(null) // the copy being updated
async function update(copy) {
  resetAdd()
  updating.value = copy
  tab.value = 'add'
  busy.value = 'look'
  try {
    const res = await window.shellApi.skillsForUpdate(copy.dir)
    if (res && res.ok === false) addError.value = res.error
    else preview.value = res
  } finally {
    busy.value = ''
  }
}

// ---------------------------------------------------------------- Add
const from = ref('github') // 'github' | 'folder'
const repoInput = ref('')
const candidates = ref(null) // { repo, candidates: [...] }
const preview = ref(null) // the package shown before installing
const addError = ref('')
const results = ref(null)
const targets = reactive(Object.fromEntries(ALL_AGENTS.map((a) => [a, false])))
const scope = ref('user')

function resetAdd() {
  candidates.value = null
  preview.value = null
  addError.value = ''
  results.value = null
  updating.value = null
  for (const a of ALL_AGENTS) targets[a] = installed.value[a] || (a === 'claude' && !ALL_AGENTS.some((x) => installed.value[x]))
}

async function lookUp(pick = null) {
  const input = repoInput.value.trim()
  if (!input) return
  if (pick == null) resetAdd()
  else {
    addError.value = ''
    results.value = null
  }
  busy.value = 'look'
  try {
    const res = await window.shellApi.skillsFromGithub({ input, pick })
    if (res && res.ok === false) addError.value = res.error
    else if (res && res.candidates) candidates.value = res
    else preview.value = res
  } finally {
    busy.value = ''
  }
}

async function chooseFolder() {
  const dir = await window.shellApi.pickFolder({
    title: t('skills.add.pickTitle', 'Choose a skill folder (with a SKILL.md)'),
    defaultPath: project.value || undefined
  })
  if (!dir) return
  resetAdd()
  busy.value = 'look'
  try {
    const res = await window.shellApi.skillsFromFolder(dir)
    if (res && res.ok === false) addError.value = res.error
    else preview.value = res
  } finally {
    busy.value = ''
  }
}

const chosenAgents = computed(() => AGENTS.value.filter((a) => targets[a]))

async function install(replaceDir = null) {
  if (!preview.value) return
  addError.value = ''
  const replace = replaceDir || (updating.value && updating.value.dir) || null
  if (!replace && !chosenAgents.value.length) {
    addError.value = t('skills.add.chooseAgent', 'Choose at least one agent.')
    return
  }
  busy.value = 'install'
  try {
    const res = await window.shellApi.skillsInstall({
      id: preview.value.id,
      agents: chosenAgents.value,
      scope: scope.value,
      cwd: project.value,
      replace
    })
    if (res && res.ok === false && !res.results) {
      addError.value = res.error
      return
    }
    results.value = res.results
    const done = res.results.filter((r) => r.ok)
    if (done.length)
      say(
        replace
          ? t('skills.add.updated', 'Updated "{{name}}". Agents use it from their next session.', { name: res.name })
          : t('skills.add.installed', 'Installed "{{name}}" for {{agents}}. Agents use it from their next session.', {
              name: res.name,
              agents: agentList([...new Set(done.flatMap((r) => r.seenBy))].filter((a) => AGENTS.value.includes(a)).map((a) => AGENT_NAME[a]))
            })
      )
    if (res.ok && replace) updating.value = null
  } finally {
    busy.value = ''
  }
  refresh()
}

// A setup command the skill mentions: shown exactly, run only when asked, in
// a pane the user sees (it may ask questions).
async function runSetup(command) {
  const ok = await askConfirm({
    title: t('skills.setup.confirm', "Run this skill's setup in a terminal?"),
    text: t('skills.setup.confirmText', "It downloads and runs a program from npm. Run it only if you trust the skill's author. Answer its questions in the terminal."),
    code: command,
    confirmLabel: t('skills.setup.run', 'Run in a terminal')
  })
  if (ok !== true) return
  emit('run', { label: t('skills.setup.pane', 'Skill setup: {{name}}', { name: preview.value ? preview.value.name : '' }), command })
}

// ---------------------------------------------------------------- Plugins
// The Antigravity CLI's plugins (bundles of skills, MCP servers, hooks and
// rules): listed, turned on or off and uninstalled with agy's own commands
// (src/main/agyPlugins.js). Installing one can ask questions (a plugin's
// settings form): it runs in a pane the user sees.
const showPlugins = computed(() => installed.value.antigravity && !!window.shellApi.agyPluginsList)
const plugins = ref([])
const pluginsLoading = ref(false)
const pluginsError = ref('')
const pluginTarget = ref('')
async function loadPlugins() {
  if (!showPlugins.value) return
  pluginsLoading.value = true
  pluginsError.value = ''
  try {
    const res = await window.shellApi.agyPluginsList()
    if (res && res.ok === false) pluginsError.value = res.error
    else {
      plugins.value = (res && res.plugins) || []
      if (res && res.error) pluginsError.value = res.error
    }
  } catch (err) {
    pluginsError.value = (err && err.message) || String(err)
  } finally {
    pluginsLoading.value = false
  }
}
function openPlugins() {
  tab.value = 'plugins'
  loadPlugins()
}
// "2 skills · 1 MCP server": what a plugin bundles.
function pluginParts(p) {
  const c = p.counts || {}
  const parts = []
  if (c.skills) parts.push(c.skills === 1 ? t('skills.plugins.skillOne', '1 skill') : t('skills.plugins.skillMany', '{{count}} skills', { count: c.skills }))
  if (c.mcpServers) parts.push(c.mcpServers === 1 ? t('skills.plugins.mcpOne', '1 MCP server') : t('skills.plugins.mcpMany', '{{count}} MCP servers', { count: c.mcpServers }))
  if (c.agents) parts.push(c.agents === 1 ? t('skills.plugins.agentOne', '1 subagent') : t('skills.plugins.agentMany', '{{count}} subagents', { count: c.agents }))
  if (c.hooks) parts.push(t('skills.plugins.hooks', 'hooks'))
  if (c.rules) parts.push(t('skills.plugins.rules', 'rules'))
  if (c.commands) parts.push(c.commands === 1 ? t('skills.plugins.commandOne', '1 command') : t('skills.plugins.commandMany', '{{count}} commands', { count: c.commands }))
  return parts.join(' · ') || (p.source ? t('skills.plugins.from', 'From {{source}}', { source: p.source }) : '')
}
async function togglePlugin(p) {
  busy.value = `plugin:${p.name}` // i18n-ignore
  try {
    const res = await window.shellApi.agyPluginsSet({ name: p.name, enabled: !p.enabled })
    if (res && res.ok)
      say(p.enabled ? t('skills.plugins.turnedOff', 'Turned off "{{name}}". Antigravity CLI panes use the change from their next start.', { name: p.name }) : t('skills.plugins.turnedOn', 'Turned on "{{name}}". Antigravity CLI panes use the change from their next start.', { name: p.name }))
    else say((res && res.error) || t('skills.plugins.failed', 'The Antigravity CLI could not change it.'), 'error')
  } finally {
    busy.value = ''
  }
  loadPlugins()
}
async function removePlugin(p) {
  const ok = await askConfirm({
    title: t('skills.plugins.removeConfirm', 'Uninstall the plugin "{{name}}"?', { name: p.name }),
    text: t('skills.plugins.removeText', 'The Antigravity CLI deletes its folder, with the skills, MCP servers and hooks it brought.'),
    confirmLabel: t('skills.plugins.uninstall', 'Uninstall'),
    danger: true
  })
  if (ok !== true) return
  busy.value = `plugin:${p.name}` // i18n-ignore
  try {
    const res = await window.shellApi.agyPluginsRemove({ name: p.name })
    if (res && res.ok) say(t('skills.plugins.removed', 'Uninstalled "{{name}}".', { name: p.name }))
    else say((res && res.error) || t('skills.plugins.failed', 'The Antigravity CLI could not change it.'), 'error')
  } finally {
    busy.value = ''
  }
  loadPlugins()
}
// A marketplace name (name@antigravity-plugins-official) or a folder: the
// install runs in a pane the user sees. Only a name or a plain path goes on
// the command line (nothing a shell would read as more).
const PLUGIN_TARGET = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,150}$/
const PLUGIN_FOLDER = /^[A-Za-z]:\\[^"'`$;&|<>%\r\n]{1,250}$/
function runPluginInstall(target) {
  emit('run', { label: t('skills.plugins.installPane', 'Antigravity plugin: {{name}}', { name: target }), command: `agy plugin install "${target}"` }) // i18n-ignore
}
function installPlugin() {
  const target = pluginTarget.value.trim()
  if (!PLUGIN_TARGET.test(target) && !PLUGIN_FOLDER.test(target)) {
    pluginsError.value = t('skills.plugins.badTarget', 'Enter a plugin name (name@marketplace) or a folder path.')
    return
  }
  pluginsError.value = ''
  runPluginInstall(target)
  say(t('skills.plugins.installing', 'Installing in a terminal. Refresh this list when it is done.'))
}
async function installPluginFolder() {
  const dir = await window.shellApi.pickFolder({ title: t('skills.plugins.pickTitle', 'Choose a plugin folder (with a plugin.json)') })
  if (!dir) return
  if (!PLUGIN_FOLDER.test(dir)) {
    pluginsError.value = t('skills.plugins.badFolder', 'This folder path has characters Tessel cannot pass on a command line.')
    return
  }
  pluginsError.value = ''
  runPluginInstall(dir)
  say(t('skills.plugins.installing', 'Installing in a terminal. Refresh this list when it is done.'))
}

// Escape closes the window; embedded in Settings, Settings handles it.
function onEscape(e) {
  if (props.embedded) return
  e.preventDefault()
  e.stopPropagation()
  emit('close')
}

onMounted(() => {
  if (cardEl.value && !props.embedded) cardEl.value.focus()
  resetAdd()
  refresh()
})
</script>

<template>
  <div :class="embedded ? 'mcp-embedded' : 'help-backdrop'" @pointerdown.self="embedded || emit('close')">
    <div
      ref="cardEl"
      :class="embedded ? 'mcp-embedded-body' : 'help-card mcp-card'"
      :role="embedded ? undefined : 'dialog'"
      :aria-label="embedded ? undefined : t('skills.title', 'Skills')"
      :tabindex="embedded ? undefined : -1"
      @keydown.escape="onEscape"
    >
      <div v-if="!embedded" class="help-head">
        <span>{{ t('skills.title', 'Skills') }}</span>
        <button class="tb-icon" :title="t('skills.close', 'Close (Esc)')" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <p class="mcp-intro">
        {{
          t('skills.intro', 'Skills are folders of instructions (a SKILL.md) and files that agents load when a task needs them. Each agent reads them from its own skill folders, for all projects or for one project.')
        }}
      </p>

      <div class="mcp-tabbar">
        <div class="launch-seg">
          <button class="launch-seg-btn" :class="{ on: tab === 'installed' }" @click="tab = 'installed'">
            {{ t('skills.tab.installed', 'Installed') }}<span v-if="listed.skills.length" class="mcp-count">{{ rows.length }}</span>
          </button>
          <button class="launch-seg-btn" :class="{ on: tab === 'add' }" @click="tab = 'add'">
            {{ t('skills.tab.add', 'Add') }}
          </button>
          <button v-if="showPlugins" class="launch-seg-btn" :class="{ on: tab === 'plugins' }" data-test="skills-tab-plugins" @click="openPlugins">
            {{ t('skills.tab.plugins', 'Antigravity plugins') }}
          </button>
        </div>
      </div>

      <p v-if="message.text" :class="message.kind === 'error' ? 'mcp-error' : 'mcp-notice'">{{ message.text }}</p>

      <!-- ================= Installed ================= -->
      <template v-if="tab === 'installed'">
        <div class="mcp-toolbar">
          <input
            v-model="query"
            class="set-number skills-search"
            :placeholder="t('skills.installed.search', 'Search skills')"
            spellcheck="false"
          />
          <span class="set-hint">
            <template v-if="loading">{{ t('skills.loading', 'Loading…') }}</template>
            <template v-else>{{ skillsLabel(rows.length) }}</template>
          </span>
          <button class="exit-btn" :disabled="loading" @click="refresh">{{ t('skills.installed.refresh', 'Refresh') }}</button>
        </div>

        <div v-if="!loading && !listed.skills.length" class="mcp-empty">
          {{ t('skills.installed.empty', 'No skills yet.') }}
          <button class="exit-btn primary" @click="tab = 'add'">{{ t('skills.installed.addOne', 'Add a skill') }}</button>
        </div>

        <div v-for="row in rows" :key="row.name" class="mcp-server">
          <div class="mcp-server-head">
            <BrandIcon :kind="'skill-' + row.name" accent="#8a93a6" :label="row.name" :size="22" />
            <div class="mcp-row-main">
              <span class="mcp-name">{{ row.name }}</span>
              <span class="set-hint skills-desc">{{ row.description || t('skills.installed.noDescription', 'No description.') }}</span>
            </div>
          </div>
          <div class="mcp-agents">
            <div v-for="copy in row.copies" :key="copy.id" class="mcp-agent skills-copy">
              <span class="skills-agents">
                <BrandIcon v-for="a in copy.seenBy.filter((x) => AGENTS.includes(x))" :key="a" :kind="a" :size="14" :title="AGENT_NAME[a]" />
              </span>
              <div class="mcp-row-main">
                <span class="mcp-agent-name">
                  {{ seenByLabel(copy) }}
                  <span class="mcp-scope">· {{ scopeLabel(copy.scope) }}</span>
                  <span v-if="copy.managed" class="launch-tag muted">{{ managedLabel(copy.managed) }}</span>
                  <span v-if="copy.link" class="launch-tag muted">{{ t('skills.installed.link', 'Link') }}</span>
                  <span v-if="copy.source" class="launch-tag muted" :title="sourceLabel(copy.source)">{{
                    copy.source.kind === 'github' ? 'GitHub' : t('skills.installed.fromFolder', 'Folder')
                  }}</span>
                </span>
                <span class="mcp-target" :title="copy.dir">{{ copy.dir }}</span>
              </div>
              <span class="mcp-agent-actions">
                <button class="exit-btn" @click="openFolder(copy)">{{ t('skills.installed.open', 'Open folder') }}</button>
                <button
                  v-if="copy.removable && copy.source && copy.source.kind === 'github'"
                  class="exit-btn"
                  :disabled="!!busy"
                  @click="update(copy)"
                >
                  {{ t('skills.installed.update', 'Update') }}
                </button>
                <button
                  v-if="copy.removable"
                  class="ws-icon-btn small danger"
                  :title="t('skills.installed.remove', 'Remove')"
                  :disabled="!!busy"
                  @click="remove(copy)"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                  </svg>
                </button>
              </span>
            </div>
          </div>
        </div>
      </template>

      <!-- ================= Antigravity plugins ================= -->
      <template v-else-if="tab === 'plugins'">
        <p class="set-hint skills-plugins-intro">
          {{
            t('skills.plugins.intro', 'Antigravity CLI plugins bundle skills, MCP servers, subagents, hooks and rules. Browse its marketplace with /plugin in an Antigravity CLI pane, or install one here by name or from a folder.')
          }}
        </p>
        <form class="mcp-toolbar" @submit.prevent="installPlugin">
          <input
            v-model="pluginTarget"
            class="set-number skills-search"
            :placeholder="t('skills.plugins.placeholder', 'name@antigravity-plugins-official')"
            spellcheck="false"
            data-test="agy-plugin-target"
          />
          <button class="exit-btn" type="submit" :disabled="!pluginTarget.trim()">{{ t('skills.plugins.install', 'Install') }}</button>
          <button class="exit-btn" type="button" @click="installPluginFolder">{{ t('skills.plugins.fromFolder', 'From a folder…') }}</button>
          <span class="set-hint">
            <template v-if="pluginsLoading">{{ t('skills.loading', 'Loading…') }}</template>
          </span>
          <button class="exit-btn" type="button" :disabled="pluginsLoading" @click="loadPlugins">{{ t('skills.installed.refresh', 'Refresh') }}</button>
        </form>
        <p v-if="pluginsError" class="mcp-error">{{ pluginsError }}</p>
        <div v-if="!pluginsLoading && !plugins.length && !pluginsError" class="mcp-empty">
          {{ t('skills.plugins.empty', 'No Antigravity CLI plugins installed.') }}
        </div>
        <div v-for="p in plugins" :key="p.name" class="mcp-server" :data-test="'agy-plugin-' + p.name">
          <div class="mcp-server-head">
            <BrandIcon :kind="'plugin-' + p.name" accent="#8a93a6" :label="p.name" :size="22" />
            <div class="mcp-row-main">
              <span class="mcp-name">
                {{ p.name }}
                <span v-if="p.version" class="mcp-scope">{{ p.version }}</span>
                <span v-if="!p.enabled" class="launch-tag muted">{{ t('skills.plugins.off', 'Turned off') }}</span>
              </span>
              <span class="set-hint skills-desc">{{ pluginParts(p) }}</span>
            </div>
            <span class="mcp-agent-actions">
              <button class="exit-btn" :disabled="!!busy" @click="togglePlugin(p)">
                {{ p.enabled ? t('skills.plugins.turnOff', 'Turn off') : t('skills.plugins.turnOn', 'Turn on') }}
              </button>
              <button class="ws-icon-btn small danger" :title="t('skills.plugins.uninstall', 'Uninstall')" :disabled="!!busy" @click="removePlugin(p)">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </button>
            </span>
          </div>
        </div>
      </template>

      <!-- ================= Add ================= -->
      <template v-else>
        <template v-if="!updating">
          <div class="set-row">
            <div class="set-label">{{ t('skills.add.from', 'From') }}</div>
            <div class="launch-seg set-seg">
              <button type="button" class="launch-seg-btn" :class="{ on: from === 'github' }" @click="(from = 'github'), resetAdd()">GitHub</button>
              <button type="button" class="launch-seg-btn" :class="{ on: from === 'folder' }" @click="(from = 'folder'), resetAdd()">
                {{ t('skills.add.folder', 'A folder') }}
              </button>
            </div>
          </div>
          <form v-if="from === 'github'" class="set-row" @submit.prevent="lookUp()">
            <div class="set-label">
              {{ t('skills.add.repo', 'Repository') }}
              <span class="set-hint">{{ t('skills.add.repoHint', 'owner/repo, owner/repo/path, or a github.com address') }}</span>
            </div>
            <div class="mcp-input-wrap">
              <input v-model="repoInput" class="set-number mcp-input wide" :placeholder="'anthropics/skills'" spellcheck="false" />
              <button class="exit-btn primary" type="submit" :disabled="!!busy || !repoInput.trim()">
                {{ busy === 'look' ? t('skills.add.looking', 'Looking…') : t('skills.add.look', 'Look') }}
              </button>
            </div>
          </form>
          <div v-else class="set-row">
            <div class="set-label">
              {{ t('skills.add.folderLabel', 'Skill folder') }}
              <span class="set-hint">{{ t('skills.add.folderHint', 'A folder with a SKILL.md at its top') }}</span>
            </div>
            <button class="exit-btn primary" :disabled="!!busy" @click="chooseFolder">
              {{ busy === 'look' ? t('skills.add.looking', 'Looking…') : t('skills.add.choose', 'Choose a folder') }}
            </button>
          </div>
        </template>
        <p v-else class="mcp-about">
          <strong>{{ t('skills.add.updatingTitle', 'Update:') }}</strong>
          {{ updating.dir }}
        </p>

        <p v-if="addError" class="mcp-error">{{ addError }}</p>
        <p v-if="busy === 'look' && updating" class="set-hint">{{ t('skills.add.looking', 'Looking…') }}</p>

        <!-- Several skills in the repository: pick one. -->
        <div v-if="candidates && !preview" class="skills-candidates">
          <p class="set-hint">{{ t('skills.add.several', 'This repository has several skills. Choose one:') }}</p>
          <div v-for="c in candidates.candidates" :key="c.path" class="mcp-entry">
            <div class="mcp-entry-head">
              <div class="mcp-row-main">
                <span class="mcp-name">{{ c.name }}</span>
                <span class="set-hint skills-desc">{{ c.description || c.path }}</span>
              </div>
              <button class="exit-btn" :disabled="!!busy" @click="lookUp(c.path)">{{ t('skills.add.pick', 'Choose') }}</button>
            </div>
          </div>
        </div>

        <!-- The preview: what will be installed, exactly. -->
        <div v-if="preview" class="skills-preview">
          <div class="mcp-entry-head">
            <BrandIcon :kind="'skill-' + preview.name" accent="#8a93a6" :label="preview.name" :size="26" />
            <div class="mcp-row-main">
              <span class="mcp-name">{{ preview.name }}</span>
              <span class="set-hint skills-desc">{{ preview.description || t('skills.installed.noDescription', 'No description.') }}</span>
              <span class="mcp-target">{{ sourceLabel(preview.source) }}<template v-if="preview.source.commit"> @ {{ preview.source.commit.slice(0, 7) }}</template></span>
            </div>
          </div>
          <p class="mcp-about">
            {{ t('skills.preview.review', 'Read it before installing: an agent follows these instructions.') }}
          </p>
          <pre class="skills-md">{{ preview.skillMd }}</pre>
          <details class="skills-files">
            <summary>{{ filesLabel(preview) }}</summary>
            <div v-for="f in preview.files" :key="f.path" class="skills-file">
              <span class="mcp-target">{{ f.path }}</span>
              <span class="set-hint">{{ size(f.size) }}</span>
            </div>
          </details>
          <p v-if="preview.scripts.length" class="mcp-about skills-warn">{{ scriptsLabel(preview) }}</p>

          <div v-if="preview.setup.length" class="mcp-about">
            <strong>{{ t('skills.setup.title', 'It comes with a setup command.') }}</strong>
            {{ t('skills.setup.body', 'Tessel does not run it. If you need it, run it yourself in a terminal and answer its questions there.') }}
            <div v-for="cmd in preview.setup" :key="cmd" class="mcp-input-wrap skills-setup">
              <code class="mcp-preview">{{ cmd }}</code>
              <button type="button" class="exit-btn" @click="runSetup(cmd)">{{ t('skills.setup.button', 'Run its setup in a terminal') }}</button>
            </div>
          </div>

          <form class="mcp-entry-form" @submit.prevent="install()">
            <template v-if="!updating">
              <div class="set-row">
                <div class="set-label">{{ t('skills.add.to', 'Add to') }}</div>
                <div class="mcp-targets">
                  <label v-for="a in AGENTS" :key="a" :class="{ disabled: !installed[a] && a !== 'claude' && a !== 'codex' }">
                    <input v-model="targets[a]" type="checkbox" />
                    <BrandIcon :kind="a" :size="13" />
                    {{ AGENT_NAME[a] }}
                  </label>
                </div>
              </div>
              <div class="set-row">
                <div class="set-label">
                  {{ t('skills.add.scope', 'Use it in') }}
                  <span class="set-hint">{{ project || t('skills.add.scopeHint', 'Open a project folder to add it to one project only') }}</span>
                </div>
                <div class="launch-seg set-seg">
                  <button type="button" class="launch-seg-btn" :class="{ on: scope === 'user' }" @click="scope = 'user'">
                    {{ t('skills.scope.user', 'All projects') }}
                  </button>
                  <button type="button" class="launch-seg-btn" :class="{ on: scope === 'project' }" :disabled="!project" @click="scope = 'project'">
                    {{ t('skills.scope.project', 'This project') }}
                  </button>
                </div>
              </div>
            </template>
            <div v-if="results" class="mcp-agents mcp-add-results">
              <div v-for="r in results" :key="r.dir" class="mcp-agent">
                <span class="mcp-status" :class="r.ok ? 'connected' : r.exists ? 'auth' : 'error'" :title="r.error || ''">
                  {{ r.ok ? t('skills.add.done', 'Installed') : r.exists ? t('skills.add.exists', 'Already there') : t('skills.add.failed', 'Failed') }}
                </span>
                <span class="mcp-target" :title="r.dir">{{ r.dir }}</span>
                <span class="mcp-agent-actions">
                  <button v-if="r.exists" type="button" class="exit-btn" :disabled="!!busy" @click="install(r.dir)">
                    {{ t('skills.add.replace', 'Replace it') }}
                  </button>
                </span>
              </div>
            </div>
            <div class="set-foot">
              <span class="set-hint">{{ t('skills.add.codexNote', 'Codex gets it in the shared .agents folder, which OpenCode, Copilot CLI and Gemini CLI read too.') }}</span>
              <button class="exit-btn primary" type="submit" :disabled="!!busy">
                {{ busy === 'install' ? t('skills.add.installing', 'Installing…') : installLabel(preview) /* i18n-ignore */ }}
              </button>
            </div>
          </form>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.skills-plugins-intro {
  margin: 0 0 8px;
}
.skills-search {
  flex: 1 1 auto;
  max-width: 260px;
  margin-right: 10px;
}
.mcp-toolbar .set-hint {
  margin-right: auto;
}
.skills-desc {
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.skills-copy {
  align-items: flex-start;
}
.skills-agents {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 3px;
  min-width: 34px;
  padding-top: 2px;
}
.skills-preview {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--border-strong);
}
.skills-md {
  max-height: 240px;
  margin: 6px 0;
  padding: 8px 10px;
  overflow: auto;
  border-radius: 6px;
  background: var(--term);
  color: var(--text);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
.skills-files summary {
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
}
.skills-files {
  max-height: 180px;
  overflow: auto;
}
.skills-file {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 1px 0 1px 14px;
}
.skills-warn {
  color: #ffd98f;
}
.skills-setup {
  margin-top: 6px;
}
.skills-setup .mcp-preview {
  flex: 1 1 auto;
  margin: 0;
}
</style>
