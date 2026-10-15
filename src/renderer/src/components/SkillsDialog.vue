<script setup>
// Agent skills (a folder with a SKILL.md), for every agent CLI that reads
// them, in one place, like the MCP servers window:
//   Installed - each skill with its copies: which agents see it, all projects
//               or this project, where it is, where it comes from (the
//               user's own, GitHub, a folder); open its folder, update one
//               added from GitHub, remove it (Recycle Bin or delete). Each
//               copy's history: a version kept whenever its content changed,
//               each compared with the one before, and restored if wanted.
//               "Modified locally" when an added copy was edited, "Update
//               available" when GitHub has newer commits for it (checked
//               about once a day, and by Refresh).
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

function dateTime(ms) {
  if (!ms) return ''
  try {
    return new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
  } catch {
    return new Date(ms).toLocaleString()
  }
}
// "3 days ago", in the interface's language.
function ago(ms) {
  if (!ms) return ''
  const secs = Math.min(0, Math.round((ms - Date.now()) / 1000)) // a file dated ahead: now
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]
  try {
    const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' })
    for (const [unit, size] of units) if (Math.abs(secs) >= size) return rtf.format(Math.round(secs / size), unit)
    return t('skills.time.now', 'just now')
  } catch {
    return dateTime(ms)
  }
}

// Where a copy comes from: the user's own (no record of adding it), GitHub
// or a folder (added by Tessel), or the agent's (synced, built in).
const originOf = (copy) => copy.origin || (copy.managed ? 'agent' : copy.source ? (copy.source.kind === 'github' ? 'github' : 'folder') : 'own')
function originLabel(copy) {
  const origin = originOf(copy)
  if (origin === 'github') return t('skills.origin.github', 'From GitHub — {{repo}}', { repo: `${copy.source.owner}/${copy.source.repo}` }) // i18n-ignore path
  if (origin === 'folder') return t('skills.origin.folder', 'Copied from a folder')
  if (origin === 'own') return t('skills.origin.own', 'Your skill')
  return ''
}
function originTitle(copy) {
  if (originOf(copy) === 'own') return t('skills.origin.ownHint', 'Tessel has no record of adding it from GitHub or a folder: made on this computer, or added by another tool.')
  if (!copy.source) return ''
  return sourceLabel(copy.source) + (copy.source.commit ? ` @ ${copy.source.commit.slice(0, 7)}` : '') // i18n-ignore commit
}
const FILTERS = ['all', 'own', 'github', 'folder']
const filterLabel = (f) =>
  f === 'own' ? t('skills.filter.own', 'Yours') : f === 'github' ? t('skills.filter.github', 'GitHub') : f === 'folder' ? t('skills.filter.folder', 'Folders') : t('skills.filter.all', 'All')
const updateTitle = (copy) => {
  const latest = copy.update && copy.update.latest
  return latest ? t('skills.updates.hint', 'Newest change: {{message}} ({{when}})', { message: latest.message, when: dateTime(latest.date) }) : ''
}
const changedLabel = (copy) =>
  copy.history.versions === 1
    ? t('skills.history.summary', 'Changed {{when}} · {{count}} version', { when: ago(copy.history.changedAt), count: 1 })
    : t('skills.history.summary', 'Changed {{when}} · {{count}} versions', { when: ago(copy.history.changedAt), count: copy.history.versions })
function versionSummary(v) {
  if (v.first) return t('skills.history.first', 'First version kept')
  return v.fileCount === 1
    ? t('skills.history.files', '{{count}} file changed', { count: 1 })
    : t('skills.history.files', '{{count}} files changed', { count: v.fileCount })
}
function noteLabel(note) {
  const at = note.commit ? ` @ ${String(note.commit).slice(0, 7)}` : '' // i18n-ignore commit
  if (note.kind === 'restore') return t('skills.history.noteRestore', 'Restored from {{when}}', { when: dateTime(note.fromAt) })
  if (note.kind === 'update') return t('skills.history.noteUpdate', 'Updated from GitHub') + at
  if (note.kind === 'install' && note.from === 'folder') return t('skills.history.noteFolder', 'Copied from a folder')
  if (note.kind === 'install') return t('skills.history.noteInstall', 'Installed from GitHub') + at
  return ''
}
const partialHint = computed(() =>
  t('skills.history.partialHint', 'Too many files (or too large) to keep all of this skill in its history: it cannot be restored, nor updated while it differs from what was installed.')
)
const statusLabel = (s) =>
  s === 'A' ? t('skills.history.added', 'Added') : s === 'D' ? t('skills.history.removed', 'Removed') : t('skills.history.changed', 'Changed')
