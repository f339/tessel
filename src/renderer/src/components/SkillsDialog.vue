<script setup>
// Agent skills (a folder with a SKILL.md), for every agent CLI that reads
// them, in one place, like the MCP servers window:
//   Installed - one row per skill (its name and where it comes from: the
//               user's own, GitHub, a folder, synced from the Claude account,
//               built into an agent), however many folders hold it; which
//               agents see it, all projects or this project. A click opens its
//               details: the whole description and each copy (its agents,
//               scope and folder); open its folder, update one added from
//               GitHub, remove one copy or all (Recycle Bin or delete). Each
//               copy's history: a version kept whenever its content changed,
//               each compared with the one before, and restored if wanted.
//               "Modified locally" when an added copy was edited, "Update
//               available" when GitHub has newer commits for it (checked
//               about once a day, and by Refresh).
//   Add       - from a GitHub repository or a folder, in three steps: the
//               source; what was found (a card for each skill of a
//               repository), its SKILL.md to read, formatted or as it is,
//               and its files; then the agents (chips) and the scope. It is
//               copied into the skill folder of each chosen agent, and the
//               result says, folder by folder, installed, already there
//               (Replace it) or failed and why. Nothing from a skill is ever
//               run: a setup command it mentions is only offered, in a pane
//               the user sees.
//   Antigravity plugins - the Antigravity CLI's plugins, listed like the
//               skills: one row each, its details on a click.
// The work is done in the main process (src/main/skillsManager.js).
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount, inject } from 'vue'
import BrandIcon from './BrandIcon.vue'
import { t, intlLocale } from '../i18n'
import { isRemotePath } from '../../../shared/remotePath'
import { splitFrontmatter, renderSkillMarkdown } from '../skillPreview'

const props = defineProps({
  cwd: { type: String, default: null }, // current workspace's project folder
  agents: { type: Array, default: () => [] },
  // Shown as a Settings page: no backdrop, card, title bar or Escape to close.
  embedded: { type: Boolean, default: false }
})
const emit = defineEmits(['close', 'run'])

// The agents that read skills (same ids as Settings > Agents).
const ALL_AGENTS = ['claude', 'codex', 'opencode', 'copilot', 'gemini', 'antigravity', 'muse']
const AGENT_NAME = {
  claude: 'Claude Code', // i18n-ignore
  codex: 'Codex', // i18n-ignore
  opencode: 'OpenCode', // i18n-ignore
  copilot: 'Copilot CLI', // i18n-ignore
  gemini: 'Gemini CLI', // i18n-ignore
  antigravity: 'Antigravity CLI', // i18n-ignore
  muse: 'Muse Code' // i18n-ignore
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
const sourceLabel = (source) =>
  source.kind === 'github'
    ? t('skills.source.github', 'From GitHub: {{repo}}', { repo: `${source.owner}/${source.repo}${source.path ? '/' + source.path : ''}` }) // i18n-ignore path
    : t('skills.source.folder', 'From a folder: {{path}}', { path: source.path })
const skillsLabel = (count) =>
  count === 1
    ? t('skills.installed.count', '{{count}} skill', { count })
    : t('skills.installed.count', '{{count}} skills', { count })
const versionsLabel = (count) => t('skills.details.versions', 'These copies are not all the same: {{count}} different versions.', { count })
// "3 of 20 skills": a search or a filter shows part of the list.
const skillsOfLabel = (shown, count) =>
  count === 1
    ? t('skills.installed.countOf', '{{shown}} of {{count}} skill', { shown, count })
    : t('skills.installed.countOf', '{{shown}} of {{count}} skills', { shown, count })
const filesSizeLabel = (count, bytes) =>
  count === 1
    ? t('skills.preview.files', '{{count}} file, {{size}}', { count: 1, size: size(bytes) })
    : t('skills.preview.files', '{{count}} files, {{size}}', { count, size: size(bytes) })
const filesLabel = (pkg) => filesSizeLabel(pkg.files.length, pkg.totalBytes)
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
// The same, as the list shows it (one badge each, and its filters): the
// agent's own copies are either synced from the Claude account or built in.
const KINDS = ['own', 'github', 'folder', 'synced', 'builtin']
function kindOf(copy) {
  if (copy.managed === 'synced') return 'synced'
  const origin = originOf(copy)
  return copy.managed || origin === 'agent' ? 'builtin' : origin
}
function kindLabel(kind) {
  if (kind === 'own') return t('skills.kind.own', 'Yours')
  if (kind === 'github') return t('skills.kind.github', 'GitHub')
  if (kind === 'folder') return t('skills.kind.folder', 'Folder')
  if (kind === 'synced') return t('skills.kind.synced', 'Synced')
  return t('skills.kind.builtin', 'Built-in')
}
function originLabel(copy) {
  const origin = originOf(copy)
  if (copy.managed) return managedLabel(copy.managed)
  if (origin === 'github') return t('skills.origin.github', 'From GitHub — {{repo}}', { repo: `${copy.source.owner}/${copy.source.repo}` }) // i18n-ignore path
  if (origin === 'folder') return t('skills.origin.folder', 'Copied from a folder')
  if (origin === 'own') return t('skills.origin.own', 'Your skill')
  return managedLabel('nested')
}
function originTitle(copy) {
  if (copy.managed) return managedLabel(copy.managed)
  if (originOf(copy) === 'own') return t('skills.origin.ownHint', 'Tessel has no record of adding it from GitHub or a folder: made on this computer, or added by another tool.')
  if (!copy.source) return ''
  return sourceLabel(copy.source) + (copy.source.commit ? ` @ ${copy.source.commit.slice(0, 7)}` : '') // i18n-ignore commit
}
// A row's badge tooltip: what its first copy says.
const kindTitle = (group) => originTitle(group.copies[0])
const FILTERS = ['all', ...KINDS]
function filterLabel(f) {
  if (f === 'own') return t('skills.filter.own', 'Yours')
  if (f === 'github') return t('skills.filter.github', 'GitHub')
  if (f === 'folder') return t('skills.filter.folder', 'Folders')
  if (f === 'synced') return t('skills.filter.synced', 'Synced')
  if (f === 'builtin') return t('skills.filter.builtin', 'Built-in')
  return t('skills.filter.all', 'All')
}
const agentsOf = (copy) => ALL_AGENTS.filter((a) => copy.seenBy.includes(a) && AGENTS.value.includes(a))
const agentNames = (agents) => agentList(agents.map((a) => AGENT_NAME[a]))
const seenByNames = (agents) => t('skills.installed.seenBy', 'Seen by {{agents}}', { agents: agentNames(agents) })
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
const listed = ref({ skills: [], roots: [], updates: null, home: null })
const query = ref('')
const originFilter = ref('all')

// quiet: the list read again without "Loading…" (after a check or a restore).
async function refresh(quiet = false) {
  if (!quiet) loading.value = true
  try {
    // quiet: the main process may reuse a walk of the last minute.
    const res = await window.shellApi.skillsList(project.value, quiet ? { quiet: true } : undefined)
    if (res && res.ok === false) say(res.error, 'error')
    else listed.value = { skills: (res && res.skills) || [], roots: (res && res.roots) || [], updates: (res && res.updates) || null, home: (res && res.home) || null }
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

// Two copies hold the same content: the same files (their history's hash)
// or, for the agent's own copies that have no history, the same SKILL.md.
// Nothing to compare: taken for the same (never said to differ unseen).
function sameContent(a, b) {
  if (a.hash && b.hash) return a.hash === b.hash
  if (a.mdHash && b.mdHash) return a.mdHash === b.mdHash
  return true
}
const KIND_ORDER = Object.fromEntries(KINDS.map((k, i) => [k, i]))
const SCOPE_ORDER = { user: 0, project: 1 }
// One skill, however many folders hold it: all projects before this
// project, then by folder.
function makeGroup(key, kind, copies) {
  const sorted = [...copies].sort(
    (a, b) => (SCOPE_ORDER[a.scope] ?? 2) - (SCOPE_ORDER[b.scope] ?? 2) || String(a.dir).localeCompare(String(b.dir))
  )
  const versions = []
  for (const c of sorted) if (!versions.some((v) => sameContent(v, c))) versions.push(c)
  return {
    key,
    name: sorted[0].name,
    description: (sorted.find((c) => c.description) || {}).description || null,
    copies: sorted,
    kind,
    agents: ALL_AGENTS.filter((a) => sorted.some((c) => agentsOf(c).includes(a))),
    scopes: ['user', 'project'].filter((s) => sorted.some((c) => c.scope === s)),
    modified: sorted.some((c) => c.modified),
    update: sorted.find((c) => c.update && c.update.available) || null,
    partial: sorted.some((c) => c.history && c.history.partial),
    removable: sorted.filter((c) => c.removable),
    versions: versions.length,
    text: sorted.map((c) => `${c.name} ${c.description || ''}`).join(' ').toLowerCase()
  }
}

// The list once: one row per skill name and origin. Copies of a skill in
// several folders (each agent's, both of Claude's synced account folders)
// are one row; an agent's built-in skill named like one of the user's is
// another skill, so another row. Each row has one origin, so the tab, the
// filters and the count above the list all count the same rows, and the
// filters add up to All.
const groups = computed(() => {
  const byKey = new Map()
  for (const s of listed.value.skills) {
    const kind = kindOf(s)
    const key = `${kind}:${String(s.name).toLowerCase()}` // i18n-ignore
    if (!byKey.has(key)) byKey.set(key, { kind, copies: [] })
    byKey.get(key).copies.push(s)
  }
  return [...byKey]
    .map(([key, { kind, copies }]) => makeGroup(key, kind, copies))
    .sort((a, b) => a.name.localeCompare(b.name) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
})
const counts = computed(() => {
  const out = { all: groups.value.length }
  for (const k of KINDS) out[k] = groups.value.filter((g) => g.kind === k).length
  return out
})
// The filters once the skills come from more than one place.
const showFilter = computed(() => KINDS.filter((k) => counts.value[k]).length > 1 || originFilter.value !== 'all')
const visibleFilters = computed(() => FILTERS.filter((f) => f === 'all' || counts.value[f] || originFilter.value === f))
const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return groups.value.filter((g) => (!q || g.text.includes(q)) && (originFilter.value === 'all' || g.kind === originFilter.value))
})
const countLabel = computed(() =>
  shown.value.length === groups.value.length ? skillsLabel(groups.value.length) : skillsOfLabel(shown.value.length, groups.value.length)
)
function showAll() {
  query.value = ''
  originFilter.value = 'all'
}

// The details of one skill, under its row. Arrows move between rows, Enter
// (or a click) opens or closes the details, Escape closes them.
const openKey = ref(null)
const uid = `skills-${Math.random().toString(36).slice(2, 8)}` // i18n-ignore
const rowId = (g) => `${uid}-row-${g.key.replace(/[^a-z0-9_-]/g, '_')}` // i18n-ignore
const detailsId = (g) => `${uid}-details-${g.key.replace(/[^a-z0-9_-]/g, '_')}` // i18n-ignore
const rowEls = []
function toggleGroup(g, open = openKey.value !== g.key) {
  if (!open && historyOpen.value && g.copies.some((c) => c.id === historyOpen.value)) historyOpen.value = null
  openKey.value = open ? g.key : null
}
function focusRow(i) {
  const n = shown.value.length
  if (!n) return
  const el = rowEls[Math.max(0, Math.min(n - 1, i))]
  if (el) el.focus()
}
// The keys of a list of rows (the skills, the skills found, the plugins):
// arrows move between rows, Home and End to its ends; right opens a row,
// left closes it.
function rowKeys(e, els, count, i, open, toggle) {
  const focus = (j) => {
    const el = els[Math.max(0, Math.min(count - 1, j))]
    if (el) el.focus()
  }
  if (e.key === 'ArrowDown') focus(i + 1)
  else if (e.key === 'ArrowUp') focus(i - 1)
  else if (e.key === 'Home') focus(0)
  else if (e.key === 'End') focus(count - 1)
  else if (e.key === 'ArrowRight' && !open) toggle(true)
  else if (e.key === 'ArrowLeft' && open) toggle(false)
  else return
  e.preventDefault()
}
function onRowKey(e, i, g) {
  rowKeys(e, rowEls, shown.value.length, i, openKey.value === g.key, (open) => toggleGroup(g, open))
}
// Escape inside an open skill closes it (and nothing else), back on its row.
function onItemEscape(e, g, i) {
  if (openKey.value !== g.key) return
  e.preventDefault()
  e.stopPropagation()
  toggleGroup(g, false)
  nextTick(() => focusRow(i))
}
// A skill gone from the list (removed) closes.
watch(groups, (list) => {
  if (openKey.value && !list.some((g) => g.key === openKey.value)) openKey.value = null
})

// A copy's folder, short enough to read: the home folder as ~, the
// project's by its name, and an id folder (Claude's synced/<account>_<org>)
// cut to its first characters. The whole path is in its tooltip.
function shortPath(dir) {
  let p = String(dir || '')
  const sep = p.includes('\\') ? '\\' : '/'
  const trim = (base) => String(base).replace(/[\\/]+$/, '')
  const under = (base) => !!base && (p.toLowerCase() === trim(base).toLowerCase() || p.toLowerCase().startsWith(trim(base).toLowerCase() + sep))
  if (project.value && under(project.value)) p = trim(project.value).split(/[\\/]/).pop() + p.slice(trim(project.value).length)
  else if (under(listed.value.home)) p = '~' + p.slice(trim(listed.value.home).length)
  return p
    .split(sep)
    .map((part) => (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(part) || part.length > 32 ? `${part.slice(0, 8)}…` : part)) // i18n-ignore
    .join(sep)
}
const copiedDir = ref('')
let copiedTimer = null
async function copyPath(copy) {
  try {
    if (window.shellApi.writeClipboard) await window.shellApi.writeClipboard(copy.dir)
    else await navigator.clipboard.writeText(copy.dir)
    copiedDir.value = copy.dir
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copiedDir.value = ''), 1500)
  } catch {
    say(t('skills.details.copyFailed', 'Could not copy the path.'), 'error')
  }
}
onBeforeUnmount(() => clearTimeout(copiedTimer))

