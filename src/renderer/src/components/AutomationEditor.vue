<script setup>
import ThemedSelect from './ui/ThemedSelect.vue'
// Creating or editing a scheduled automation, after Orca's editor
// (src/renderer/src/components/automations/AutomationEditorDialog.tsx,
// AutomationSchedulePicker.tsx, AutomationCustomCronPanel.tsx,
// AutomationMissedRunGraceField.tsx, MIT, Copyright (c) 2026 Lovecast Inc.):
// name, project, agent (and its model), prompt, where it works, schedule
// (hourly, daily, weekdays, weekly or a custom cron), missed-run grace and
// what happens after each run. It shows what the agent may do unattended
// (Yolo or not, from Settings > Agents). The page saves it.
// A dialog over Settings, built from Settings' own rows, switches and
// selects. Escape, Cancel and × close it; a press outside closes it only
// while nothing was changed. What is missing is said in plain words, never
// as a warning before anything was typed.
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { X } from 'lucide-vue-next'
import { t } from '../i18n'
import {
  SCHEDULE_PRESETS,
  GRACE_MINUTES,
  DEFAULT_GRACE_MINUTES,
  MAX_PROMPT,
  MAX_NAME,
  MIN_INTERVAL_MINUTES,
  minIntervalMinutes,
  scheduleToDraft,
  draftToSchedule,
  isValidSchedule,
  nextOccurrenceAfter
} from '../../../shared/automations'
import { getAgentSessionOptionCatalog, modelOptions } from '../../../shared/agentSessionOptions'
import { modelsFor } from '../agentModels'
import { sessionChoiceLabel } from '../sessionOptionLabels'
import { presetLabel, graceLabel, scheduleLabel, weekdayNames, formatDateTime, formatTime, automationTemplates } from '../automationLabels'

const props = defineProps({
  // The automation edited, or null for a new one.
  automation: { type: Object, default: null },
  projects: { type: Array, default: () => [] },
  agents: { type: Array, default: () => [] },
  // agentId -> { yolo, args, ownArgs, mode } | null
  permissions: { type: Function, default: () => null },
  error: { type: String, default: '' },
  busy: { type: Boolean, default: false }
})
const emit = defineEmits(['save', 'cancel', 'agent-settings'])

const a = props.automation
const firstAgent = props.agents.find((x) => x.available)
const name = ref(a ? a.name : '')
const prompt = ref(a ? a.prompt : '')
const wsId = ref(a ? a.wsId : props.projects[0] ? props.projects[0].wsId : '')
const agentId = ref(a ? a.agentId : firstAgent ? firstAgent.id : '')
const model = ref(a ? a.model || '' : '')
const effort = ref(a ? a.effort || '' : '')
const isolation = ref(a ? a.isolation : 'worktree')
const draft = ref(a ? scheduleToDraft(a.schedule) : { preset: 'daily', time: '09:00', dayOfWeek: 1, custom: '' })
const grace = ref(a ? a.missedRunGraceMinutes : DEFAULT_GRACE_MINUTES)
const notify = ref(a ? a.after?.notify !== false : true)
const closePane = ref(a ? a.after?.closePane === true : false)
const enabled = ref(a ? a.enabled : true)
const templateId = ref('')
const nameInput = ref(null)
const dialogEl = ref(null)
onMounted(() => nextTick(() => nameInput.value?.focus()))
function cancel() {
  if (!props.busy) emit('cancel')
}

// What the form held when it opened: a press outside closes it only while
// nothing was changed (Escape, Cancel and × always close it).
const snapshot = () =>
  JSON.stringify([name.value, prompt.value, wsId.value, agentId.value, model.value, effort.value, isolation.value, draft.value, grace.value, notify.value, closePane.value, enabled.value])