const changesTitle = (changes) =>
  changes.commits.length === 1
    ? t('skills.update.changes', 'What changed since your version ({{count}} commit)', { count: 1 })
    : t('skills.update.changes', 'What changed since your version ({{count}} commits)', { count: changes.commits.length })

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
const listed = ref({ skills: [], roots: [], updates: null })
const query = ref('')
const originFilter = ref('all')

// quiet: the list read again without "Loading…" (after a check or a restore).
async function refresh(quiet = false) {
  if (!quiet) loading.value = true
  try {
    // quiet: the main process may reuse a walk of the last minute.
    const res = await window.shellApi.skillsList(project.value, quiet ? { quiet: true } : undefined)
    if (res && res.ok === false) say(res.error, 'error')
    else listed.value = { skills: (res && res.skills) || [], roots: (res && res.roots) || [], updates: (res && res.updates) || null }
  } catch (err) {
    say((err && err.message) || String(err), 'error')
  } finally {
    loading.value = false
  }
}

// Updates of the skills added from GitHub: about once a day when the list
// opens, and by Refresh (force). Nothing is asked without such a skill.
const checking = ref(false)
async function checkUpdates(force = false) {
  if (!window.shellApi.skillsCheckUpdates) return
  if (!listed.value.skills.some((s) => s.source && s.source.kind === 'github')) return
  checking.value = true
  try {
    const res = await window.shellApi.skillsCheckUpdates({ force })
    if (res && res.checked) await refresh(true)
    if (force && res && res.rateLimited)
      say(t('skills.updates.limited', "GitHub's limit for update checks is reached. Next check after {{time}}.", { time: dateTime(res.until) }), 'error')
    else if (force && res && res.ok === false && res.error) say(res.error, 'error')
  } catch (err) {
    if (force) say((err && err.message) || String(err), 'error')
  } finally {
    checking.value = false
  }
}
async function refreshAll() {
  await refresh()
  await checkUpdates(true)
}
const checkedLabel = computed(() => {
  if (checking.value) return t('skills.updates.checking', 'Checking GitHub for updates…')
  const at = listed.value.updates && listed.value.updates.checkedAt
  if (!at || !listed.value.skills.some((s) => s.source && s.source.kind === 'github')) return ''
  return t('skills.updates.checked', 'Updates checked {{when}}', { when: ago(at) })
})

// A filter by origin once the list is long.
const originCounts = computed(() => {
  const counts = { all: 0, own: 0, github: 0, folder: 0 }
  for (const s of listed.value.skills) {
    counts.all++
    if (counts[originOf(s)] != null) counts[originOf(s)]++
  }
  return counts
})
const showFilter = computed(() => new Set(listed.value.skills.map((s) => s.name)).size > 6 || originFilter.value !== 'all')

