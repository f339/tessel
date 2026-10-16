<script setup>
import ThemedSelect from './ui/ThemedSelect.vue'
// Settings > Automations: scheduled agent tasks, after Orca's Automations
// page (src/renderer/src/components/automations/AutomationsPage*.tsx,
// AutomationDetail.tsx, AutomationRunHistory.tsx and
// settings/AutomationsSettingsPane.tsx, MIT, Copyright (c) 2026 Lovecast
// Inc.): how they work, the list (schedule, project, agent, next and last
// run, on or paused), Run now, edit, delete, and each one's run history with
// a link to its pane and its card. They run only while Tessel is open.
// The list looks like Settings > Skills: one row each, its actions and
// history in the details under it. How they work is open while there is
// none, folded once there is one. The editor is a dialog over the page.
import { ref, computed, inject, onMounted, onUnmounted, nextTick } from 'vue'
import { t } from '../i18n'
import BrandIcon from './BrandIcon.vue'
import AutomationEditor from './AutomationEditor.vue'
import PanelState from './ui/PanelState.vue'
import SettingsListItem from './settings/SettingsListItem.vue'
import { MAX_CONCURRENT_LIMIT } from '../../../shared/automations'
import {
  automationsState,
  loadAutomations,
  createAutomation,
  updateAutomation,
  setAutomationEnabled,
  removeAutomation,
  runAutomationNow,
  setAutomationSettings,
  runsOf
} from '../automationsStore'
import { scheduleLabel, graceLabel, statusLabel, statusTone, runReason, triggerLabel, formatDateTime, relativeTime } from '../automationLabels'

const empty = { value: [] }
const ctx = inject('automations', null) || {
  projects: empty,
  agents: empty,
  permissions: () => null,
  paneOpen: () => false,
  cardOpen: () => false,
  showPane: () => {},
  showCard: () => {},
  openAgentSettings: () => {}
}
const askConfirm = inject('askConfirm', null)

const editing = ref(null) // null | 'new' | automation id
const selectedId = ref(null)
const editorError = ref('')
const busy = ref(false)
// What the last action did (info) or why it failed (warn).
const notice = ref('')
const failure = ref('')
const historyLimit = ref(20)
const now = ref(Date.now())
const page = ref(null)
const loading = ref(true)
let clock = 0
onMounted(() => {
  refresh()
  clock = setInterval(() => (now.value = Date.now()), 30000)
})
onUnmounted(() => clearInterval(clock))

async function refresh() {
  loading.value = true
  await loadAutomations()
  loading.value = false
}

function say(ok, okText, errText) {
  notice.value = ok ? okText || '' : ''
  failure.value = ok ? '' : errText || ''
}

async function closeEditor() {
  const id = editing.value
  editing.value = null
  await nextTick()
  const item = [...(page.value?.querySelectorAll('[data-automation]') || [])].find((el) => el.dataset.automation === id)
  const target = item?.querySelector('[data-test="au-edit"]') || item?.querySelector('.sl-row') || page.value?.querySelector('[data-test="au-new"]')
  target?.focus()
}

const projects = computed(() => ctx.projects.value || [])
const agents = computed(() => ctx.agents.value || [])
const list = computed(() => automationsState.automations)
const editingAutomation = computed(() => (editing.value && editing.value !== 'new' ? list.value.find((a) => a.id === editing.value) || null : null))
const selected = computed(() => list.value.find((a) => a.id === selectedId.value) || null)
const selectedRuns = computed(() => (selected.value ? runsOf(selected.value.id) : []))
const failedToLoad = computed(() => !loading.value && !automationsState.loaded)

function agentName(id) {
  return (agents.value.find((a) => a.id === id) || {}).name || id
}
function projectName(a) {
  const p = projects.value.find((x) => x.wsId === a.wsId)
  return p ? p.name : t('automations.page.projectMissing', '{{name}} (not open)', { name: a.projectName || '?' })
}
function lastRun(a) {
  return runsOf(a.id)[0] || null
}
function activeRun(a) {
  return runsOf(a.id).find((r) => ['pending', 'dispatching', 'dispatched'].includes(r.status)) || null
}
// A run status as a tag of the shared look.
function toneTag(status) {
  const tone = statusTone(status)
  return tone === 'ok' ? 'tag-ok' : tone === 'running' ? 'tag-info' : tone === 'failed' ? 'tag-danger' : 'tag-warn'
}
// The row's one line: when, where, which agent.
function rowDesc(a) {
  return [scheduleLabel(a.schedule), projectName(a), agentName(a.agentId), a.model].filter(Boolean).join(' · ')
}