async function openFolder(copy) {
  const res = await window.shellApi.skillsOpen({ dir: copy.dir, cwd: project.value })
  if (res && res.ok === false) say(res.error, 'error')
}

async function remove(copy) {
  const answer = await askConfirm({
    title: t('skills.remove.confirm', 'Remove the skill "{{name}}"?', { name: copy.name }),
    text: t('skills.remove.text', '{{agents}} will no longer have it. Running agents notice at their next session.', { agents: agentNames(agentsOf(copy)) }),
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

// Every copy that can be removed, after the same two confirmations. A link
// stays (what it points to is not Tessel's to remove); a row of the agent's
// own copies (synced, built in) has nothing to remove, so no Remove all.
async function removeAll(group) {
  const copies = group.removable
  if (!copies.length) return
  const dirs = copies.map((c) => c.dir).join('\n')
  const keeps = group.copies.length > copies.length ? ' ' + t('skills.remove.allKeeps', 'The copies Tessel cannot remove (links) stay.') : ''
  const answer = await askConfirm({
    title: t('skills.remove.allConfirm', 'Remove every copy of "{{name}}"?', { name: group.name }),
    text: t('skills.remove.text', '{{agents}} will no longer have it. Running agents notice at their next session.', { agents: agentNames([...new Set(copies.flatMap(agentsOf))]) }) + keeps,
    code: dirs,
    confirmLabel: t('skills.remove.trash', 'Move to the Recycle Bin'),
    altLabel: t('skills.remove.delete', 'Delete permanently'),
    danger: true
  })
  if (!answer) return
  let mode = 'trash'
  if (answer === 'alt') {
    const sure = await askConfirm({
      title: t('skills.remove.allSure', 'Delete every copy of "{{name}}" permanently?', { name: group.name }),
      text: t('skills.remove.allSureText', 'These folders and every file in them are deleted. This cannot be undone.'),
      code: dirs,
      confirmLabel: t('skills.remove.delete', 'Delete permanently'),
      danger: true
    })
    if (sure !== true) return
    mode = 'delete'
  }
  busy.value = `rm-all:${group.key}` // i18n-ignore
  const failed = []
  try {
    for (const copy of copies) {
      try {
        const res = await window.shellApi.skillsRemove({ dir: copy.dir, mode, cwd: project.value })
        if (!res || !res.ok) failed.push((res && res.error) || t('skills.remove.failed', 'It could not be removed.'))
      } catch (err) {
        failed.push((err && err.message) || String(err))
      }
    }
  } finally {
    busy.value = ''
  }
  if (!failed.length)
    say(
      mode === 'delete'
        ? t('skills.remove.allDeleted', 'Deleted every copy of "{{name}}".', { name: group.name })
        : t('skills.remove.allTrashed', 'Moved every copy of "{{name}}" to the Recycle Bin.', { name: group.name })
    )
  else
    say(t('skills.remove.allPartly', 'Removed {{done}} of {{total}} copies of "{{name}}": {{error}}', { done: copies.length - failed.length, total: copies.length, name: group.name, error: failed[0] }), 'error')
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
  const seq = ++lookSeq
  busy.value = 'look'
  try {
    const res = await window.shellApi.skillsForUpdate(copy.dir)
    if (seq !== lookSeq) return
    if (res && res.ok === false) addError.value = res.error
    else preview.value = res
  } catch (err) {
    if (seq === lookSeq) addError.value = errorText(err)
  } finally {
    if (seq === lookSeq) busy.value = ''
  }
}

// ---------------------------------------------------------------- Add
// Three steps: where it comes from; what was found (one card per skill of a
// repository), read before installing; the agents and the scope. Then the
// result for each folder it went to.
const from = ref('github') // 'github' | 'folder'
const repoInput = ref('')
const repoEl = ref(null)
const candidates = ref(null) // { repo, commit, candidates: [{ path, name, description, files, bytes }] }
const pickedPath = ref(null) // the skill of `candidates` shown
const preview = ref(null) // the package shown before installing
const folderDir = ref('') // the folder chosen (From a folder)
const addError = ref('')
const results = ref(null)
const resultName = ref('') // the skill those results are about
const targets = reactive(Object.fromEntries(ALL_AGENTS.map((a) => [a, false])))
const targetsTouched = ref(false) // chosen by the user: kept from one skill to the next
const scope = ref('user')
// The preview's parts shown: the instructions (formatted, or their source) and the files.
const mdOpen = ref(false)
const mdSource = ref(false)
const filesOpen = ref(false)
// One lookup at a time: the answer to an older one (another skill clicked
// meanwhile, the source changed) is dropped.
let lookSeq = 0
const EXAMPLE_REPO = 'anthropics/skills' // i18n-ignore
const SKILL_FILE = 'SKILL.md' // i18n-ignore

// The agents found on this computer; Claude Code when none is (the window is never empty).
function defaultTargets() {
  for (const a of ALL_AGENTS) targets[a] = installed.value[a] || (a === 'claude' && !ALL_AGENTS.some((x) => installed.value[x]))
}
// The agents can arrive after the window opens: the defaults follow them until the user chooses.
watch(installed, () => {
  if (!targetsTouched.value) defaultTargets()
})

function resetPreview() {
  preview.value = null
  mdOpen.value = false
  mdSource.value = false
  filesOpen.value = false
}
function resetAdd() {
  lookSeq++
  candidates.value = null
  pickedPath.value = null
  resetPreview()
  addError.value = ''
  results.value = null
  resultName.value = ''
  updating.value = null
}
// The Add tab. A finished update is left behind: Add starts afresh.
function openAdd() {
  if (updating.value && results.value && results.value.every((r) => r.ok)) resetAdd()
  tab.value = 'add'
}
function setFrom(kind) {
  if (from.value === kind) return
  from.value = kind
  folderDir.value = ''
  resetAdd()
}
function useExample() {
  repoInput.value = EXAMPLE_REPO
  addError.value = ''
  nextTick(() => repoEl.value && repoEl.value.focus())
}
const errorText = (err) => (err && err.message) || String(err)

async function lookUp(pick = null) {
  const input = repoInput.value.trim()
  if (!input) return
  if (pick == null) resetAdd()
  else {
    addError.value = ''
    results.value = null
    resetPreview()
  }
  pickedPath.value = pick
  const seq = ++lookSeq
  busy.value = pick == null ? 'look' : 'pick'
  try {
    const res = await window.shellApi.skillsFromGithub({ input, pick })
    if (seq !== lookSeq) return
    if (res && res.ok === false) addError.value = res.error
    else if (res && res.candidates) candidates.value = res
    else preview.value = res
  } catch (err) {
    if (seq === lookSeq) addError.value = errorText(err)
  } finally {
    if (seq === lookSeq) busy.value = ''
  }
}

// A skill of the repository: opened (its preview read) or closed again.
function pickCandidate(c) {
  if (pickedPath.value !== c.path) return lookUp(c.path)
  lookSeq++
  pickedPath.value = null
  resetPreview()
  results.value = null
  if (busy.value === 'pick') busy.value = ''
}

async function chooseFolder() {
  const dir = await window.shellApi.pickFolder({
    title: t('skills.add.pickTitle', 'Choose a skill folder (with a SKILL.md)'),
    defaultPath: project.value || undefined
  })
  if (!dir) return
  resetAdd()
  folderDir.value = dir
  const seq = ++lookSeq
  busy.value = 'look'
  try {
    const res = await window.shellApi.skillsFromFolder(dir)
    if (seq !== lookSeq) return
    if (res && res.ok === false) addError.value = res.error
    else preview.value = res
  } catch (err) {
    if (seq === lookSeq) addError.value = errorText(err)
  } finally {
    if (seq === lookSeq) busy.value = ''
  }
}

// What step 2 lists: each skill of the repository, or the one found.
const foundItems = computed(() => {
  if (candidates.value) return candidates.value.candidates.map((c) => ({ ...c, key: c.path }))
  if (!preview.value) return []
  const p = preview.value
  return [{ key: '', path: '', name: p.name, description: p.description, files: p.files.length, bytes: p.totalBytes }]
})
const foundOpen = (item) => (candidates.value ? pickedPath.value === item.path : true)
const foundRowId = (item) => `${uid}-found-${item.key.replace(/[^A-Za-z0-9_-]/g, '_')}` // i18n-ignore
const foundDetailsId = (item) => `${uid}-found-details-${item.key.replace(/[^A-Za-z0-9_-]/g, '_')}` // i18n-ignore
const foundEls = []
function onFoundKey(e, i, item) {
  rowKeys(e, foundEls, foundItems.value.length, i, foundOpen(item), () => pickCandidate(item))
}
// Escape inside an open skill closes it, back on its row.
function onFoundEscape(e, item, i) {
  if (!candidates.value || !foundOpen(item)) return
  e.preventDefault()
  e.stopPropagation()
  pickCandidate(item)
  nextTick(() => foundEls[i] && foundEls[i].focus())
}
// "3 skills in owner/repo @ 1a2b3c4".
const foundLabel = computed(() => {
  if (!candidates.value) return ''
  const count = candidates.value.candidates.length
  const repo = candidates.value.repo + (candidates.value.commit ? ` @ ${candidates.value.commit.slice(0, 7)}` : '') // i18n-ignore commit
  return count === 1
    ? t('skills.add.found', '{{count}} skill in {{repo}}', { count, repo })
    : t('skills.add.found', '{{count}} skills in {{repo}}', { count, repo })
})
const itemSize = (item) => (item.files == null ? item.path : filesSizeLabel(item.files, item.bytes || 0))
// Where the preview comes from, short: owner/repo/path @ commit, or the folder.
function sourceShort(source) {
  if (!source) return ''
  if (source.kind !== 'github') return shortPath(source.path)
  return `${source.owner}/${source.repo}${source.path ? '/' + source.path : ''}${source.commit ? ' @ ' + source.commit.slice(0, 7) : ''}` // i18n-ignore path
}
const sourceTitle = (source) => (source ? sourceLabel(source) + (source.commit ? ` @ ${source.commit}` : '') : '') // i18n-ignore commit

// The instructions: the front matter as key/value pairs, the rest formatted
// (only while shown: a SKILL.md can be long), or the file as it is.
const frontmatter = computed(() => (preview.value ? splitFrontmatter(preview.value.skillMd) : { meta: [], body: '' }))
const mdHtml = computed(() => (preview.value && mdOpen.value && !mdSource.value ? renderSkillMarkdown(frontmatter.value.body) : ''))
// A link in the instructions: a web page opens in the browser, never here.
function onMdClick(e) {
  const a = e.target && e.target.closest ? e.target.closest('a[href]') : null
  if (!a) return
  e.preventDefault()
  const href = a.getAttribute('href') || ''
  if (/^https?:\/\//i.test(href) && window.shellApi.openExternal) window.shellApi.openExternal(href)
}

// Step 3: the agents (chips) and the scope.
const chosenAgents = computed(() => AGENTS.value.filter((a) => targets[a]))
const allChosen = computed(() => AGENTS.value.every((a) => targets[a]))
function toggleTarget(a) {
  targets[a] = !targets[a]
  targetsTouched.value = true
}
function chooseAll(on) {
  for (const a of AGENTS.value) targets[a] = on
  targetsTouched.value = true
}
const agentChipLabel = (a) => (installed.value[a] ? AGENT_NAME[a] : t('skills.add.agentMissing', '{{agent}} (not found on this computer)', { agent: AGENT_NAME[a] }))
// The folders agents share, said only when it matters for the agents chosen.
const sharedNote = computed(() => {
  const chosen = chosenAgents.value
  if (scope.value === 'project' && (chosen.includes('codex') || chosen.includes('antigravity')))
    return t('skills.add.sharedProject', "Codex and Antigravity CLI get it in the project's shared .agents folder, which OpenCode, Copilot CLI and Gemini CLI read too.")
  if (scope.value === 'user' && chosen.includes('codex')) return t('skills.add.codexNote', 'Codex gets it in the shared .agents folder, which OpenCode, Copilot CLI and Gemini CLI read too.')
  return ''
})
const projectName = computed(() => (project.value ? String(project.value).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : ''))
watch(project, (p) => {
  if (!p && scope.value === 'project') scope.value = 'user'
})
// "For Claude Code and Codex · All projects"; three agents or more by their number (the chips name them).
const installSummary = computed(() => {
  const n = chosenAgents.value.length
  if (!n) return ''
  const agents = n <= 2 ? agentNames(chosenAgents.value) : t('skills.add.agentCount', '{{count}} agents', { count: n })
  return t('skills.add.summary', 'For {{agents}} · {{scope}}', { agents, scope: scopeLabel(scope.value) })
})
// Nothing left to do: every folder has it, for the agents and scope still
// chosen (another choice brings the Install button back).
const choiceKey = () => `${scope.value}:${chosenAgents.value.join(',')}` // i18n-ignore
const doneKey = ref('')
const allDone = computed(
  () => !!results.value && results.value.length > 0 && results.value.every((r) => r.ok) && (!!updating.value || doneKey.value === choiceKey())
)

let listing = null // the list read again after an install
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
  busy.value = replaceDir ? `replace:${replaceDir}` : 'install' // i18n-ignore
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
    // Replace it: that folder's line changes, the others stay as they were.
    results.value = replaceDir && results.value ? results.value.map((r) => res.results.find((x) => x.dir === r.dir) || r) : res.results
    resultName.value = res.name
    if (!replaceDir) doneKey.value = choiceKey()
    const done = res.results.filter((r) => r.ok)
    if (done.length)
      say(
        replace && done.some((r) => r.trashed)
          ? t('skills.add.updatedTrashed', 'Updated "{{name}}". The old copy is in the Recycle Bin. Agents use it from their next session.', { name: res.name })
          : replace
          ? t('skills.add.updated', 'Updated "{{name}}". Agents use it from their next session.', { name: res.name })
          : t('skills.add.installed', 'Installed "{{name}}" for {{agents}}. Agents use it from their next session.', {
              name: res.name,
              agents: agentNames([...new Set(done.flatMap((r) => resultAgents(r)))])
            })
      )
  } catch (err) {
    addError.value = errorText(err)
  } finally {
    busy.value = ''
  }
  listing = refresh()
}

// Each result: the agents it was for (one folder can be for two: Codex and
// the Antigravity CLI share a project's .agents), and who else reads it.
const resultAgents = (r) => (r.agents && r.agents.length ? r.agents.filter((a) => ALL_AGENTS.includes(a)) : (r.seenBy || []).filter((a) => AGENTS.value.includes(a)))
const alsoSeen = (r) => (r.seenBy || []).filter((a) => AGENTS.value.includes(a) && !resultAgents(r).includes(a))
function resultState(r) {
  if (r.ok) return t('skills.add.done', 'Installed')
  if (r.exists) return t('skills.add.exists', 'Already there')
  return t('skills.add.failed', 'Failed')
}
const resultsHead = computed(() => {
  const list = results.value || []
  return t('skills.add.resultsDone', '{{done}} of {{total}} done', { done: list.filter((r) => r.ok).length, total: list.length })
})
const alsoSeenLabel = (r) => t('skills.add.alsoSeen', 'Also seen by {{agents}}', { agents: agentNames(alsoSeen(r)) })
const updatingTitle = computed(() => (updating.value ? t('skills.add.updatingName', 'Update {{name}}', { name: updating.value.name }) : ''))
const footSummary = computed(() =>
  updating.value ? t('skills.add.updateSummary', 'Replaces the copy in {{path}}', { path: shortPath(updating.value.dir) }) : installSummary.value
)

// The skill just installed, opened in the Installed list.
async function viewInstalled() {
  const name = String(resultName.value || (preview.value && preview.value.name) || '').toLowerCase()
  const kind = preview.value && preview.value.source && preview.value.source.kind === 'folder' ? 'folder' : 'github'
  query.value = ''
  originFilter.value = 'all'
  tab.value = 'installed'
  if (listing) await listing
  const g = groups.value.find((x) => x.key === `${kind}:${name}`) || groups.value.find((x) => x.name.toLowerCase() === name)
  if (!g) return
  toggleGroup(g, true)
  await nextTick()
  const el = rowEls[shown.value.indexOf(g)]
  if (!el) return
  el.focus()
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
}
function addAnother() {
  resetAdd()
  folderDir.value = ''
  if (from.value === 'github') {
    repoInput.value = ''
    nextTick(() => repoEl.value && repoEl.value.focus())
  }
}
function cancelUpdate() {
  resetAdd()
  tab.value = 'installed'
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
// rules) and Muse Code's (skills, commands, hooks and MCP servers), listed
// like the skills: one row each, its details on a click. Turned on or off and
// uninstalled with each one's own commands (src/main/agyPlugins.js,
// musePlugins.js). Installing one can ask questions (a plugin's settings
// form, its hooks' approval): it runs in a pane the user sees. One tab per
// agent installed here.
const PLUGIN_API = {
  antigravity: { list: 'agyPluginsList', set: 'agyPluginsSet', remove: 'agyPluginsRemove' },
  muse: { list: 'musePluginsList', set: 'musePluginsSet', remove: 'musePluginsRemove' }
}
const pluginAgents = computed(() => Object.keys(PLUGIN_API).filter((id) => installed.value[id] && !!window.shellApi[PLUGIN_API[id].list]))
const showPlugins = computed(() => pluginAgents.value.length > 0)
const pluginAgent = ref('antigravity')
const pluginApi = (op) => window.shellApi[PLUGIN_API[pluginAgent.value][op]]
const musePlugins = computed(() => pluginAgent.value === 'muse')
// Its own words: which agent, its marketplace, its panes.
const pluginWords = {
  intro: () =>
    musePlugins.value
      ? t('skills.musePlugins.intro', 'Muse Code plugins bundle skills, commands, hooks and MCP servers. Browse them with /plugins in a Muse Code pane, or install one here from a folder or by name (name@marketplace). Muse asks you to approve the hooks of a plugin before they run.')
      : t('skills.plugins.intro', 'Antigravity CLI plugins bundle skills, MCP servers, subagents, hooks and rules. Browse its marketplace with /plugin in an Antigravity CLI pane, or install one here by name or from a folder.'),
  placeholder: () => (musePlugins.value ? t('skills.musePlugins.placeholder', 'name@marketplace') : t('skills.plugins.placeholder', 'name@antigravity-plugins-official')),
  empty: () => (musePlugins.value ? t('skills.musePlugins.empty', 'No Muse Code plugins installed.') : t('skills.plugins.empty', 'No Antigravity CLI plugins installed.')),
  turnedOff: (name) =>
    musePlugins.value
      ? t('skills.musePlugins.turnedOff', 'Turned off "{{name}}". Muse Code panes use the change from their next start.', { name })
      : t('skills.plugins.turnedOff', 'Turned off "{{name}}". Antigravity CLI panes use the change from their next start.', { name }),
  turnedOn: (name) =>
    musePlugins.value
      ? t('skills.musePlugins.turnedOn', 'Turned on "{{name}}". Muse Code panes use the change from their next start.', { name })
      : t('skills.plugins.turnedOn', 'Turned on "{{name}}". Antigravity CLI panes use the change from their next start.', { name }),
  failed: () => (musePlugins.value ? t('skills.musePlugins.failed', 'Muse Code could not change it.') : t('skills.plugins.failed', 'The Antigravity CLI could not change it.')),
  removeText: () =>
    musePlugins.value
      ? t('skills.musePlugins.removeText', 'Muse Code deletes its installed copy, with the skills, commands, hooks and MCP servers it brought.')
      : t('skills.plugins.removeText', 'The Antigravity CLI deletes its folder, with the skills, MCP servers and hooks it brought.'),
  installPane: (name) => (musePlugins.value ? t('skills.musePlugins.installPane', 'Muse plugin: {{name}}', { name }) : t('skills.plugins.installPane', 'Antigravity plugin: {{name}}', { name })),
  pickTitle: () =>
    musePlugins.value ? t('skills.musePlugins.pickTitle', 'Choose a plugin folder (with its .muse-plugin or .claude-plugin folder)') : t('skills.plugins.pickTitle', 'Choose a plugin folder (with a plugin.json)'),
  onHint: () => (musePlugins.value ? t('skills.musePlugins.onHint', 'On: Muse Code panes load it when they start.') : t('skills.plugins.onHint', 'On: Antigravity CLI panes load it when they start.')),
  offHint: () => (musePlugins.value ? t('skills.musePlugins.offHint', 'Off: Muse Code panes do not load it.') : t('skills.plugins.offHint', 'Off: Antigravity CLI panes do not load it.'))
}
const plugins = ref([])
const pluginsLoading = ref(false)
const pluginsLoaded = ref(false)
const pluginsError = ref('')
const pluginTarget = ref('')
async function loadPlugins() {
  const list = showPlugins.value ? pluginApi('list') : null
  if (!list) return
  pluginsLoading.value = true
  pluginsError.value = ''
  try {
    const res = await list()
    if (res && res.ok === false) pluginsError.value = res.error
    else {
      plugins.value = (res && res.plugins) || []
      if (res && res.error) pluginsError.value = res.error
    }
  } catch (err) {
    pluginsError.value = errorText(err)
  } finally {
    pluginsLoading.value = false
    pluginsLoaded.value = true
  }
}
function openPlugins(agent = 'antigravity') {
  if (pluginAgent.value !== agent) {
    pluginAgent.value = agent
    plugins.value = []
    pluginsError.value = ''
    pluginsLoaded.value = false
    pluginOpen.value = null
  }
  tab.value = 'plugins'
  loadPlugins()
}
const pluginsCountLabel = computed(() =>
  plugins.value.length === 1
    ? t('skills.plugins.count', '{{count}} plugin', { count: 1 })
    : t('skills.plugins.count', '{{count}} plugins', { count: plugins.value.length })
)
// What a plugin bundles: "2 skills", "1 MCP server"…
function pluginPartList(p) {
  const c = p.counts || {}
  const parts = []
  if (c.skills) parts.push(c.skills === 1 ? t('skills.plugins.skillOne', '1 skill') : t('skills.plugins.skillMany', '{{count}} skills', { count: c.skills }))
  if (c.mcpServers) parts.push(c.mcpServers === 1 ? t('skills.plugins.mcpOne', '1 MCP server') : t('skills.plugins.mcpMany', '{{count}} MCP servers', { count: c.mcpServers }))
  if (c.agents) parts.push(c.agents === 1 ? t('skills.plugins.agentOne', '1 subagent') : t('skills.plugins.agentMany', '{{count}} subagents', { count: c.agents }))
  if (c.hooks) parts.push(t('skills.plugins.hooks', 'hooks'))
  if (c.rules) parts.push(t('skills.plugins.rules', 'rules'))
  if (c.commands) parts.push(c.commands === 1 ? t('skills.plugins.commandOne', '1 command') : t('skills.plugins.commandMany', '{{count}} commands', { count: c.commands }))
  return parts
}
// Where Muse says a plugin came from (its install record's provenance), in words.
function museFrom(source) {
  if (source === 'native-local') return t('skills.musePlugins.fromFolder', 'Installed from a folder')
  if (source === 'foreign-import') return t('skills.musePlugins.fromImport', 'Imported from a Claude Code or Codex plugin')
  if (source === 'marketplace-user-added') return t('skills.musePlugins.fromMarketplace', 'From a marketplace')
  return source ? t('skills.plugins.from', 'From {{source}}', { source }) : ''
}
const pluginFrom = (p) => (musePlugins.value ? museFrom(p.source) : p.source ? t('skills.plugins.from', 'From {{source}}', { source: p.source }) : '')
const pluginParts = (p) => pluginPartList(p).join(' · ') || pluginFrom(p) || t('skills.plugins.nothing', 'Nothing listed in it.')

// One plugin open at a time, with the same keys as the skills list.
const pluginOpen = ref(null)
const pluginEls = []
const pluginRowId = (p) => `${uid}-plugin-${p.name.replace(/[^A-Za-z0-9_-]/g, '_')}` // i18n-ignore
const pluginDetailsId = (p) => `${uid}-plugin-details-${p.name.replace(/[^A-Za-z0-9_-]/g, '_')}` // i18n-ignore
function togglePluginRow(p, open = pluginOpen.value !== p.name) {
  pluginOpen.value = open ? p.name : null
}
function onPluginKey(e, i, p) {
  rowKeys(e, pluginEls, plugins.value.length, i, pluginOpen.value === p.name, (open) => togglePluginRow(p, open))
}
function onPluginEscape(e, p, i) {
  if (pluginOpen.value !== p.name) return
  e.preventDefault()
  e.stopPropagation()
  togglePluginRow(p, false)
  nextTick(() => pluginEls[i] && pluginEls[i].focus())
}
watch(plugins, (list) => {
  if (pluginOpen.value && !list.some((p) => p.name === pluginOpen.value)) pluginOpen.value = null
})

async function togglePlugin(p) {
  busy.value = `plugin:${p.name}` // i18n-ignore
  try {
    const res = await pluginApi('set')({ name: p.name, enabled: !p.enabled })
    if (res && res.ok) say(p.enabled ? pluginWords.turnedOff(p.name) : pluginWords.turnedOn(p.name))
    else say((res && res.error) || pluginWords.failed(), 'error')
  } finally {
    busy.value = ''
  }
  loadPlugins()
}
async function removePlugin(p) {
  const ok = await askConfirm({
    title: t('skills.plugins.removeConfirm', 'Uninstall the plugin "{{name}}"?', { name: p.name }),
    text: pluginWords.removeText(),
    confirmLabel: t('skills.plugins.uninstall', 'Uninstall'),
    danger: true
  })
  if (ok !== true) return
  busy.value = `plugin:${p.name}` // i18n-ignore
  try {
    const res = await pluginApi('remove')({ name: p.name })
    if (res && res.ok) say(t('skills.plugins.removed', 'Uninstalled "{{name}}".', { name: p.name }))
    else say((res && res.error) || pluginWords.failed(), 'error')
  } finally {
    busy.value = ''
  }
  loadPlugins()
}
// A marketplace name (name@antigravity-plugins-official, name@marketplace)
// or a folder: the install runs in a pane the user sees. Only a name or a
// plain path goes on the command line (nothing a shell would read as more).
const PLUGIN_TARGET = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,150}$/
const PLUGIN_FOLDER = /^[A-Za-z]:\\[^"'`$;&|<>%\r\n]{1,250}$/
function runPluginInstall(target) {
  const command = musePlugins.value ? `muse plugins install "${target}"` : `agy plugin install "${target}"` // i18n-ignore
  emit('run', { label: pluginWords.installPane(target), command })
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
  const dir = await window.shellApi.pickFolder({ title: pluginWords.pickTitle() })
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
  defaultTargets()
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
            {{ t('skills.tab.installed', 'Installed') }}<span v-if="groups.length" class="mcp-count">{{ groups.length }}</span>
          </button>
          <button class="launch-seg-btn" :class="{ on: tab === 'add' }" data-test="skills-tab-add" @click="openAdd">
            {{ t('skills.tab.add', 'Add') }}
          </button>
          <button
            v-for="id in pluginAgents"
            :key="id"
            class="launch-seg-btn"
            :class="{ on: tab === 'plugins' && pluginAgent === id }"
            :data-test="id === 'muse' ? 'skills-tab-muse-plugins' : 'skills-tab-plugins'"
            @click="openPlugins(id)"
          >
            {{ id === 'muse' ? t('skills.tab.musePlugins', 'Muse plugins') : t('skills.tab.plugins', 'Antigravity plugins') }}
          </button>
        </div>
      </div>

      <p v-if="message.text" :class="message.kind === 'error' ? 'mcp-error' : 'mcp-notice'">{{ message.text }}</p>

      <!-- ================= Installed ================= -->
      <template v-if="tab === 'installed'">
        <div class="mcp-toolbar skills-toolbar">
          <input
            v-model="query"
            class="set-number skills-search"
            :placeholder="t('skills.installed.search', 'Search skills')"
            :aria-label="t('skills.installed.search', 'Search skills')"
            spellcheck="false"
          />
          <span class="set-hint skills-count" aria-live="polite">
            <template v-if="loading">{{ t('skills.loading', 'Loading…') }}</template>
            <template v-else>{{ countLabel }}</template>
            <span v-if="checkedLabel" class="skills-checked">· {{ checkedLabel }}</span>
          </span>
          <button
            type="button"
            class="exit-btn skills-btn"
            :disabled="loading || checking"
            :title="t('skills.installed.refreshHint', 'Read the skill folders again and check GitHub for updates')"
            @click="refreshAll"
          >
            {{ t('skills.installed.refresh', 'Refresh') }}
          </button>
        </div>

        <div v-if="showFilter" class="skills-filter" role="group" :aria-label="t('skills.filter.label', 'Show')">
          <button
            v-for="f in visibleFilters"
            :key="f"
            type="button"
            class="skills-chip"
            :class="{ on: originFilter === f }"
            :aria-pressed="originFilter === f"
            :data-filter="f"
            @click="originFilter = f"
          >
            {{ filterLabel(f) }}<span class="skills-chip-count">{{ counts[f] }}</span>
          </button>
        </div>

        <!-- The first read: placeholder rows, the size of real ones. -->
        <ul v-if="loading && !groups.length" class="skills-list" aria-busy="true" :aria-label="t('skills.loading', 'Loading…')">
          <li v-for="n in 3" :key="n" class="skills-item skills-skeleton" aria-hidden="true">
            <span class="skills-skel-icon" />
            <span class="skills-skel-lines"><span /><span /></span>
          </li>
        </ul>

        <div v-else-if="!groups.length" class="mcp-empty">
          {{ t('skills.installed.empty', 'No skills yet.') }}
          <button type="button" class="exit-btn primary skills-btn" @click="openAdd">{{ t('skills.installed.addOne', 'Add a skill') }}</button>
        </div>

        <div v-else-if="!shown.length" class="mcp-empty skills-nomatch">
          {{ t('skills.installed.noMatch', 'No skill matches this search or filter.') }}
          <button type="button" class="exit-btn skills-btn" @click="showAll">{{ t('skills.installed.showAll', 'Show every skill') }}</button>
        </div>

        <ul v-else class="skills-list" :aria-label="t('skills.installed.listLabel', 'Installed skills')">
          <li
            v-for="(g, i) in shown"
            :key="g.key"
            class="skills-item"
            :class="{ open: openKey === g.key }"
            :data-skill="g.name"
            @keydown.escape="onItemEscape($event, g, i)"
          >
            <button
              :id="rowId(g)"
              :ref="(el) => (rowEls[i] = el)"
              type="button"
              class="skills-row"
              :aria-expanded="openKey === g.key"
              :aria-controls="detailsId(g)"
              @click="toggleGroup(g)"
              @keydown="onRowKey($event, i, g)"
            >
              <BrandIcon class="skills-row-icon" :kind="'skill-' + g.name" accent="#8a93a6" :label="g.name" :size="20" />
              <span class="skills-row-main">
                <span class="skills-row-top">
                  <span class="skills-row-name">{{ g.name }}</span>
                  <span class="skills-tag skills-origin" :class="'origin-' + g.kind" :title="kindTitle(g)">{{ kindLabel(g.kind) }}</span>
                  <span v-if="g.modified" class="skills-tag skills-modified" :title="t('skills.modified.hint', 'Changed on this computer since it was installed.')">{{
                    t('skills.modified.badge', 'Modified locally')
                  }}</span>
                  <span v-if="g.update" class="skills-tag skills-update" :title="updateTitle(g.update)">{{ t('skills.updates.badge', 'Update available') }}</span>
                  <span v-if="g.partial" class="skills-tag skills-partial" :title="partialHint">{{ t('skills.history.partialBadge', 'Partly kept') }}</span>
                </span>
                <span class="skills-row-desc" :title="g.description || undefined">{{ g.description || t('skills.installed.noDescription', 'No description.') }}</span>
              </span>
              <span class="skills-row-meta">
                <span v-if="g.agents.length" class="skills-agents" role="img" :aria-label="seenByNames(g.agents)" :title="seenByNames(g.agents)">
                  <BrandIcon v-for="a in g.agents" :key="a" :kind="a" :size="14" />
                </span>
                <span v-for="s in g.scopes" :key="s" class="skills-tag skills-scope">{{ scopeLabel(s) }}</span>
              </span>
              <svg class="skills-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>

            <!-- Its details: the whole description, then each copy. -->
            <div v-if="openKey === g.key" :id="detailsId(g)" class="skills-details" role="region" :aria-labelledby="rowId(g)">
              <p class="skills-details-desc">{{ g.description || t('skills.installed.noDescription', 'No description.') }}</p>
              <div class="skills-section-head">
                <span>{{ t('skills.details.where', 'Where it is installed') }}</span>
                <button v-if="g.removable.length > 1" type="button" class="exit-btn skills-btn skills-remove-all" :disabled="!!busy" @click="removeAll(g)">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                  {{ t('skills.details.removeAll', 'Remove all') }}
                </button>
              </div>
              <p v-if="g.versions > 1" class="set-hint skills-versions-note">
                {{ versionsLabel(g.versions) }}
              </p>
              <ul class="skills-copies">
                <li v-for="copy in g.copies" :key="copy.id" class="skills-copy" :data-dir="copy.dir">
                  <div class="skills-copy-line">
                    <span v-if="agentsOf(copy).length" class="skills-agents" aria-hidden="true">
                      <BrandIcon v-for="a in agentsOf(copy)" :key="a" :kind="a" :size="14" />
                    </span>
                    <span class="skills-copy-agents" :title="seenByNames(agentsOf(copy))">{{ agentNames(agentsOf(copy)) }}</span>
                    <span class="skills-tag skills-scope">{{ scopeLabel(copy.scope) }}</span>
                    <span class="skills-tag skills-origin" :class="'origin-' + kindOf(copy)" :title="originTitle(copy)">{{ originLabel(copy) }}</span>
                    <span v-if="copy.link" class="skills-tag muted">{{ t('skills.installed.link', 'Link') }}</span>
                    <span v-if="copy.modified" class="skills-tag skills-modified" :title="t('skills.modified.hint', 'Changed on this computer since it was installed.')">{{
                      t('skills.modified.badge', 'Modified locally')
                    }}</span>
                    <span v-if="copy.update && copy.update.available" class="skills-tag skills-update" :title="updateTitle(copy)">{{
                      t('skills.updates.badge', 'Update available')
                    }}</span>
                    <span v-if="copy.history && copy.history.partial" class="skills-tag skills-partial" :title="partialHint">{{
                      t('skills.history.partialBadge', 'Partly kept')
                    }}</span>
                  </div>
                  <div class="skills-copy-foot">
                    <span class="skills-copy-path">
                      <span class="skills-path" :title="copy.dir">{{ shortPath(copy.dir) }}</span>
                      <button
                        type="button"
                        class="ws-icon-btn small skills-copy-btn"
                        :class="{ on: copiedDir === copy.dir }"
                        :title="copiedDir === copy.dir ? t('skills.details.copied', 'Copied') : t('skills.details.copyPath', 'Copy the path')"
                        :aria-label="t('skills.details.copyPath', 'Copy the path')"
                        @click="copyPath(copy)"
                      >
                        <svg v-if="copiedDir === copy.dir" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                        <svg v-else width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2" />
                          <path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" stroke="currentColor" stroke-width="1.2" />
                        </svg>
                      </button>
                    </span>
                    <span class="skills-actions">
                      <button type="button" class="exit-btn skills-btn" @click="openFolder(copy)">
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                        </svg>
                        {{ t('skills.installed.open', 'Open folder') }}
                      </button>
                      <button
                        v-if="copy.removable && copy.source && copy.source.kind === 'github'"
                        type="button"
                        class="exit-btn skills-btn"
                        :class="{ primary: copy.update && copy.update.available }"
                        :disabled="!!busy"
                        @click="update(copy)"
                      >
                        {{ t('skills.installed.update', 'Update') }}
                      </button>
                      <button
                        v-if="copy.removable"
                        type="button"
                        class="ws-icon-btn small danger"
                        :title="t('skills.installed.remove', 'Remove')"
                        :aria-label="t('skills.details.removeCopy', 'Remove this copy')"
                        :disabled="!!busy"
                        @click="remove(copy)"
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                      </button>
                    </span>
                  </div>
                  <p v-if="copy.update && copy.update.available && updateTitle(copy)" class="set-hint skills-update-line">{{ updateTitle(copy) }}</p>
                  <div v-if="copy.history && copy.history.versions" class="set-hint skills-history-line">
                    {{ changedLabel(copy) }}
                    <button type="button" class="skills-link" :aria-expanded="historyOpen === copy.id" @click="toggleHistory(copy)">
                      {{ historyOpen === copy.id ? t('skills.history.hide', 'Hide history') : t('skills.history.show', 'History') }}
                    </button>
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
                            class="exit-btn skills-btn"
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
                </li>
              </ul>
            </div>
          </li>
        </ul>
      </template>

      <!-- ================= Antigravity / Muse plugins ================= -->
      <template v-else-if="tab === 'plugins'">
        <p class="set-hint skills-plugins-intro">{{ pluginWords.intro() }}</p>
        <form class="skills-plugin-form" @submit.prevent="installPlugin">
          <div class="skills-field" :class="{ invalid: !!pluginsError }">
            <svg class="skills-field-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 01-7 0zM8 11v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <input
              v-model="pluginTarget"
              class="skills-field-input"
              :placeholder="pluginWords.placeholder()"
              :aria-label="t('skills.plugins.targetLabel', 'Plugin name or folder')"
              :aria-invalid="pluginsError ? 'true' : undefined"
              spellcheck="false"
              autocomplete="off"
              :data-test="musePlugins ? 'muse-plugin-target' : 'agy-plugin-target'"
            />
            <button class="exit-btn primary skills-btn skills-field-btn" type="submit" :disabled="!pluginTarget.trim()">{{ t('skills.plugins.install', 'Install') }}</button>
          </div>
          <button class="exit-btn skills-btn skills-plugin-folder" type="button" @click="installPluginFolder">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
            </svg>
            {{ t('skills.plugins.fromFolder', 'From a folder…') }}
          </button>
        </form>
        <p v-if="pluginsError" class="skills-add-error" role="alert">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 2.2l6.2 11H1.8zM8 6.5v3.2M8 11.6h.01" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>{{ pluginsError }}</span>
        </p>

        <div class="mcp-toolbar skills-toolbar">
          <span class="set-hint skills-count" aria-live="polite">
            <template v-if="pluginsLoading">{{ t('skills.loading', 'Loading…') }}</template>
            <template v-else-if="pluginsLoaded">{{ pluginsCountLabel }}</template>
          </span>
          <button type="button" class="exit-btn skills-btn" :disabled="pluginsLoading" @click="loadPlugins">{{ t('skills.installed.refresh', 'Refresh') }}</button>
        </div>

        <ul v-if="pluginsLoading && !plugins.length" class="skills-list" aria-busy="true" :aria-label="t('skills.loading', 'Loading…')">
          <li v-for="n in 2" :key="n" class="skills-item skills-skeleton" aria-hidden="true">
            <span class="skills-skel-icon" />
            <span class="skills-skel-lines"><span /><span /></span>
          </li>
        </ul>
        <div v-else-if="pluginsLoaded && !plugins.length && !pluginsError" class="mcp-empty">
          {{ pluginWords.empty() }}
        </div>
        <ul v-else-if="plugins.length" class="skills-list" :aria-label="t('skills.plugins.listLabel', 'Installed plugins')">
          <li
            v-for="(p, i) in plugins"
            :key="p.name"
            class="skills-item"
            :class="{ open: pluginOpen === p.name, off: !p.enabled }"
            :data-test="(musePlugins ? 'muse-plugin-' : 'agy-plugin-') + p.name"
            @keydown.escape="onPluginEscape($event, p, i)"
          >
            <button
              :id="pluginRowId(p)"
              :ref="(el) => (pluginEls[i] = el)"
              type="button"
              class="skills-row"
              :aria-expanded="pluginOpen === p.name"
              :aria-controls="pluginDetailsId(p)"
              @click="togglePluginRow(p)"
              @keydown="onPluginKey($event, i, p)"
            >
              <BrandIcon class="skills-row-icon" :kind="'plugin-' + p.name" accent="#8a93a6" :label="p.name" :size="20" />
              <span class="skills-row-main">
                <span class="skills-row-top">
                  <span class="skills-row-name">{{ p.label || p.name }}</span>
                  <span v-if="p.version" class="skills-tag skills-scope">{{ p.version }}</span>
                  <span v-if="!p.enabled" class="skills-tag skills-off">{{ t('skills.plugins.off', 'Turned off') }}</span>
                </span>
                <span class="skills-row-desc">{{ pluginParts(p) }}</span>
              </span>
              <svg class="skills-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <div v-if="pluginOpen === p.name" :id="pluginDetailsId(p)" class="skills-details" role="region" :aria-labelledby="pluginRowId(p)">
              <p v-if="p.description" class="skills-details-desc">{{ p.description }}</p>
              <p v-if="pluginFrom(p)" class="skills-details-desc">{{ pluginFrom(p) }}</p>
              <div class="skills-section-head">
                <span>{{ t('skills.plugins.bundles', 'What it brings') }}</span>
              </div>
              <div class="skills-plugin-parts">
                <span v-for="part in pluginPartList(p)" :key="part" class="skills-tag">{{ part }}</span>
                <span v-if="!pluginPartList(p).length" class="set-hint">{{ t('skills.plugins.nothing', 'Nothing listed in it.') }}</span>
              </div>
              <div class="skills-plugin-foot">
                <span class="set-hint skills-plugin-state">
                  {{ p.enabled ? pluginWords.onHint() : pluginWords.offHint() }}
                </span>
                <span class="skills-actions">
                  <button type="button" class="exit-btn skills-btn" :disabled="!!busy" :data-test="musePlugins ? 'muse-plugin-toggle' : 'agy-plugin-toggle'" @click="togglePlugin(p)">
                    {{ p.enabled ? t('skills.plugins.turnOff', 'Turn off') : t('skills.plugins.turnOn', 'Turn on') }}
                  </button>
                  <button type="button" class="exit-btn skills-btn skills-remove-all" :disabled="!!busy" :data-test="musePlugins ? 'muse-plugin-remove' : 'agy-plugin-remove'" @click="removePlugin(p)">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                    {{ t('skills.plugins.uninstall', 'Uninstall') }}
                  </button>
                </span>
              </div>
            </div>
          </li>
        </ul>
      </template>

      <!-- ================= Add ================= -->
      <div v-else class="skills-add" :aria-busy="busy === 'install' ? 'true' : undefined">
        <!-- An update: what is updated, instead of a source to choose. -->
        <section v-if="updating" class="skills-step skills-updating" :aria-labelledby="uid + '-step-update'">
          <div class="skills-step-head">
            <h3 :id="uid + '-step-update'" class="skills-step-title">{{ updatingTitle }}</h3>
            <button type="button" class="skills-link skills-step-aside" @click="cancelUpdate">{{ t('skills.add.cancelUpdate', 'Back to the list') }}</button>
          </div>
          <span class="skills-path" :title="updating.dir">{{ shortPath(updating.dir) }}</span>
          <p v-if="busy === 'look'" class="set-hint skills-looking">
            <span class="skills-spinner" aria-hidden="true" />{{ t('skills.add.lookingUpdate', 'Getting the newest version from GitHub…') }}
          </p>
        </section>

        <!-- Step 1: where it comes from. -->
        <section v-else class="skills-step" :aria-labelledby="uid + '-step-source'">
          <div class="skills-step-head">
            <span class="skills-step-num" aria-hidden="true">1</span>
            <h3 :id="uid + '-step-source'" class="skills-step-title">{{ t('skills.add.stepSource', 'Where it comes from') }}</h3>
          </div>
          <div class="skills-sources" role="group" :aria-label="t('skills.add.sourceLabel', 'Add a skill from')">
            <button type="button" class="skills-source" :class="{ on: from === 'github' }" :aria-pressed="from === 'github'" data-source="github" @click="setFrom('github')">
              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
                />
              </svg>
              GitHub
            </button>
            <button type="button" class="skills-source" :class="{ on: from === 'folder' }" :aria-pressed="from === 'folder'" data-source="folder" @click="setFrom('folder')">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              </svg>
              {{ t('skills.add.folderTab', 'Folder') }}
            </button>
          </div>

          <form v-if="from === 'github'" class="skills-source-form" @submit.prevent="lookUp()">
            <div class="skills-field" :class="{ invalid: !!addError }">
              <input
                ref="repoEl"
                v-model="repoInput"
                class="skills-field-input"
                :placeholder="t('skills.add.repoPlaceholder', 'owner/repo, owner/repo/path or a github.com address')"
                :aria-label="t('skills.add.repo', 'Repository')"
                :aria-invalid="addError ? 'true' : undefined"
                :aria-describedby="addError ? uid + '-repo-hint ' + uid + '-add-error' : uid + '-repo-hint'"
                spellcheck="false"
                autocomplete="off"
                data-test="skills-repo"
              />
              <button class="exit-btn primary skills-btn skills-field-btn" type="submit" :disabled="!!busy || !repoInput.trim()" data-test="skills-look">
                <span v-if="busy === 'look'" class="skills-spinner" aria-hidden="true" />
                {{ busy === 'look' ? t('skills.add.looking', 'Looking…') : t('skills.add.look', 'Look up') }}
              </button>
            </div>
            <p :id="uid + '-repo-hint'" class="set-hint skills-field-hint">
              {{ t('skills.add.exampleLabel', 'For example:') }}
              <button type="button" class="skills-link skills-example" @click="useExample">{{ EXAMPLE_REPO }}</button>
              <span class="skills-hint-more">{{ t('skills.add.exampleMore', 'Add a folder path to pick one skill, or paste a github.com address.') }}</span>
            </p>
          </form>
          <div v-else class="skills-source-form">
            <div class="skills-folder-row">
              <button type="button" class="exit-btn primary skills-btn" :disabled="!!busy" data-test="skills-choose-folder" @click="chooseFolder">
                <span v-if="busy === 'look'" class="skills-spinner" aria-hidden="true" />
                {{ busy === 'look' ? t('skills.add.looking', 'Looking…') : t('skills.add.chooseFolder', 'Choose a folder…') }}
              </button>
              <span v-if="folderDir" class="skills-path" :title="folderDir">{{ shortPath(folderDir) }}</span>
            </div>
            <p class="set-hint skills-field-hint">{{ t('skills.add.folderHint', 'A folder with a SKILL.md at its top') }}</p>
          </div>
        </section>

        <p v-if="addError" :id="uid + '-add-error'" class="skills-add-error" role="alert">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 2.2l6.2 11H1.8zM8 6.5v3.2M8 11.6h.01" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>{{ addError }}</span>
        </p>

        <!-- Step 2: what was found, read before installing. -->
        <section v-if="foundItems.length" class="skills-step" :aria-labelledby="uid + '-step-found'">
          <div class="skills-step-head">
            <span v-if="!updating" class="skills-step-num" aria-hidden="true">2</span>
            <h3 :id="uid + '-step-found'" class="skills-step-title">
              {{ updating ? t('skills.add.stepNew', 'The new version') : t('skills.add.stepFound', 'What it does') }}
            </h3>
            <span v-if="candidates" class="set-hint skills-step-aside" :title="foundLabel">{{ foundLabel }}</span>
          </div>
          <p v-if="candidates" class="set-hint skills-step-hint">{{ t('skills.add.severalHint', 'This repository has several skills. Open one to read it, then install it.') }}</p>
          <ul class="skills-list skills-found" :aria-label="t('skills.add.foundLabel', 'Skills found')">
            <li
              v-for="(item, i) in foundItems"
              :key="item.key"
              class="skills-item"
              :class="{ open: foundOpen(item), single: !candidates }"
              :data-skill="item.name"
              @keydown.escape="onFoundEscape($event, item, i)"
            >
              <button
                v-if="candidates"
                :id="foundRowId(item)"
                :ref="(el) => (foundEls[i] = el)"
                type="button"
                class="skills-row"
                :aria-expanded="foundOpen(item)"
                :aria-controls="foundDetailsId(item)"
                @click="pickCandidate(item)"
                @keydown="onFoundKey($event, i, item)"
              >
                <BrandIcon class="skills-row-icon" :kind="'skill-' + item.name" accent="#8a93a6" :label="item.name" :size="20" />
                <span class="skills-row-main">
                  <span class="skills-row-top">
                    <span class="skills-row-name">{{ item.name }}</span>
                    <span class="skills-row-path" :title="item.path">{{ item.path }}</span>
                  </span>
                  <span class="skills-row-desc" :title="item.description || undefined">{{ item.description || t('skills.installed.noDescription', 'No description.') }}</span>
                </span>
                <span v-if="!foundOpen(item)" class="skills-row-meta">
                  <span class="set-hint skills-row-size">{{ itemSize(item) }}</span>
                </span>
                <svg class="skills-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <div v-else :id="foundRowId(item)" class="skills-row skills-row-static">
                <BrandIcon class="skills-row-icon" :kind="'skill-' + item.name" accent="#8a93a6" :label="item.name" :size="20" />
                <span class="skills-row-main">
                  <span class="skills-row-top">
                    <span class="skills-row-name">{{ item.name }}</span>
                  </span>
                  <span class="skills-row-desc">{{ item.description || t('skills.installed.noDescription', 'No description.') }}</span>
                </span>
              </div>

              <!-- The preview: what will be installed, exactly. -->
              <div v-if="foundOpen(item)" :id="foundDetailsId(item)" class="skills-details skills-preview" role="region" :aria-labelledby="foundRowId(item)">
                <p v-if="busy === 'pick' && !preview" class="set-hint skills-looking"><span class="skills-spinner" aria-hidden="true" />{{ t('skills.loading', 'Loading…') }}</p>
                <template v-else-if="preview">
                  <div class="skills-pv-meta">
                    <span class="skills-tag skills-origin" :class="'origin-' + (preview.source.kind === 'github' ? 'github' : 'folder')">{{ kindLabel(preview.source.kind === 'github' ? 'github' : 'folder') }}</span>
                    <span class="skills-pv-source" :title="sourceTitle(preview.source)">{{ sourceShort(preview.source) }}</span>
                    <button
                      type="button"
                      class="skills-link skills-pv-files"
                      :aria-expanded="filesOpen"
                      :aria-controls="uid + '-files'"
                      :title="t('skills.preview.filesHint', 'Show the files')"
                      @click="filesOpen = !filesOpen"
                    >
                      {{ filesLabel(preview) }}
                    </button>
                  </div>
                  <p v-if="candidates && preview.description" class="skills-details-desc">{{ preview.description }}</p>
                  <table v-if="filesOpen" :id="uid + '-files'" class="skills-files">
                    <tbody>
                      <tr v-for="f in preview.files" :key="f.path">
                        <td class="skills-file-path" :title="f.path">{{ f.path }}</td>
                        <td class="skills-file-size">{{ size(f.size) }}</td>
                      </tr>
                    </tbody>
                  </table>

                  <p v-if="updating && updating.modified" class="skills-callout warn skills-warn">
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

                  <div class="skills-callout skills-safety">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M8 1.8l5 2v4.1c0 3.1-2.1 5.4-5 6.3-2.9-.9-5-3.2-5-6.3V3.8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                      <path d="M8 5.2v3.3M8 10.6h.01" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                    </svg>
                    <span class="skills-callout-text">{{ t('skills.preview.review', 'Read it before installing: an agent follows these instructions.') }}</span>
                    <button
                      type="button"
                      class="exit-btn skills-btn skills-read-btn"
                      :aria-expanded="mdOpen"
                      :aria-controls="uid + '-md'"
                      data-test="skills-read"
                      @click="mdOpen = !mdOpen"
                    >
                      {{ mdOpen ? t('skills.preview.hideInstructions', 'Hide the instructions') : t('skills.preview.readInstructions', 'Read the instructions') }}
                    </button>
                  </div>
                  <div v-if="mdOpen" :id="uid + '-md'" class="skills-md-box">
                    <div class="skills-md-bar">
                      <span class="skills-md-file">{{ SKILL_FILE }}</span>
                      <button type="button" class="skills-link" :aria-pressed="mdSource" data-test="skills-source-toggle" @click="mdSource = !mdSource">
                        {{ mdSource ? t('skills.preview.viewFormatted', 'View formatted') : t('skills.preview.viewSource', 'View source') }}
                      </button>
                    </div>
                    <pre v-if="mdSource" class="skills-md" tabindex="0" :aria-label="t('skills.preview.sourceLabel', 'SKILL.md source')">{{ preview.skillMd }}</pre>
                    <template v-else>
                      <dl v-if="frontmatter.meta.length" class="skills-fm">
                        <template v-for="m in frontmatter.meta" :key="m.key">
                          <dt>{{ m.key }}</dt>
                          <dd>{{ m.value }}</dd>
                        </template>
                      </dl>
                      <!-- eslint-disable-next-line vue/no-v-html (sanitized, no raw HTML: skillPreview.js) -->
                      <article class="skills-md-view" tabindex="0" :aria-label="t('skills.preview.instructionsLabel', 'Instructions of the skill')" @click="onMdClick" v-html="mdHtml"></article>
                    </template>
                  </div>

                  <p v-if="preview.scripts.length" class="skills-callout warn skills-warn">{{ scriptsLabel(preview) }}</p>
                  <div v-if="preview.setup.length" class="skills-callout skills-setup-box">
                    <div class="skills-callout-text">
                      <strong>{{ t('skills.setup.title', 'It comes with a setup command.') }}</strong>
                      {{ t('skills.setup.body', 'Tessel does not run it. If you need it, run it yourself in a terminal and answer its questions there.') }}
                      <div v-for="cmd in preview.setup" :key="cmd" class="skills-setup">
                        <code class="mcp-preview">{{ cmd }}</code>
                        <button type="button" class="exit-btn skills-btn" @click="runSetup(cmd)">{{ t('skills.setup.button', 'Run its setup in a terminal') }}</button>
                      </div>
                    </div>
                  </div>
                </template>
              </div>
            </li>
          </ul>
        </section>

        <!-- Step 3: the agents and the scope. -->
        <section v-if="preview && !updating" class="skills-step" :aria-labelledby="uid + '-step-where'">
          <div class="skills-step-head">
            <span class="skills-step-num" aria-hidden="true">3</span>
            <h3 :id="uid + '-step-where'" class="skills-step-title">{{ t('skills.add.stepWhere', 'Where to install it') }}</h3>
          </div>
          <div class="skills-field-head">
            <span :id="uid + '-agents'" class="skills-field-label">{{ t('skills.add.agents', 'Agents') }}</span>
            <span class="skills-field-tools">
              <button type="button" class="skills-link" :disabled="allChosen" @click="chooseAll(true)">{{ t('skills.add.selectAll', 'Select all') }}</button>
              <button type="button" class="skills-link" :disabled="!chosenAgents.length" @click="chooseAll(false)">{{ t('skills.add.selectNone', 'Select none') }}</button>
            </span>
          </div>
          <div class="skills-agent-chips" role="group" :aria-labelledby="uid + '-agents'">
            <button
              v-for="a in AGENTS"
              :key="a"
              type="button"
              class="skills-agent-chip"
              :class="{ on: targets[a], missing: !installed[a] }"
              :aria-pressed="targets[a]"
              :aria-label="agentChipLabel(a)"
              :title="installed[a] ? undefined : agentChipLabel(a)"
              :data-agent="a"
              @click="toggleTarget(a)"
            >
              <BrandIcon :kind="a" :size="14" />
              <span class="skills-agent-name">{{ AGENT_NAME[a] }}</span>
              <svg class="skills-agent-check" width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
          <p v-if="!chosenAgents.length" class="skills-info warn">{{ t('skills.add.chooseAgent', 'Choose at least one agent.') }}</p>
          <p v-else-if="sharedNote" class="skills-info">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.2" />
              <path d="M8 7.2v4M8 4.9h.01" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
            <span>{{ sharedNote }}</span>
          </p>

          <div class="skills-field-head skills-scope-head">
            <span :id="uid + '-scope'" class="skills-field-label">{{ t('skills.add.scope', 'Use it in') }}</span>
          </div>
          <div class="skills-scopes" role="group" :aria-labelledby="uid + '-scope'">
            <button type="button" class="skills-scope-opt" :class="{ on: scope === 'user' }" :aria-pressed="scope === 'user'" data-scope="user" @click="scope = 'user'">
              <span class="skills-scope-title">{{ t('skills.scope.user', 'All projects') }}</span>
              <span class="skills-scope-sub">{{ t('skills.add.userHint', 'Every folder the agents open') }}</span>
            </button>
            <button
              type="button"
              class="skills-scope-opt"
              :class="{ on: scope === 'project' }"
              :aria-pressed="scope === 'project'"
              :disabled="!project"
              data-scope="project"
              :title="project || undefined"
              @click="scope = 'project'"
            >
              <span class="skills-scope-title">{{ t('skills.scope.project', 'This project') }}</span>
              <span class="skills-scope-sub">{{ projectName || t('skills.add.noProject', 'No project open') }}</span>
            </button>
          </div>
          <p v-if="!project" class="set-hint skills-field-hint">{{ t('skills.add.scopeHint', 'Open a project folder to add it to one project only') }}</p>
        </section>

        <!-- The result, for each folder it went to. -->
        <section v-if="results" class="skills-results" :aria-label="t('skills.add.resultsLabel', 'Result')" aria-live="polite">
          <p class="skills-results-head">
            {{ resultsHead }}
          </p>
          <ul class="skills-result-list">
            <li v-for="r in results" :key="r.dir" class="skills-result" :class="r.ok ? 'ok' : r.exists ? 'exists' : 'failed'" :data-dir="r.dir">
              <svg v-if="r.ok" class="skills-result-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3" />
                <path d="M5 8.3l2 2 4-4.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <svg v-else-if="r.exists" class="skills-result-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3" />
                <path d="M8 4.8v3.8M8 10.9h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
              <svg v-else class="skills-result-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3" />
                <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
              <span class="skills-result-main">
                <span class="skills-result-top">
                  <span class="skills-agents" aria-hidden="true"><BrandIcon v-for="a in resultAgents(r)" :key="a" :kind="a" :size="14" /></span>
                  <span class="skills-result-agents">{{ agentNames(resultAgents(r)) }}</span>
                  <span class="skills-result-state">{{ resultState(r) }}</span>
                </span>
                <span class="skills-path" :title="r.dir">{{ shortPath(r.dir) }}</span>
                <span v-if="!r.ok && !r.exists && r.error" class="skills-result-error">{{ r.error }}</span>
                <span v-if="r.exists" class="set-hint">{{ t('skills.add.existsHint', 'A skill with this name is already in this folder. Replace it, or keep it as it is.') }}</span>
                <span v-if="alsoSeen(r).length" class="set-hint">{{ alsoSeenLabel(r) }}</span>
              </span>
              <button v-if="r.exists" type="button" class="exit-btn skills-btn" :disabled="!!busy" @click="install(r.dir)">
                <span v-if="busy === 'replace:' + r.dir" class="skills-spinner" aria-hidden="true" />
                {{ t('skills.add.replace', 'Replace it') }}
              </button>
            </li>
          </ul>
          <div class="skills-results-foot">
            <button v-if="results.some((r) => r.ok || r.exists)" type="button" class="exit-btn skills-btn" data-test="skills-view-installed" @click="viewInstalled">
              {{ t('skills.add.viewInstalled', 'View it in Installed') }}
            </button>
            <button v-if="!updating" type="button" class="skills-link" @click="addAnother">{{ t('skills.add.another', 'Add another skill') }}</button>
          </div>
        </section>

        <form v-if="preview && !allDone" class="skills-add-foot" @submit.prevent="install()">
          <span class="set-hint skills-foot-summary">{{ footSummary }}</span>
          <button class="exit-btn primary skills-btn skills-install-btn" type="submit" :disabled="!!busy || (!updating && !chosenAgents.length)" data-test="skills-install">
            <span v-if="busy === 'install'" class="skills-spinner" aria-hidden="true" />
            {{ busy === 'install' ? t('skills.add.installing', 'Installing…') : installLabel(preview) /* i18n-ignore */ }}
          </button>
        </form>
      </div>
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
}
/* Buttons of the list never break their text over two lines nor shrink:
   when the width runs out, the group they are in moves to the next line. */
.skills-btn {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  font-size: 11.5px;
  white-space: nowrap;
}
.skills-btn svg {
  flex: 0 0 auto;
}

/* The search, the count and Refresh: the count gives way first. */
.skills-toolbar {
  gap: 8px;
}
.skills-count {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skills-checked {
  margin-left: 4px;
}

/* Origin filters: small chips, each with its count. */
.skills-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0 0 8px;
}
.skills-chip {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: 11px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.skills-chip:hover {
  color: var(--text-strong);
}
.skills-chip.on {
  border-color: transparent;
  background: var(--surface-3);
  color: var(--text-strong);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.skills-chip:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.skills-chip-count {
  color: var(--text-dim);
  font-size: 10.5px;
}

/* The list: one row per skill. Its own width decides the layout (the page
   can be narrow, or zoomed in): below 460 px the agents and the scope go
   under the name, and the details lose their indent. */
.skills-list {
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--border);
  container-type: inline-size;
}
.skills-item {
  border-bottom: 1px solid var(--border);
}
.skills-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 46px;
  padding: 5px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.skills-row:hover,
.skills-item.open > .skills-row {
  background: var(--surface-3);
}
.skills-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.skills-row-icon {
  flex: 0 0 auto;
}
.skills-row-main {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.skills-row-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
  min-width: 0;
}
.skills-row-name {
  max-width: 100%;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skills-row-desc {
  overflow: hidden;
  color: var(--text-dim);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skills-row-meta {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}
.skills-agents {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 3px;
}
.skills-chevron {
  flex: 0 0 auto;
  color: var(--text-dim);
  transition: transform 0.12s ease;
}
.skills-item.open .skills-chevron {
  transform: rotate(90deg);
}

/* Small tags: origin, state, scope. One line each; one longer than the
   line itself ends in an ellipsis (its tooltip says it whole). */
.skills-tag {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--surface-3);
  color: var(--text-dim);
  font-size: 10.5px;
  font-weight: 400;
  line-height: 16px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skills-scope {
  border: 1px solid var(--border-strong);
  background: transparent;
  line-height: 14px;
}
.skills-origin.origin-own {
  background: color-mix(in srgb, #3fb950 20%, transparent);
  color: #a8e6b4;
}
.skills-origin.origin-github {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: #cfe0ff;
}
.skills-origin.origin-synced {
  background: color-mix(in srgb, #a371f7 22%, transparent);
  color: #d9c7ff;
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

/* Placeholder rows while the folders are read the first time. */
.skills-skeleton {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 46px;
  padding: 5px 8px;
}
.skills-skel-icon,
.skills-skel-lines span {
  border-radius: 4px;
  background: var(--surface-3);
  opacity: 0.6;
}
.skills-skel-icon {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
}
.skills-skel-lines {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 6px;
}
.skills-skel-lines span {
  height: 9px;
}
.skills-skel-lines span:first-child {
  width: 30%;
}
.skills-skel-lines span:last-child {
  width: 70%;
}

/* A skill's details, under its row, in line with its name. */
.skills-details {
  padding: 6px 8px 12px 38px;
}
.skills-details-desc {
  margin: 0 0 8px;
  color: var(--text);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  user-select: text;
}
.skills-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  margin: 4px 0;
  color: var(--text-dim);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.skills-section-head .skills-btn {
  margin-left: auto;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
}
.skills-remove-all {
  color: #ffb4b6;
}
.skills-remove-all:hover {
  background: color-mix(in srgb, var(--danger) 25%, transparent);
}
.skills-versions-note {
  margin: 0 0 6px;
}
.skills-copies {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.skills-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.skills-copy-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px 6px;
  min-width: 0;
  font-size: 12px;
}
.skills-copy-agents {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The folder and the actions: one line while both fit, else the actions
   (kept together) go under it. */
.skills-copy-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  min-width: 0;
}
.skills-copy-path {
  display: flex;
  flex: 1 1 160px;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
.skills-path {
  min-width: 0;
  overflow: hidden;
  color: var(--text-dim);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}
.skills-copy-btn {
  flex: 0 0 auto;
}
.skills-copy-btn.on {
  color: #8ff0b8;
}
.skills-actions {
  display: inline-flex;
  flex: 0 0 auto;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.skills-update-line {
  margin: 0;
}
.skills-history-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.skills-link {
  flex: 0 0 auto;
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.skills-link:hover {
  text-decoration: underline;
}

@container (max-width: 460px) {
  .skills-row {
    flex-wrap: wrap;
    row-gap: 3px;
  }
  .skills-row-meta {
    order: 3;
    flex-basis: 100%;
    padding-left: 30px;
  }
  .skills-chevron {
    order: 2;
  }
  .skills-details {
    padding-left: 8px;
  }
}

/* A message above the tab's content keeps its distance from it. */
.mcp-notice,
.mcp-error {
  margin-bottom: 6px;
}

/* The Add tab: three numbered steps, one under the other. Labels sit above
   their controls (never squeezed beside them), and the tab follows its own
   width (a narrow page, or zoomed in). */
.skills-add {
  container-type: inline-size;
}
.skills-step {
  padding: 12px 0 14px;
  border-top: 1px solid var(--border);
}
.skills-step:first-child {
  padding-top: 4px;
  border-top: 0;
}
.skills-step-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin: 0 0 10px;
}
.skills-step-num {
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--text-strong);
  font-size: 10.5px;
  font-weight: 600;
}
.skills-step-title {
  flex: 0 0 auto;
  margin: 0;
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
}
.skills-step-aside {
  flex: 0 1 auto;
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skills-step-hint {
  margin: -4px 0 8px;
}
.skills-updating .skills-path {
  display: block;
}
.skills-looking {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 8px 0 0;
}

/* Step 1: GitHub or a folder (compact tabs), then one wide box with its
   button inside. */
.skills-sources {
  display: inline-flex;
  gap: 2px;
  max-width: 100%;
  margin-bottom: 10px;
  padding: 2px;
  border-radius: 8px;
  background: var(--term);
}
.skills-source {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.skills-source:hover {
  color: var(--text-strong);
}
.skills-source.on {
  background: var(--surface-3);
  color: var(--text-strong);
  box-shadow: inset 0 0 0 1px var(--border-strong);
}
.skills-source:focus-visible,
.skills-agent-chip:focus-visible,
.skills-scope-opt:focus-visible,
.skills-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.skills-field {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 34px;
  padding: 0 3px 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--term);
}
.skills-field:focus-within {
  border-color: var(--accent);
}
.skills-field.invalid {
  border-color: color-mix(in srgb, #ff9b9e 70%, transparent);
}
.skills-field-icon {
  flex: 0 0 auto;
  color: var(--text-dim);
}
.skills-field-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-strong);
  font: inherit;
  font-size: 12.5px;
  outline: none;
  -webkit-user-select: text;
  user-select: text;
}
.skills-field-input::placeholder {
  color: var(--text-dim);
  opacity: 0.8;
}
.skills-field-btn {
  height: 26px;
  padding: 0 12px;
}
.skills-field-hint {
  margin: 6px 0 0;
  line-height: 1.5;
}
.skills-example {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
}
.skills-hint-more {
  margin-left: 6px;
}
.skills-folder-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
}
.skills-folder-row .skills-path {
  flex: 1 1 160px;
}
.skills-add-error {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: 8px 0 0;
  padding: 7px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: #ffb4b6;
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.skills-add-error svg {
  flex: 0 0 auto;
  margin-top: 2px;
}

/* Step 2: the skills found, the same rows as the Installed list. */
.skills-row-static {
  cursor: default;
}
.skills-item.single > .skills-row-static,
.skills-row-static:hover {
  background: transparent;
}
/* The one skill found: its whole description, not cut to a line. */
.skills-item.single .skills-row-static {
  align-items: flex-start;
}
.skills-item.single .skills-row-icon {
  margin-top: 2px;
}
.skills-item.single .skills-row-desc {
  line-height: 1.45;
  white-space: normal;
}
.skills-found .skills-item.open:not(.single) {
  background: color-mix(in srgb, var(--surface-3) 35%, transparent);
}
.skills-row-path {
  min-width: 0;
  overflow: hidden;
  color: var(--text-dim);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skills-row-size {
  white-space: nowrap;
}
.skills-pv-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
  margin-bottom: 6px;
}
.skills-pv-source {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-dim);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}
.skills-pv-files {
  font-size: 11.5px;
}
.skills-files {
  max-width: 100%;
  margin: 2px 0 8px;
  border-collapse: collapse;
  font-size: 11.5px;
}
.skills-files td {
  padding: 2px 0;
}
.skills-file-path {
  max-width: 360px;
  padding-right: 18px !important;
  overflow: hidden;
  color: var(--text);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skills-file-size {
  color: var(--text-dim);
  text-align: right;
  white-space: nowrap;
}
.skills-callout {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  margin: 8px 0 0;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: 12px;
  line-height: 1.45;
}
.skills-callout > svg {
  flex: 0 0 auto;
  color: var(--warn);
}
.skills-callout-text {
  flex: 1 1 220px;
  min-width: 0;
}
.skills-callout.warn {
  border-color: transparent;
  background: color-mix(in srgb, #d29922 14%, transparent);
}
.skills-warn {
  color: #ffd98f;
}
.skills-read-btn {
  margin-left: auto;
}
.skills-md-box {
  margin-top: 6px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--term);
}
.skills-md-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 28px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 11px;
}
.skills-md-file {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
}
.skills-fm {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 3px 12px;
  margin: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 11.5px;
  line-height: 1.45;
}
.skills-fm dt {
  color: var(--text-dim);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.6;
}
.skills-fm dd {
  margin: 0;
  color: var(--text);
  overflow-wrap: anywhere;
  white-space: pre-line;
  user-select: text;
}
.skills-md-view,
.skills-md {
  max-height: 360px;
  overflow: auto;
}
.skills-md-view {
  padding: 4px 14px 10px;
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.55;
  overflow-wrap: anywhere;
  user-select: text;
}
.skills-md-view:focus-visible,
.skills-md:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.skills-md-view :deep(h1),
.skills-md-view :deep(h2),
.skills-md-view :deep(h3),
.skills-md-view :deep(h4) {
  margin: 1em 0 0.4em;
  color: var(--text-strong);
  line-height: 1.3;
}
.skills-md-view :deep(h1) {
  font-size: 16px;
}
.skills-md-view :deep(h2) {
  font-size: 14px;
}
.skills-md-view :deep(h3),
.skills-md-view :deep(h4) {
  font-size: 12.5px;
}
.skills-md-view :deep(p),
.skills-md-view :deep(ul),
.skills-md-view :deep(ol),
.skills-md-view :deep(blockquote),
.skills-md-view :deep(table) {
  margin: 0.5em 0;
}
.skills-md-view :deep(ul),
.skills-md-view :deep(ol) {
  padding-left: 20px;
}
.skills-md-view :deep(a) {
  color: var(--accent);
  cursor: pointer;
}
.skills-md-view :deep(code) {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--surface-3);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 0.9em;
}
.skills-md-view :deep(pre) {
  padding: 8px 10px;
  overflow: auto;
  border-radius: 6px;
  background: var(--surface-2);
}
.skills-md-view :deep(pre code) {
  padding: 0;
  background: none;
}
.skills-md-view :deep(blockquote) {
  padding: 0 12px;
  border-left: 3px solid var(--border-strong);
  color: var(--text-dim);
}
.skills-md-view :deep(table) {
  border-collapse: collapse;
}
.skills-md-view :deep(th),
.skills-md-view :deep(td) {
  padding: 3px 8px;
  border: 1px solid var(--border-strong);
}
.skills-md-view :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border);
}
/* Images are never loaded (their text shows instead). */
.skills-md-view :deep(img) {
  color: var(--text-dim);
  font-style: italic;
}
.skills-md {
  margin: 0;
  padding: 10px 12px;
  color: var(--text);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
.skills-setup {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.skills-setup .mcp-preview {
  flex: 1 1 200px;
  min-width: 0;
  margin: 0;
}

/* Step 3: agent chips (the check and the colour say which are chosen) and
   the scope, two options side by side. */
.skills-field-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  margin: 0 0 6px;
}
.skills-scope-head {
  margin-top: 14px;
}
.skills-field-label {
  color: var(--text-dim);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}
.skills-field-tools {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 12px;
  margin-left: auto;
  font-size: 11.5px;
}
.skills-link:disabled {
  color: var(--text-dim);
  text-decoration: none;
  opacity: 0.6;
  cursor: default;
}
.skills-agent-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.skills-agent-chip {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.skills-agent-chip:hover {
  color: var(--text-strong);
  border-color: var(--text-dim);
}
.skills-agent-chip .brand-icon {
  opacity: 0.5;
  filter: grayscale(0.7);
}
.skills-agent-chip.on {
  border-color: color-mix(in srgb, var(--accent) 75%, transparent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--text-strong);
}
.skills-agent-chip.on .brand-icon {
  opacity: 1;
  filter: none;
}
.skills-agent-check {
  flex: 0 0 auto;
  color: var(--accent);
  visibility: hidden;
}
.skills-agent-chip.on .skills-agent-check {
  visibility: visible;
}
.skills-agent-chip.missing .skills-agent-name {
  font-style: italic;
}
.skills-info {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 8px 0 0;
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 1.45;
}
.skills-info svg {
  flex: 0 0 auto;
  margin-top: 1px;
}
.skills-info.warn {
  color: #ffd98f;
}
.skills-scopes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  max-width: 520px;
}
.skills-scope-opt {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.skills-scope-opt:hover:not(:disabled) {
  border-color: var(--text-dim);
}
.skills-scope-opt.on {
  border-color: color-mix(in srgb, var(--accent) 75%, transparent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.skills-scope-opt:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.skills-scope-title {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skills-scope-sub {
  overflow: hidden;
  color: var(--text-dim);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The result, one line per folder, and the install button at the bottom right. */
.skills-results {
  margin-top: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.skills-results-head {
  margin: 0 0 6px;
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 600;
}
.skills-result-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.skills-result {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 4px 8px;
  min-width: 0;
}
.skills-result-icon {
  flex: 0 0 auto;
  margin-top: 2px;
}
.skills-result.ok .skills-result-icon,
.skills-result.ok .skills-result-state {
  color: #7ee2a8;
}
.skills-result.exists .skills-result-icon,
.skills-result.exists .skills-result-state {
  color: #ffd98f;
}
.skills-result.failed .skills-result-icon,
.skills-result.failed .skills-result-state {
  color: #ff9b9e;
}
.skills-result-main {
  display: flex;
  flex: 1 1 200px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.skills-result-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
  font-size: 12px;
}
.skills-result-agents {
  color: var(--text);
  white-space: nowrap;
}
.skills-result-state {
  font-weight: 600;
  white-space: nowrap;
}
.skills-result-error {
  color: #ff9b9e;
  font-size: 11.5px;
  overflow-wrap: anywhere;
}
.skills-results-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  margin-top: 10px;
  font-size: 12px;
}
.skills-add-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px 12px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.skills-foot-summary {
  flex: 1 1 180px;
  min-width: 0;
  line-height: 1.4;
}
.skills-install-btn {
  height: 30px;
  max-width: 100%;
  padding: 0 14px;
  overflow: hidden;
  font-size: 12.5px;
  text-overflow: ellipsis;
}
.skills-spinner {
  display: inline-block;
  flex: 0 0 auto;
  width: 11px;
  height: 11px;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: skills-spin 0.8s linear infinite;
}
@keyframes skills-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .skills-spinner {
    animation-duration: 2.4s;
  }
}
@container (max-width: 420px) {
  .skills-scopes {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* The Antigravity plugins tab: the same box as Add, then the same list as Installed. */
.skills-plugin-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  margin: 0 0 4px;
}
.skills-plugin-form .skills-field {
  flex: 1 1 260px;
}
.skills-plugin-folder {
  height: 34px;
}
.skills-off {
  background: color-mix(in srgb, var(--text-dim) 18%, transparent);
}
.skills-item.off .skills-row-name {
  color: var(--text-dim);
}
.skills-plugin-parts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}
.skills-plugin-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}
.skills-plugin-state {
  flex: 1 1 200px;
  min-width: 0;
}

/* A copy's history. */
.skills-history {
  margin: 2px 0 0;
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
  min-width: 0;
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