const opened = snapshot()
function onBackdrop() {
  if (snapshot() === opened) cancel()
}
// Tab stays in the dialog (Settings behind it is inert).
function trapTab(e) {
  const els = [...(dialogEl.value?.querySelectorAll('button, input, textarea, summary') || [])].filter(
    (el) => !el.disabled && el.offsetParent !== null
  )
  if (!els.length) return
  const first = els[0]
  const last = els[els.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

const templates = computed(() => automationTemplates())
function useTemplate(id) {
  const tpl = templates.value.find((x) => x.id === id)
  if (!tpl) return
  name.value = tpl.name
  prompt.value = tpl.prompt
  draft.value = { preset: tpl.preset, time: tpl.time || '09:00', dayOfWeek: tpl.dayOfWeek ?? 1, custom: '' }
  grace.value = tpl.grace
}
watch(templateId, useTemplate)

const project = computed(() => props.projects.find((p) => p.wsId === wsId.value) || null)
// The project an automation was saved for, even if it is gone now.
const projectMissing = computed(() => !!a && !project.value)
const remote = computed(() => !!(project.value && project.value.remote))
watch(remote, (r) => {
  if (r) isolation.value = 'project'
}, { immediate: true })

// Model and effort: the agent's catalog (Settings > Agents lists the same).
const models = computed(() => (agentId.value ? modelsFor(agentId.value) : []))
const effortChoices = computed(() => {
  const catalog = getAgentSessionOptionCatalog(agentId.value)
  if (!catalog || !model.value) return []
  const opt = modelOptions(catalog, models.value, model.value).find((o) => o.id === 'effort')
  return opt && opt.kind && Array.isArray(opt.kind.choices) ? opt.kind.choices : []
})
watch(agentId, () => {
  model.value = ''
  effort.value = ''
})
watch(model, () => {
  if (!effortChoices.value.some((c) => c.value === effort.value)) effort.value = ''
})

const perms = computed(() => (agentId.value ? props.permissions(agentId.value) : null))
const agentName = computed(() => (props.agents.find((x) => x.id === agentId.value) || {}).name || agentId.value)

// Schedule
const schedule = computed(() => draftToSchedule(draft.value))
const scheduleValid = computed(() => isValidSchedule(schedule.value))
const cronInvalid = computed(() => draft.value.preset === 'custom' && !!draft.value.custom.trim() && !scheduleValid.value)
const nextRun = computed(() => {
  if (!scheduleValid.value) return null
  try {
    const now = Date.now()
    return nextOccurrenceAfter(schedule.value, now, now)
  } catch {
    return null
  }
})
const days = computed(() => weekdayNames())
const pad = (n) => String(n).padStart(2, '0')
// The time of day, every quarter hour (and the saved time, if it is between
// two), shown the way this computer writes times.
const timeValue = computed(() => {
  const [h, m] = String(draft.value.time || '09:00').split(':').map((x) => Number(x) || 0)
  return `${pad(h)}:${pad(m)}`
})
const timeChoices = computed(() => {
  const list = []
  for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m += 15) list.push(`${pad(h)}:${pad(m)}`)
  if (!list.includes(timeValue.value)) list.push(timeValue.value)
  return list.sort().map((v) => {
    const [h, m] = v.split(':').map(Number)
    return { value: v, label: formatTime(h, m) }
  })
})
function setTime(v) {
  draft.value = { ...draft.value, time: String(v) }
}
// Hourly: the minute past each hour, every five minutes (and the saved one).
const minute = computed(() => Number(String(draft.value.time || '00:00').split(':')[1] || 0))
const minuteChoices = computed(() => {
  const list = Array.from({ length: 12 }, (_, i) => i * 5)
  if (!list.includes(minute.value)) list.push(minute.value)
  return list.sort((x, y) => x - y)
})
function setMinute(v) {
  const m = Math.max(0, Math.min(59, Math.floor(Number(v) || 0)))
  draft.value = { ...draft.value, time: `00:${pad(m)}` }
}
function setPreset(preset) {
  const d = { ...draft.value, preset }
  // Orca seeds a custom cron from the preset it replaces.
  if (preset === 'custom' && !d.custom.trim() && draft.value.preset !== 'custom') {
    const [h, m] = String(draft.value.time || '09:00').split(':').map(Number)
    const dow = draft.value.dayOfWeek
    d.custom =
      draft.value.preset === 'hourly'
        ? `${m} * * * *`
        : draft.value.preset === 'weekdays'
          ? `${m} ${h} * * 1-5`
          : draft.value.preset === 'weekly'
            ? `${m} ${h} * * ${dow}`
            : `${m} ${h} * * *`
  }
  draft.value = d
}

const promptMax = computed(() => MAX_PROMPT)
// Each run opens a pane (and a copy): not more often than this.
const tooFrequent = computed(() => scheduleValid.value && minIntervalMinutes(schedule.value) < MIN_INTERVAL_MINUTES)
const missing = computed(() => {
  if (!name.value.trim()) return t('automations.editor.needName', 'Give the automation a name.')
  if (!project.value) return t('automations.editor.needProject', 'Choose a project.')
  if (!agentId.value) return t('automations.editor.needAgent', 'Choose an agent before saving.')
  if (!prompt.value.trim()) return t('automations.editor.needPrompt', 'Enter a prompt before saving.')
  if (prompt.value.length > promptMax.value) return t('automations.editor.promptTooLong', 'The prompt is too long (at most {{max}} characters here).', { max: promptMax.value })
  if (!scheduleValid.value) return t('automations.editor.needSchedule', 'Enter a valid schedule before saving.')
  if (tooFrequent.value) return tooFrequentText()
  return ''
})
// A problem with what was typed (a warning), not something still to fill in.
const problem = computed(() => (prompt.value.length > promptMax.value || tooFrequent.value ? missing.value : ''))

// Texts with placeholders (kept out of the template's own {{ }}).
function goneLabel() {
  return t('automations.editor.projectGone', '{{name}} (no longer open)', { name: (a && a.projectName) || wsId.value })
}
function projectLabel(p) {
  return p.remote ? t('automations.editor.remoteProject', '{{name}} (on {{host}})', { name: p.name, host: p.hostLabel || p.remote.hostId }) : p.name
}
function agentLabel(ag) {
  return ag.available ? ag.name : t('automations.editor.agentMissing', '{{name}} (not installed)', { name: ag.name })
}
function promptHint() {
  return remote.value
    ? t('automations.editor.promptRemoteFileHint', 'On a remote project each run writes this prompt to .tessel/automations in the project folder on the host, where the agent reads it (nothing is typed into its terminal).')
    : t('automations.editor.promptHint', 'Each run starts the agent with this prompt (kept in a file it reads; nothing is typed into its terminal).')
}
function whereHint() {
  if (remote.value) return t('automations.editor.ownCopyRemoteShort', 'A remote project: in its folder only.')
  return isolation.value === 'worktree'
    ? t('automations.editor.ownCopyHintShort', 'A new branch each run, in its own folder: you merge it.')
    : t('automations.editor.directHintShort', 'Edits land in the project at once: for reports and checks.')
}
function tooFrequentText() {
  return t('automations.editor.tooFrequent', 'Runs must be at least {{min}} minutes apart: each one opens a pane (and a copy of the project).', { min: MIN_INTERVAL_MINUTES })
}
function nextRunText() {
  return t('automations.editor.nextRun', '{{schedule}} · next scheduled time {{when}}', { schedule: scheduleLabel(schedule.value), when: formatDateTime(nextRun.value) })
}
function minuteLabel(m) {
  return `:${pad(m)}` // i18n-ignore
}
function permsTitle() {
  return t('automations.perms.title', 'What {{agent}} may do, unattended', { agent: agentName.value })
}
function yoloText() {
  return t('automations.perms.yolo', 'Yolo is on for it ({{args}}): it acts without asking you, running commands and changing files while you may be away.', { args: perms.value.args })
}
function ownArgsText() {
  return t('automations.perms.ownArgs', 'It starts with your own arguments for it: {{args}}', { args: perms.value.args })
}

function save() {
  if (missing.value || props.busy) return
  const p = project.value
  emit('save', {
    name: name.value.trim(),
    prompt: prompt.value,
    agentId: agentId.value,
    model: model.value || null,
    effort: model.value && effort.value ? effort.value : null,
    wsId: p.wsId,
    projectName: p.name,
    projectCwd: p.cwd,
    remote: p.remote,
    isolation: remote.value ? 'project' : isolation.value,
    schedule: schedule.value,
    missedRunGraceMinutes: grace.value,
    after: { notify: notify.value, closePane: closePane.value },
    enabled: enabled.value
  })
}
</script>

<template>
  <div class="au-backdrop" @pointerdown.self="onBackdrop">
    <form
      ref="dialogEl"
      class="au-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="au-editor-title"
      data-test="automation-editor"
      :aria-busy="busy"
      @submit.prevent="save"
      @keydown.escape.stop.prevent="cancel"
      @keydown.tab.stop="trapTab"
    >
      <header class="au-dialog-head">
        <h2 id="au-editor-title" class="au-dialog-title">{{ automation ? t('automations.editor.editTitle', 'Edit automation') : t('automations.editor.createTitle', 'Create automation') }}</h2>
        <p class="au-dialog-desc">{{ t('automations.editor.subtitle', 'A recurring agent task') }}</p>
        <button type="button" class="tb-icon au-dialog-close" :aria-label="t('automations.editor.close', 'Close')" :title="t('automations.editor.close', 'Close')" @click="cancel">
          <X :size="16" aria-hidden="true" />
        </button>
      </header>

      <div class="au-dialog-body">
        <!-- The task: a template, its name, where and with which agent, its prompt. -->
        <section class="au-sec">
          <h3 class="set-group-title">{{ t('automations.editor.taskGroup', 'Task') }}</h3>
          <div class="set-card">
            <div v-if="!automation" class="set-row">
              <label class="set-label" for="au-template">
                {{ t('automations.editor.useTemplate', 'Use template') }}
                <span class="set-hint">{{ t('automations.editor.templateHintShort', 'Fills in the name, prompt, schedule and grace.') }}</span>
              </label>
              <ThemedSelect id="au-template" v-model="templateId" class="set-select au-select" data-test="au-template">
                <option value="">{{ t('automations.editor.noTemplate', 'None') }}</option>
                <option v-for="tpl in templates" :key="tpl.id" :value="tpl.id" :title="tpl.description">{{ tpl.label }}</option>
              </ThemedSelect>
            </div>
            <div class="set-row">
              <label class="set-label" for="au-name">{{ t('automations.editor.nameShort', 'Name') }}</label>
              <input
                id="au-name"
                ref="nameInput"
                v-model="name"
                class="set-number au-text"
                data-test="au-name"
                :maxlength="MAX_NAME"
                :placeholder="t('automations.editor.namePlaceholder', 'Weekday repo audit')"
              />
            </div>
            <div class="set-row">
              <label class="set-label" for="au-project">
                {{ t('automations.editor.project', 'Project') }}
                <span v-if="!projects.length" class="set-hint set-warn">{{ t('automations.editor.noProjects', 'Open a project first: an automation runs in one of your projects.') }}</span>
              </label>
              <ThemedSelect id="au-project" v-model="wsId" class="set-select au-select" data-test="au-project">
                <option v-if="projectMissing" :value="wsId" disabled>{{ goneLabel() }}</option>
                <option v-for="p in projects" :key="p.wsId" :value="p.wsId">{{ projectLabel(p) }}</option>
              </ThemedSelect>
            </div>
            <div class="set-row">
              <label class="set-label" for="au-agent">
                {{ t('automations.editor.agent', 'Agent') }}
                <span v-if="!agents.some((ag) => ag.available)" class="set-hint set-warn">{{ t('automations.editor.noAgents', 'No agent that can run automations is on (Claude Code, Codex, Gemini or Qwen).') }}</span>
              </label>
              <ThemedSelect id="au-agent" v-model="agentId" class="set-select au-select" data-test="au-agent">
                <option v-if="!agentId" value="" disabled>{{ t('automations.editor.needAgent', 'Choose an agent before saving.') }}</option>
                <option v-else-if="!agents.some((ag) => ag.id === agentId)" :value="agentId" disabled>{{ agentLabel({ name: agentId, available: false }) }}</option>
                <option v-for="ag in agents" :key="ag.id" :value="ag.id" :disabled="!ag.available">{{ agentLabel(ag) }}</option>
              </ThemedSelect>
            </div>
            <div v-if="models.length" class="set-row">
              <label class="set-label" for="au-model">{{ t('automations.editor.model', 'Model') }}</label>
              <ThemedSelect id="au-model" v-model="model" class="set-select au-select" data-test="au-model">
                <option value="">{{ t('automations.editor.defaultModelShort', 'The agent’s default') }}</option>
                <option v-for="m in models" :key="m.id" :value="m.id">{{ m.label || m.id }}</option>
              </ThemedSelect>
            </div>
            <div v-if="effortChoices.length" class="set-row">
              <label class="set-label" for="au-effort">{{ t('automations.editor.effort', 'Effort') }}</label>
              <ThemedSelect id="au-effort" v-model="effort" class="set-select au-select" data-test="au-effort">
                <option value="">{{ t('automations.editor.defaultEffort', 'Default') }}</option>
                <option v-for="c in effortChoices" :key="c.value" :value="c.value">{{ sessionChoiceLabel(c) }}</option>
              </ThemedSelect>
            </div>
            <div class="set-row au-stack">
              <label class="set-label" for="au-prompt">
                {{ t('automations.editor.prompt', 'Prompt') }}
                <span class="set-hint">{{ promptHint() }}</span>
              </label>
              <textarea
                id="au-prompt"
                v-model="prompt"
                class="set-number au-prompt"
                rows="4"
                data-test="au-prompt"
                :placeholder="t('automations.editor.promptPlaceholder', 'Run the weekly dependency audit and summarize risky changes.')"
              ></textarea>
            </div>
            <div class="set-row">
              <div id="au-where-label" class="set-label">
                {{ t('automations.editor.whereShort', 'Works in') }}
                <span class="set-hint">{{ whereHint() }}</span>
              </div>
              <div class="launch-seg set-seg au-where" role="group" aria-labelledby="au-where-label">
                <button
                  type="button"
                  class="launch-seg-btn"
                  :class="{ on: isolation === 'worktree' && !remote }"
                  :aria-pressed="isolation === 'worktree' && !remote"
                  :disabled="remote"
                  data-test="au-worktree"
                  @click="isolation = 'worktree'"
                >
                  {{ t('automations.editor.ownCopyShort', 'Its own copy') }}
                </button>
                <button
                  type="button"
                  class="launch-seg-btn"
                  :class="{ on: isolation === 'project' || remote }"
                  :aria-pressed="isolation === 'project' || remote"
                  data-test="au-project-folder"
                  @click="isolation = 'project'"
                >
                  {{ t('automations.editor.directShort', 'Project folder') }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- When it runs. -->
        <section class="au-sec">
          <h3 class="set-group-title">{{ t('automations.editor.schedule', 'Schedule') }}</h3>
          <div class="set-card">
            <div class="set-row">
              <label class="set-label" for="au-preset">{{ t('automations.editor.cadence', 'Cadence') }}</label>
              <ThemedSelect id="au-preset" :value="draft.preset" class="set-select au-select" data-test="au-preset" @change="setPreset($event.target.value)">
                <option v-for="p in SCHEDULE_PRESETS" :key="p" :value="p">{{ presetLabel(p) }}</option>
              </ThemedSelect>
            </div>
            <div v-if="draft.preset === 'weekly'" class="set-row">
              <label class="set-label" for="au-day">{{ t('automations.editor.day', 'Day') }}</label>
              <ThemedSelect id="au-day" v-model.number="draft.dayOfWeek" class="set-select au-select" data-test="au-day">
                <option v-for="(d, i) in days" :key="i" :value="i">{{ d }}</option>
              </ThemedSelect>
            </div>
            <div v-if="draft.preset === 'hourly'" class="set-row">
              <label class="set-label" for="au-minute">
                {{ t('automations.editor.minuteShort', 'Minute past the hour') }}
              </label>
              <ThemedSelect id="au-minute" :model-value="minute" class="set-select au-select-short" data-test="au-minute" @update:model-value="setMinute">
                <option v-for="m in minuteChoices" :key="m" :value="m">{{ minuteLabel(m) }}</option>
              </ThemedSelect>
            </div>
            <div v-else-if="draft.preset !== 'custom'" class="set-row">
              <label class="set-label" for="au-time">{{ t('automations.editor.time', 'Time') }}</label>
              <ThemedSelect id="au-time" :model-value="timeValue" class="set-select au-select-short" data-test="au-time" @update:model-value="setTime">
                <option v-for="c in timeChoices" :key="c.value" :value="c.value">{{ c.label }}</option>
              </ThemedSelect>
            </div>
            <div v-if="draft.preset === 'custom'" class="set-row au-stack">
              <label class="set-label" for="au-cron">
                {{ t('automations.editor.cron', 'Cron expression') }}
                <span class="set-hint">{{ t('automations.editor.cronFields', 'Minute · Hour · Day · Month · Weekday') }}</span>
              </label>
              <input
                id="au-cron"
                v-model="draft.custom"
                class="set-number au-cron-input"
                spellcheck="false"
                data-test="au-cron"
                :placeholder="'0 9 * * 1-5'"
              />
              <span v-if="cronInvalid" class="set-hint set-warn" data-test="au-cron-invalid">{{ t('automations.editor.cronInvalid', 'Enter a valid five-field cron before saving.') }}</span>
            </div>
            <div class="set-row">
              <label class="set-label" for="au-grace">
                {{ t('automations.editor.graceShort', 'If a run is missed') }}
                <span class="set-hint">{{ t('automations.editor.graceHintShort', 'Tessel closed or asleep: one missed run starts when it is back within this time.') }}</span>
              </label>
              <ThemedSelect id="au-grace" v-model.number="grace" class="set-select au-select-short" data-test="au-grace">
                <option v-for="g in GRACE_MINUTES" :key="g" :value="g">{{ graceLabel(g) }}</option>
              </ThemedSelect>
            </div>
            <p class="au-next">
              <span v-if="scheduleValid" data-test="au-next">{{ nextRunText() }}</span>
              <span>{{ t('automations.editor.localTime', 'Times use this computer’s local time zone, including for remote projects.') }}</span>
            </p>
          </div>
        </section>

        <!-- After each run, and whether it runs on its schedule. -->
        <section class="au-sec">
          <h3 class="set-group-title">{{ t('automations.editor.after', 'After each run') }}</h3>
          <p class="set-group-desc">{{ t('automations.editor.cardHint', 'Each run is a card on the project\'s board: in Review when it worked in its own copy, else in Done.') }}</p>
          <div class="set-card">
            <label class="set-row">
              <span class="set-label">{{ t('automations.editor.notify', 'Notify me') }}</span>
              <input v-model="notify" type="checkbox" class="set-switch" data-test="au-notify" />
            </label>
            <label class="set-row">
              <span class="set-label">{{ t('automations.editor.closePane', 'Close its pane') }}</span>
              <input v-model="closePane" type="checkbox" class="set-switch" data-test="au-close" />
            </label>
            <label class="set-row">
              <span class="set-label">
                {{ t('automations.editor.enabled', 'Run on its schedule') }}
                <span class="set-hint">{{
                  enabled
                    ? t('automations.editor.onceSavedShort', 'Runs by itself once saved, while Tessel is open.')
                    : t('automations.editor.savedPausedShort', 'Saved paused: it runs only when you click Run now.')
                }}</span>
              </span>
              <input v-model="enabled" type="checkbox" class="set-switch" data-test="au-enabled" />
            </label>
          </div>
        </section>

        <!-- What the agent may do while nobody watches. -->
        <div class="set-callout au-perms" :class="perms && perms.yolo ? 'warn' : 'info'" data-test="au-perms">
          <div class="set-callout-text">
            <strong>{{ permsTitle() }}</strong>
            <p v-if="!perms">{{ t('automations.perms.unknown', 'Choose an agent to see its permissions.') }}</p>
            <template v-else>
              <p v-if="perms.yolo" data-test="au-yolo">{{ yoloText() }}</p>
              <p v-else-if="perms.ownArgs">{{ ownArgsText() }}</p>
              <p v-else>{{ t('automations.perms.manual', 'Manual: it asks before acting. An unattended run stops at each approval until you answer it in its pane (you are notified).') }}</p>
              <p class="au-perms-account">{{ t('automations.perms.account', 'It uses the account chosen for it in Settings > AI provider accounts, and your settings for it in Settings > Agents.') }}</p>
            </template>
          </div>
          <button v-if="perms" type="button" class="exit-btn small" @click="emit('agent-settings')">{{ t('automations.perms.changeShort', 'Agent settings') }}</button>
        </div>
      </div>

      <footer class="au-dialog-foot">
        <p v-if="error" class="au-foot-msg set-warn" role="alert" data-test="au-error">{{ error }}</p>
        <p v-else-if="problem" class="au-foot-msg set-warn" role="alert" data-test="au-error">{{ problem }}</p>
        <p v-else-if="missing" class="au-foot-msg" data-test="au-missing">{{ missing }}</p>
        <span v-else class="au-foot-msg"></span>
        <button type="button" class="exit-btn" :disabled="busy" @click="cancel">{{ t('automations.editor.cancel', 'Cancel') }}</button>
        <button type="submit" class="exit-btn primary" data-test="au-save" :disabled="!!missing || busy">
          {{ automation ? t('automations.editor.saveChangesShort', 'Save changes') : t('automations.editor.create', 'Create') }}
        </button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
/* A dialog over Settings (like Add SSH host): head, a body that scrolls,
   and a footer that stays. */
.au-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgb(0 0 0 / 0.45);
}
.au-dialog {
  display: flex;
  width: min(40rem, 100%);
  max-height: calc(100vh - 3rem);
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 20px 48px rgb(0 0 0 / 0.35);
}
.au-dialog-head {
  position: relative;
  padding: 20px 48px 14px 24px;
  border-bottom: 1px solid var(--border);
}
.au-dialog-title {
  margin: 0;
  color: var(--text-strong);
  font-size: 16px;
  font-weight: 600;
}
.au-dialog-desc {
  margin: 4px 0 0;
  color: var(--text-dim);
  font-size: 12.5px;
}
.au-dialog-close {
  position: absolute;
  top: 12px;
  right: 12px;
}
.au-dialog-body {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 18px;
  overflow-y: auto;
  padding: 16px 24px 20px;
}
.au-sec .set-group-title {
  margin-bottom: 6px;
}
/* Rows of a dialog: a little tighter than a page's. */
.au-dialog .set-card .set-row {
  min-height: 46px;
  padding: 8px 0;
}
.au-select {
  width: 240px;
  min-width: 0;
}
.au-select-short {
  width: 160px;
  min-width: 0;
}
.au-text {
  width: 240px;
  min-width: 0;
}
/* A field under its label, the card's whole width (the prompt, a cron). */
.set-card .set-row.au-stack {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}
.au-prompt {
  width: 100%;
  height: auto;
  min-height: 84px;
  padding: 6px 8px;
  line-height: 1.45;
  resize: vertical;
}
.au-cron-input {
  width: 100%;
  font-family: 'Cascadia Mono', Consolas, monospace;
}
.au-where {
  width: auto;
}
.au-where .launch-seg-btn {
  padding: 0 12px;
  white-space: nowrap;
}
.au-where .launch-seg-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.au-next {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 10px 0 12px;
  color: var(--text-dim);
  font-size: 11.5px;
}
.au-perms {
  align-items: flex-start;
  margin: 0;
}
.au-perms p {
  margin: 4px 0 0;
}
.au-perms-account {
  color: var(--text-dim);
}
.au-dialog-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  border-top: 1px solid var(--border);
}
.au-foot-msg {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  color: var(--text-dim);
  font-size: 12px;
}
.au-foot-msg.set-warn {
  color: var(--warn);
}
.au-dialog-foot .exit-btn {
  flex: 0 0 auto;
}
</style>