function permissionText(agentId) {
  const p = ctx.permissions(agentId)
  if (!p) return ''
  if (p.yolo) return t('automations.perms.yolo', 'Yolo is on for it ({{args}}): it acts without asking you, running commands and changing files while you may be away.', { args: p.args })
  if (p.ownArgs) return t('automations.perms.ownArgs', 'It starts with your own arguments for it: {{args}}', { args: p.args })
  return t('automations.perms.manual', 'Manual: it asks before acting. An unattended run stops at each approval until you answer it in its pane (you are notified).')
}

// What a confirmation covers: a change of these asks again (the main
// process clears it too), as does a change of the agent's permissions
// (Yolo, its arguments) since.
const SENSITIVE = ['agentId', 'wsId', 'projectCwd', 'remote', 'isolation', 'prompt']
const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null)
function permSig(agentId) {
  const p = ctx.permissions(agentId)
  return (p && p.sig) || ''
}
function needsConfirm(a) {
  return !a.confirmedAt || !a.confirmedSig || a.confirmedSig !== permSig(a.agentId)
}

// Each time an automation may run on its own with something new: said
// plainly, confirmed.
async function confirmUnattended(a, manual = false) {
  if (!askConfirm) return false
  return await askConfirm({
    title: t('automations.confirm.title', 'Let "{{name}}" run unattended?', { name: a.name }),
    text:
      (manual
        ? t('automations.confirm.runNowText', 'Tessel will start {{agent}} in {{project}} now. This does not change whether its schedule is enabled or paused.', { agent: agentName(a.agentId), project: a.projectName || projectName(a) })
        : t('automations.confirm.text', 'Tessel will start {{agent}} in {{project}} on this schedule while it is open, even when you are away.', {
            agent: agentName(a.agentId),
            project: a.projectName || projectName(a)
          })) +
      ' ' + scheduleLabel(a.schedule) + '. ' +
      (a.isolation === 'worktree'
        ? t('automations.detail.ownCopy', 'Its own copy, new for each run')
        : t('automations.editor.direct', 'Directly in the project folder')) + '. ' +
      permissionText(a.agentId),
    confirmLabel: t('automations.confirm.ok', 'Allow')
  })
}

function openNew() {
  editorError.value = ''
  editing.value = 'new'
}
function openEdit(a) {
  editorError.value = ''
  editing.value = a.id
}

async function save(input) {
  busy.value = true
  editorError.value = ''
  try {
    const current = editingAutomation.value
    let confirmed = false
    const changed = !current || SENSITIVE.some((k) => !same(input[k], current[k]))
    if (input.enabled && (changed || needsConfirm(current))) {
      confirmed = await confirmUnattended({ ...input, projectName: input.projectName })
      if (!confirmed) {
        editorError.value = t('automations.page.notConfirmed', 'Not saved: it needs your confirmation to run on its own. Turn off "Run on its schedule" to save it paused.')
        return
      }
    }
    const confirmSig = confirmed ? permSig(input.agentId) : null
    const res = current ? await updateAutomation(current.id, { ...input, confirmed, confirmSig }) : await createAutomation({ ...input, confirmed, confirmSig })
    if (!res.ok) {
      editorError.value = res.error || t('automations.page.saveFailed', 'Failed to save automation.')
      return
    }
    say(true, current ? t('automations.page.updated', 'Automation updated.') : t('automations.page.saved', 'Automation saved.'))
    selectedId.value = res.automation ? res.automation.id : selectedId.value
    await closeEditor()
  } finally {
    busy.value = false
  }
}