// One row per skill name, with each copy (one per folder it is in).
const rows = computed(() => {
  const q = query.value.trim().toLowerCase()
  const map = new Map()
  for (const s of listed.value.skills) {
    if (q && !`${s.name} ${s.description || ''}`.toLowerCase().includes(q)) continue
    if (originFilter.value !== 'all' && originOf(s) !== originFilter.value) continue
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

// History: the versions kept for one copy, newest first; the chosen one is
// compared with the version before it.
const historyOpen = ref(null) // the copy's id
const history = reactive({ versions: [], loading: false, error: '', selected: null, diff: null, diffLoading: false })
const selectedVersion = computed(() => history.versions.find((v) => v.id === history.selected) || null)
async function toggleHistory(copy, open = historyOpen.value !== copy.id) {
  if (!open) {
    historyOpen.value = null
    return
  }
  historyOpen.value = copy.id
  Object.assign(history, { versions: [], loading: true, error: '', selected: null, diff: null })
  try {
    const res = await window.shellApi.skillsHistory({ dir: copy.dir, cwd: project.value })
    if (historyOpen.value !== copy.id) return
    if (res && res.ok === false) history.error = res.error
    else history.versions = (res && res.versions) || []
  } catch (err) {
    history.error = (err && err.message) || String(err)
  } finally {
    history.loading = false
  }
  if (history.versions.length) showVersion(copy, history.versions[0])
}
async function showVersion(copy, v) {
  history.selected = v.id
  history.diff = null
  history.diffLoading = true
  try {
    const res = await window.shellApi.skillsHistoryDiff({ dir: copy.dir, id: v.id, cwd: project.value })
    if (history.selected !== v.id) return
    history.diff = res && res.ok === false ? { error: res.error, files: [] } : res
  } catch (err) {
    history.diff = { error: (err && err.message) || String(err), files: [] }
  } finally {
    history.diffLoading = false
  }
}
async function restoreVersion(copy, v) {
  const ok = await askConfirm({
    title: t('skills.history.restoreConfirm', 'Restore "{{name}}" to its version of {{when}}?', { name: copy.name, when: dateTime(v.changedAt) }),
    text: t('skills.history.restoreText', 'Its files replace the current ones. The current version is kept in the history first, so you can come back to it.'),
    code: copy.dir,
    confirmLabel: t('skills.history.restore', 'Restore this version')
  })
  if (ok !== true) return
  busy.value = `restore:${copy.dir}` // i18n-ignore
  try {
    const res = await window.shellApi.skillsRestore({ dir: copy.dir, id: v.id, cwd: project.value })
    if (res && res.ok)
      say(
        res.kept && res.kept.length
          ? t('skills.history.restoredKept', 'Restored "{{name}}". Left in place: {{files}} (not in that version, and too large to keep in the history).', { name: copy.name, files: res.kept.slice(0, 3).join(', ') })
          : t('skills.history.restored', 'Restored "{{name}}" to its version of {{when}}.', { name: copy.name, when: dateTime(v.changedAt) })
      )
    else say((res && res.error) || t('skills.history.restoreFailed', 'It could not be restored.'), 'error')
  } finally {
    busy.value = ''
  }
  await refresh(true)
  const again = listed.value.skills.find((s) => s.dir === copy.dir)
  if (again) toggleHistory(again, true)
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
  // An edited copy: its changes go (they stay in its history).
  if (!replaceDir && updating.value && updating.value.modified) {
    const sure = await askConfirm({
      title: t('skills.update.confirm', 'Replace your changes to "{{name}}"?', { name: updating.value.name }),
      text: t('skills.update.confirmText', 'This copy was changed since it was installed. The update replaces it; your version stays in its history (History, then Restore this version).'),
      code: updating.value.dir,
      confirmLabel: t('skills.update.anyway', 'Update anyway'),
      danger: true
    })
    if (sure !== true) return
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
        replace && done.some((r) => r.trashed)
          ? t('skills.add.updatedTrashed', 'Updated "{{name}}". The old copy is in the Recycle Bin. Agents use it from their next session.', { name: res.name })
          : replace
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

onMounted(async () => {
  if (cardEl.value && !props.embedded) cardEl.value.focus()
  resetAdd()
  await refresh()
  checkUpdates(false)
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
            <span v-if="checkedLabel" class="skills-checked">· {{ checkedLabel }}</span>
          </span>
          <button
            class="exit-btn"
            :disabled="loading || checking"
            :title="t('skills.installed.refreshHint', 'Read the skill folders again and check GitHub for updates')"
            @click="refreshAll"
          >
            {{ t('skills.installed.refresh', 'Refresh') }}
          </button>
        </div>

        <div v-if="showFilter" class="launch-seg skills-filter" role="group" :aria-label="t('skills.filter.label', 'Show')">
          <button
            v-for="f in FILTERS"
            :key="f"
            type="button"
            class="launch-seg-btn"
            :class="{ on: originFilter === f }"
            @click="originFilter = f"
          >
            {{ filterLabel(f) }}<span class="mcp-count">{{ originCounts[f] }}</span>
          </button>
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
            <template v-for="copy in row.copies" :key="copy.id">
              <div class="mcp-agent skills-copy">
                <span class="skills-agents">
                  <BrandIcon v-for="a in copy.seenBy.filter((x) => AGENTS.includes(x))" :key="a" :kind="a" :size="14" :title="AGENT_NAME[a]" />
                </span>
                <div class="mcp-row-main">
                  <span class="mcp-agent-name">
                    {{ seenByLabel(copy) }}
                    <span class="mcp-scope">· {{ scopeLabel(copy.scope) }}</span>
                    <span v-if="copy.managed" class="launch-tag muted">{{ managedLabel(copy.managed) }}</span>
                    <span v-if="copy.link" class="launch-tag muted">{{ t('skills.installed.link', 'Link') }}</span>
                    <span v-if="originOf(copy) !== 'agent'" class="launch-tag skills-origin" :class="'origin-' + originOf(copy)" :title="originTitle(copy)">{{
                      originLabel(copy)
                    }}</span>
                    <span v-if="copy.modified" class="launch-tag skills-modified" :title="t('skills.modified.hint', 'Changed on this computer since it was installed.')">{{
                      t('skills.modified.badge', 'Modified locally')
                    }}</span>
                    <span v-if="copy.update && copy.update.available" class="launch-tag skills-update" :title="updateTitle(copy)">{{
                      t('skills.updates.badge', 'Update available')
                    }}</span>
                  </span>
                  <span class="mcp-target" :title="copy.dir">{{ copy.dir }}</span>
                  <span v-if="copy.history && copy.history.versions" class="set-hint skills-history-line">
                    {{ changedLabel(copy) }}
                    <span v-if="copy.history.partial" class="launch-tag muted skills-partial" :title="partialHint">{{ t('skills.history.partialBadge', 'Partly kept') }}</span>
                    <button type="button" class="skills-link" :aria-expanded="historyOpen === copy.id" @click="toggleHistory(copy)">
                      {{ historyOpen === copy.id ? t('skills.history.hide', 'Hide history') : t('skills.history.show', 'History') }}
                    </button>
                  </span>
                </div>
                <span class="mcp-agent-actions">
                  <button class="exit-btn" @click="openFolder(copy)">{{ t('skills.installed.open', 'Open folder') }}</button>
                  <button
                    v-if="copy.removable && copy.source && copy.source.kind === 'github'"
                    class="exit-btn"
                    :class="{ primary: copy.update && copy.update.available }"
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

              <!-- Its history: the versions kept, the chosen one against the one before. -->
              <div v-if="historyOpen === copy.id" class="skills-history">
                <p v-if="history.loading" class="set-hint">{{ t('skills.loading', 'Loading…') }}</p>
                <p v-else-if="history.error" class="mcp-error">{{ history.error }}</p>
                <p v-else-if="!history.versions.length" class="set-hint">{{ t('skills.history.none', 'No version kept yet.') }}</p>
                <template v-else>
                  <p v-if="copy.history && copy.history.partial" class="mcp-about skills-warn">{{ partialHint }}</p>
                  <ul class="skills-versions">
                    <li v-for="v in history.versions" :key="v.id" class="skills-version" :class="{ on: history.selected === v.id }">
                      <button type="button" class="skills-version-pick" @click="showVersion(copy, v)">
                        <span class="skills-version-when">{{ dateTime(v.changedAt) }}</span>
                        <span class="set-hint">
                          {{ versionSummary(v) }}
                          <template v-if="!v.first">
                            · <span class="skills-plus">+{{ v.stats.plus }}</span> <span class="skills-minus">−{{ v.stats.minus }}</span>
                          </template>
                        </span>
                        <span v-if="v.latest" class="launch-tag muted">{{ t('skills.history.current', 'Current') }}</span>
                        <span v-if="v.note && noteLabel(v.note)" class="launch-tag muted">{{ noteLabel(v.note) }}</span>
                      </button>
                      <button
                        v-if="!v.latest && copy.removable && !(copy.history && copy.history.partial)"
                        type="button"
                        class="exit-btn"
                        :disabled="!!busy"
                        @click="restoreVersion(copy, v)"
                      >
                        {{ t('skills.history.restore', 'Restore this version') }}
                      </button>
                    </li>
                  </ul>
                  <div class="skills-diff" aria-live="polite">
                    <p v-if="history.diffLoading" class="set-hint">{{ t('skills.loading', 'Loading…') }}</p>
                    <p v-else-if="history.diff && history.diff.error" class="mcp-error">{{ history.diff.error }}</p>
                    <template v-else-if="history.diff">
                      <p v-if="selectedVersion && selectedVersion.first" class="set-hint">
                        {{ t('skills.history.firstHint', 'The first version Tessel kept, shown whole.') }}
                      </p>
                      <p v-else-if="selectedVersion && selectedVersion.oldest" class="set-hint">
                        {{ t('skills.history.oldest', 'Older versions were dropped from the history: this one is shown whole.') }}
                      </p>
                      <p v-if="!history.diff.files.length" class="set-hint">{{ t('skills.history.noFiles', 'No file changed.') }}</p>
                      <div v-for="f in history.diff.files" :key="f.path" class="rv-diff skills-diff-file">
                        <div class="rv-diff-head">
                          <span class="rv-path">{{ f.path }}</span>
                          <span class="launch-tag muted">{{ statusLabel(f.status) }}</span>
                          <span v-if="!f.binary && !f.notKept" class="set-hint">
                            <span class="skills-plus">+{{ f.added }}</span> <span class="skills-minus">−{{ f.removed }}</span>
                          </span>
                        </div>
                        <p v-if="f.notKept" class="act-none">{{ t('skills.history.notKept', 'Too large to keep in the history: no diff.') }}</p>
                        <p v-else-if="f.binary" class="act-none">{{ t('skills.history.binary', 'Binary file: no text diff.') }}</p>
                        <p v-else-if="!f.hunks.length && !f.truncated" class="act-none">{{ t('skills.history.noLines', 'No line changed (line endings only).') }}</p>
                        <table v-else class="rv-table">
                          <tbody v-for="(h, hi) in f.hunks" :key="hi">
                            <tr class="rv-hunk">
                              <td colspan="3">{{ h.header }}</td>
                            </tr>
                            <tr v-for="(l, li) in h.lines" :key="li" class="rv-line" :class="l.kind">
                              <td class="rv-num">{{ l.old }}</td>
                              <td class="rv-num">{{ l.new }}</td>
                              <td class="rv-code"><span class="rv-sign">{{ l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ' }}</span>{{ l.text }}</td>
                            </tr>
                          </tbody>
                        </table>
                        <p v-if="f.truncated" class="act-none">{{ t('skills.history.truncated', 'The diff is too long to show in full.') }}</p>
                      </div>
                    </template>
                  </div>
                </template>
              </div>
            </template>
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
          <p v-if="updating && updating.modified" class="mcp-about skills-warn">
            {{ t('skills.update.modified', 'You changed this copy since it was installed. Updating replaces your changes; they stay in its history.') }}
          </p>
          <div v-if="updating && preview.changes" class="skills-changes">
            <p class="mcp-about">
              <strong>{{ changesTitle(preview.changes) }}</strong>
            </p>
            <ul v-if="preview.changes.commits.length" class="skills-commits">
              <li v-for="c in preview.changes.commits" :key="c.sha">
                <span class="skills-commit-msg">{{ c.message }}</span>
                <span class="set-hint">{{ c.author }} · {{ dateTime(c.date) }}</span>
              </li>
            </ul>
            <p v-if="preview.changes.more" class="set-hint">{{ t('skills.update.more', 'Older commits are not listed: only the 30 newest are shown.') }}</p>
            <p v-if="!preview.changes.commits.length" class="set-hint">{{ t('skills.update.noCommits', 'No new commit touched this skill since your version.') }}</p>
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
.skills-checked {
  margin-left: 4px;
}
.skills-filter {
  margin: 0 0 8px;
}
/* Origin and state badges of a copy. */
.skills-origin.origin-own {
  background: color-mix(in srgb, #3fb950 20%, transparent);
  color: #a8e6b4;
}
.skills-origin.origin-folder {
  background: var(--surface-3);
  color: var(--text-dim);
}
.skills-modified {
  background: color-mix(in srgb, #d29922 24%, transparent);
  color: #ffd98f;
}
.skills-update {
  background: color-mix(in srgb, #3fb950 30%, transparent);
  color: #c8f5d1;
  font-weight: 600;
}
.skills-history-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.skills-link {
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}
.skills-link:hover {
  text-decoration: underline;
}
.skills-history {
  margin: 2px 0 8px 40px;
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
}
.skills-versions {
  max-height: 200px;
  margin: 0 0 8px;
  padding: 0;
  overflow: auto;
  list-style: none;
}
.skills-version {
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 4px;
}
.skills-version.on {
  background: var(--surface-3);
}
.skills-version-pick {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  padding: 4px 6px;
  border: none;
  background: none;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.skills-version-when {
  font-size: 12px;
}
.skills-plus {
  color: #7ee2a8;
}
.skills-minus {
  color: #ff9a9a;
}
.skills-diff {
  max-height: 420px;
  overflow: auto;
}
.skills-diff-file + .skills-diff-file {
  margin-top: 8px;
}
.skills-diff-file .rv-diff-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.skills-commits {
  max-height: 200px;
  margin: 4px 0;
  padding: 0 0 0 16px;
  overflow: auto;
}
.skills-commits li {
  margin: 2px 0;
}
.skills-commit-msg {
  margin-right: 8px;
}
</style>