async function toggle(a) {
  let confirmed = false
  if (!a.enabled && needsConfirm(a)) {
    confirmed = await confirmUnattended(a)
    if (!confirmed) return
  }
  const res = await setAutomationEnabled(a.id, !a.enabled, confirmed, confirmed ? permSig(a.agentId) : null)
  say(res.ok, '', res.error || t('automations.page.actionFailed', 'The change could not be applied. Try again.'))
}

// The switch shows the saved state until the change is done (it may be refused).
function onToggle(e, a) {
  e.target.checked = a.enabled
  toggle(a)
}

async function runNow(a) {
  let confirmed = false
  if (needsConfirm(a)) {
    confirmed = await confirmUnattended(a, true)
    if (!confirmed) return
  }
  const res = await runAutomationNow(a.id, confirmed, confirmed ? permSig(a.agentId) : null)
  say(res.ok, t('automations.page.queued', 'Automation run queued.'), res.error || t('automations.page.runFailed', 'The run could not be queued. Try again.'))
  if (res.ok) selectedId.value = a.id
}

async function remove(a) {
  const ok = askConfirm
    ? await askConfirm({
        title: t('automations.delete.titleShort', 'Delete this automation?'),
        text: t('automations.delete.text', 'Delete "{{name}}" and its run history. Copies of the project and cards made by previous runs are not deleted.', { name: a.name }),
        confirmLabel: t('automations.delete.ok', 'Delete'),
        danger: true
      })
    : true
  if (!ok) return
  const res = await removeAutomation(a.id)
  say(res.ok, '', res.error || t('automations.page.deleteFailed', 'The automation could not be deleted. Try again.'))
  if (res.ok && selectedId.value === a.id) selectedId.value = null
}

async function setMax(e) {
  const v = Number(e.target.value)
  const res = await setAutomationSettings({ maxConcurrent: v })
  say(res.ok, '', res.error || t('automations.page.actionFailed', 'The change could not be applied. Try again.'))
}

function nextText(a) {
  return t('automations.page.next', 'Next run {{when}}', { when: relativeTime(a.nextRunAt, now.value) || formatDateTime(a.nextRunAt) })
}
function timesText(r) {
  return t('automations.history.times', '{{times}} times', { times: r.occurrenceCount })
}

function select(a) {
  selectedId.value = selectedId.value === a.id ? null : a.id
  historyLimit.value = 20
}
</script>

<template>
  <div ref="page" class="au-page" data-test="automations-page">
    <div class="au-body" :inert="editing ? true : null">
      <!-- How they work: open while there is none, folded once there is one. -->
      <div v-if="!list.length" class="set-card set-card-pad au-how">
        <h3 class="set-group-title">{{ t('automations.how.title', 'How Automations work') }}</h3>
        <ol class="au-steps">
          <li>
            <strong>{{ t('automations.how.defineTitle', 'Describe the work') }}</strong>
            <span>{{ t('automations.how.defineText', 'Choose a project, agent, prompt, and schedule.') }}</span>
          </li>
          <li>
            <strong>{{ t('automations.how.runTitle', 'Tessel starts each run') }}</strong>
            <span>{{ t('automations.how.runText', 'When the schedule is due, the agent starts in a new pane of the project, in its own copy or in the project folder, with a card on the board.') }}</span>
          </li>
          <li>
            <strong>{{ t('automations.how.reviewTitle', 'Review the results') }}</strong>
            <span>{{ t('automations.how.reviewText', 'Inspect recent runs, open their pane or card, and continue the work whenever you need to.') }}</span>
          </li>
        </ol>
        <div class="set-callout info au-only-open" data-test="au-only-open">
          <span class="set-callout-text">{{ t('automations.how.onlyOpenShort', 'Automations run only while Tessel is open: nothing is scheduled in Windows.') }}</span>
          <details class="set-more">
            <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
            <p>{{ t('automations.how.missedMore', 'A run missed while Tessel was closed or the computer asleep runs once when Tessel is back, if it is within the automation\'s grace; older ones are skipped.') }}</p>
          </details>
        </div>
      </div>
      <details v-else class="set-more au-how-fold">
        <summary>{{ t('automations.how.title', 'How Automations work') }}</summary>
        <ol class="au-steps">
          <li>
            <strong>{{ t('automations.how.defineTitle', 'Describe the work') }}</strong>
            <span>{{ t('automations.how.defineText', 'Choose a project, agent, prompt, and schedule.') }}</span>
          </li>
          <li>
            <strong>{{ t('automations.how.runTitle', 'Tessel starts each run') }}</strong>
            <span>{{ t('automations.how.runText', 'When the schedule is due, the agent starts in a new pane of the project, in its own copy or in the project folder, with a card on the board.') }}</span>
          </li>
          <li>
            <strong>{{ t('automations.how.reviewTitle', 'Review the results') }}</strong>
            <span>{{ t('automations.how.reviewText', 'Inspect recent runs, open their pane or card, and continue the work whenever you need to.') }}</span>
          </li>
        </ol>
        <p data-test="au-only-open">{{ t('automations.how.onlyOpen', 'Automations run only while Tessel is open: nothing is scheduled in Windows. A run missed while Tessel was closed or the computer asleep runs once when Tessel is back, if it is within the automation\'s grace; older ones are skipped.') }}</p>
      </details>

      <!-- The list. -->
      <div class="au-toolbar">
        <h3 class="set-group-title">
          {{ t('automations.page.listTitle', 'Your automations') }}
          <span v-if="list.length" class="au-count">{{ list.length }}</span>
        </h3>
        <button type="button" class="exit-btn primary" data-test="au-new" :disabled="loading || !automationsState.loaded" @click="openNew">{{ t('automations.page.newShort', 'New automation') }}</button>
      </div>

      <p v-if="notice" class="set-callout info au-msg" role="status" data-test="au-notice"><span class="set-callout-text">{{ notice }}</span></p>
      <p v-if="failure" class="set-callout warn au-msg" role="alert" data-test="au-failure"><span class="set-callout-text">{{ failure }}</span></p>

      <div class="set-card set-card-pad au-list-card">
        <div v-if="failedToLoad" class="au-error" data-test="au-load-error">
          <PanelState kind="error" :text="t('automations.page.loadFailed', 'Automations could not be loaded.')" :busy="loading" @retry="refresh" />
          <details v-if="automationsState.error" class="set-more au-raw">
            <summary>{{ t('settings.common.details', 'Details') }}</summary>
            <p>{{ automationsState.error }}</p>
          </details>
        </div>
        <ul v-else-if="loading && !list.length" class="sl-list au-list" role="status" aria-busy="true" :aria-label="t('automations.page.loading', 'Loading automations…')">
          <li v-for="i in 2" :key="i" class="sl-item sl-skeleton">
            <span class="sl-skel-icon"></span>
            <span class="sl-skel-lines"><span></span><span></span></span>
          </li>
        </ul>
        <p v-else-if="!list.length" class="au-empty" data-test="au-empty">{{ t('automations.page.empty', 'Create an automation to start scheduling agent work.') }}</p>
        <ul v-else class="sl-list au-list">
          <SettingsListItem
            v-for="a in list"
            :key="a.id"
            :open="selectedId === a.id"
            :name="a.name"
            :desc="rowDesc(a)"
            :class="{ paused: !a.enabled }"
            :data-automation="a.id"
            @toggle="select(a)"
          >
            <template #icon><BrandIcon :kind="a.agentId" :label="agentName(a.agentId)" :size="20" /></template>
            <template #tags>
              <span v-if="!a.enabled" class="tag tag-off">{{ t('automations.page.paused', 'Paused') }}</span>
              <span v-if="needsConfirm(a)" class="tag tag-warn" data-test="au-needs-confirm">{{ t('automations.page.needsConfirm', 'Needs your confirmation') }}</span>
              <span v-if="lastRun(a)" class="tag" :class="toneTag(lastRun(a).status)" :title="t('automations.page.last', 'Last run')">{{ statusLabel(lastRun(a).status) }}</span>
            </template>
            <template v-if="a.enabled" #meta>
              <span class="au-next-run">{{ nextText(a) }}</span>
            </template>

            <!-- Its actions, then what it does, then its runs. -->
            <div class="au-actions">
              <label class="au-enable">
                <input
                  type="checkbox"
                  class="set-switch"
                  :checked="a.enabled"
                  :aria-label="t('automations.page.scheduleFor', 'Scheduled runs: {{name}}', { name: a.name })"
                  data-test="au-toggle"
                  @change="onToggle($event, a)"
                />
                <span>{{ t('automations.editor.enabled', 'Run on its schedule') }}</span>
              </label>
              <span class="sl-actions">
                <button type="button" class="exit-btn small" :disabled="!!activeRun(a)" data-test="au-run-now" @click="runNow(a)">{{ t('automations.page.runNowShort', 'Run now') }}</button>
                <button type="button" class="exit-btn small" data-test="au-edit" @click="openEdit(a)">{{ t('automations.page.edit', 'Edit') }}</button>
                <button type="button" class="exit-btn small danger" data-test="au-delete" @click="remove(a)">{{ t('automations.page.delete', 'Delete') }}</button>
              </span>
            </div>
            <dl class="au-facts">
              <dt>{{ t('automations.detail.where', 'Run location') }}</dt>
              <dd>{{ a.isolation === 'worktree' ? t('automations.detail.ownCopy', 'Its own copy, new for each run') : t('automations.detail.projectFolder', 'The project folder') }}</dd>
              <dt>{{ t('automations.detail.grace', 'Grace') }}</dt>
              <dd>{{ graceLabel(a.missedRunGraceMinutes) }}</dd>
              <dt>{{ t('automations.detail.permissions', 'Permissions') }}</dt>
              <dd>{{ permissionText(a.agentId) }}</dd>
              <dt>{{ t('automations.detail.prompt', 'Prompt') }}</dt>
              <dd class="au-prompt">{{ a.prompt }}</dd>
            </dl>
            <div class="sl-section-head">{{ t('automations.history.title', 'Run history') }}</div>
            <p v-if="!selectedRuns.length" class="au-none">{{ t('automations.history.none', 'No runs yet.') }}</p>
            <table v-else class="au-runs" data-test="au-runs">
              <thead>
                <tr>
                  <th>{{ t('automations.history.run', 'Run') }}</th>
                  <th>{{ t('automations.history.status', 'Status') }}</th>
                  <th>{{ t('automations.history.when', 'When') }}</th>
                  <th>{{ t('automations.history.links', 'Open') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in selectedRuns.slice(0, historyLimit)" :key="r.id" :data-run="r.id">
                  <td>
                    #{{ r.runNumber }}
                    <span class="au-sub">{{ triggerLabel(r.trigger) }}</span>
                  </td>
                  <td>
                    <span class="tag" :class="toneTag(r.status)">{{ statusLabel(r.status) }}</span>
                    <span v-if="r.occurrenceCount > 1" class="au-sub">{{ timesText(r) }}</span>
                    <div v-if="runReason(r)" class="au-sub au-reason">{{ runReason(r) }}</div>
                  </td>
                  <td>{{ formatDateTime(r.scheduledFor) }}</td>
                  <td class="au-links">
                    <button v-if="ctx.paneOpen(r.paneId)" type="button" class="exit-btn small" data-test="au-show-pane" @click="ctx.showPane(r.paneId)">{{ t('automations.history.pane', 'Pane') }}</button>
                    <button v-if="ctx.cardOpen(r.taskId)" type="button" class="exit-btn small" data-test="au-show-card" @click="ctx.showCard(r.taskId)">{{ t('automations.history.card', 'Card') }}</button>
                    <span v-if="r.branch" class="sl-path" :title="r.branch">{{ r.branch }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <button v-if="selectedRuns.length > historyLimit" type="button" class="exit-btn small au-more" @click="historyLimit += 20">{{ t('automations.history.more', 'Show more') }}</button>
          </SettingsListItem>
        </ul>
      </div>

      <!-- All automations together. -->
      <div class="set-card au-limit-card">
        <div class="set-row">
          <label class="set-label" for="au-max">
            {{ t('automations.page.maxConcurrentShort', 'Runs at the same time') }}
            <span class="set-hint" :title="t('automations.page.sameNeverTwice', 'The same automation never runs twice at once.')">{{ t('automations.page.maxConcurrentHintShort', 'All automations together; the others wait their turn.') }}</span>
          </label>
          <ThemedSelect id="au-max" class="set-select au-max" :value="automationsState.settings.maxConcurrent" :disabled="loading || !automationsState.loaded" data-test="au-max" @change="setMax">
            <option v-for="n in MAX_CONCURRENT_LIMIT" :key="n" :value="n">{{ n }}</option>
          </ThemedSelect>
        </div>
      </div>
    </div>

    <AutomationEditor
      v-if="editing"
      :key="editing"
      :automation="editingAutomation"
      :projects="projects"
      :agents="agents"
      :permissions="ctx.permissions"
      :error="editorError"
      :busy="busy"
      @save="save"
      @cancel="closeEditor"
      @agent-settings="ctx.openAgentSettings()"
    />
  </div>
</template>

<style scoped>
.au-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.au-how .set-group-title {
  margin-bottom: 10px;
}
.au-steps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px 16px;
  margin: 0;
  padding-left: 18px;
  color: var(--text);
  font-size: 12px;
  line-height: 1.45;
}
.au-steps li span {
  display: block;
  color: var(--text-dim);
}
.au-only-open {
  margin: 12px 0 0;
}
.au-only-open > details[open] {
  flex-basis: 100%;
}
.au-how-fold > .au-steps {
  margin-top: 8px;
}
.au-how-fold > p {
  margin: 8px 0 0;
}
.au-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 4px;
}
.au-toolbar .set-group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
}
.au-toolbar .exit-btn {
  flex: 0 0 auto;
  white-space: nowrap;
}
.au-count {
  padding: 0 6px;
  border-radius: 8px;
  background: var(--surface-3);
  color: var(--text-dim);
  font-size: 10.5px;
  font-weight: 400;
  line-height: 16px;
}
.au-msg {
  margin: 0;
}
.au-empty {
  margin: 0;
  color: var(--text-dim);
  font-size: 12.5px;
}
.au-error :deep(.ps) {
  padding: 0;
}
.au-raw p {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
.au-list {
  margin: -6px 0;
  border-top: 0;
}
.au-list :deep(.sl-item:last-child) {
  border-bottom: 0;
}
.au-list .paused :deep(.sl-row-name) {
  color: var(--text-dim);
}
.au-next-run {
  color: var(--text-dim);
  font-size: 11px;
  white-space: nowrap;
}
/* Its switch on the left, its buttons together on the right. */
.au-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-bottom: 10px;
}
.au-enable {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}
.au-facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0 0 10px;
  font-size: 12px;
}
.au-facts dt {
  color: var(--text-dim);
}
.au-facts dd {
  margin: 0;
  color: var(--text);
  overflow-wrap: anywhere;
}
.au-prompt {
  max-height: 120px;
  overflow: auto;
  white-space: pre-wrap;
}
.au-none {
  margin: 0;
  color: var(--text-dim);
  font-size: 12px;
}
.au-runs {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.au-runs th {
  padding: 4px 6px;
  color: var(--text-dim);
  font-weight: 500;
  text-align: left;
}
.au-runs td {
  padding: 5px 6px;
  border-top: 1px solid var(--border);
  color: var(--text);
  vertical-align: top;
}
.au-sub {
  display: block;
  margin-top: 2px;
  color: var(--text-dim);
  font-size: 11px;
}
.au-reason {
  max-width: 360px;
}
/* A date stays on one line (the reason column wraps instead). */
.au-runs th:nth-child(3),
.au-runs td:nth-child(3) {
  white-space: nowrap;
}
.au-links {
  white-space: nowrap;
}
.au-links .exit-btn {
  margin-right: 4px;
}
.au-more {
  margin-top: 8px;
}
.au-max {
  width: 90px;
  min-width: 0;
}
@container (max-width: 460px) {
  .au-facts {
    grid-template-columns: 1fr;
  }
  .au-facts dd {
    margin-bottom: 4px;
  }
}
</style>
