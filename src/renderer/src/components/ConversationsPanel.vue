<script setup>
// Conversations (a tab of the right side panel, after Agents): what the
// agents of a team said to each other through the team channel, and what
// you and an agent said to each other through Tessel (its native chat, the
// notes, a review, a decision on a card, its reports), as threads built from
// the activity log (src/shared/conversations.js). One thread per team and
// one per agent you talked with, latest first; a thread's lines are chat
// rows (who, to whom, when, the text, its delivery status). A scope switch
// (this workspace / all), a period, an agent filter, a search box, and a
// switch to show Tessel's own notices. A thread can be copied as text, and
// an agent's name goes to its pane while it is open.
import { senderDetails } from '../senderIdentity'
import { computed, reactive, ref, shallowRef } from 'vue'
import { Check, ChevronRight, Copy, LocateFixed, MessagesSquare, Search, Users, X } from 'lucide-vue-next'
import BrandIcon from './BrandIcon.vue'
import ThemedSelect from './ui/ThemedSelect.vue'
import { buildThreads, filterThreads, lineCount, participantsOf, recipients, replyText, statusText, threadText } from '../../../shared/conversations'
import { formatWhen } from '../timeFormat'
import { agentLabel } from '../sessionHistory'
import { t, intlLocale } from '../i18n'
import './sessionHistory.css'

const props = defineProps({
  // The activity log (activityStore.js's reactive array).
  events: { type: Array, default: () => [] },
  // App's teams: [{ id, name, color }], for the team threads' names.
  teams: { type: Array, default: () => [] },
  // App's sidebarProjects: which agent panes exist now, and their names.
  projects: { type: Array, default: () => [] },
  // The workspace shown (its conversations by default; All for every one).
  workspaceId: { type: String, default: null },
  now: { type: Number, default: () => Date.now() },
  // Shown now: the threads are built only then (the log changes often).
  active: { type: Boolean, default: true }
})
const emit = defineEmits(['focus-pane', 'toast'])

// --- Filters ----------------------------------------------------------------------------
const scope = ref('workspace')
const period = ref('7d')
const participant = ref('')
const query = ref('')
const notices = ref(false)
const PERIODS = { '24h': 24 * 3600 * 1000, '7d': 7 * 24 * 3600 * 1000, '30d': 30 * 24 * 3600 * 1000 }
const periodLabel = (p) => (p === '24h' ? t('conversations.period.24h', '24 h') : p === '7d' ? t('conversations.period.7d', '7 days') : t('conversations.period.30d', '30 days'))

// The agent panes open now: their names win over the ones recorded, and an
// agent's name goes to its pane.
const panes = computed(() => {
  const out = {}
  for (const p of props.projects || []) for (const pane of p.panes || []) if (pane && pane.id) out[pane.id] = { title: pane.title, agentId: pane.agentId || null, accent: pane.accent || null }
  return out
})
const paneAlive = (id) => !!id && !!panes.value[id]

// --- The threads --------------------------------------------------------------------------
// Built again as the log grows, but only while the tab is shown: hidden, the
// last threads are kept (props.events is not read, so a new event does not
// rebuild anything).
const cache = shallowRef([])
// The period's start moves with the clock only to the minute: a tick of the
// clock does not rebuild the threads.
const from = computed(() => Math.floor((props.now - PERIODS[period.value]) / 60000) * 60000)
const threads = computed(() => {
  if (!props.active) return cache.value
  cache.value = buildThreads(props.events, {
    t,
    teams: props.teams,
    panes: panes.value,
    wsId: scope.value === 'workspace' ? props.workspaceId : null,
    from: from.value,
    notices: notices.value
  })
  return cache.value
})
const participants = computed(() => participantsOf(threads.value))
const shown = computed(() => filterThreads(threads.value, { query: query.value, participant: participant.value }))
const total = computed(() => lineCount(shown.value))
const countText = computed(
  () =>
    `${t('conversations.threads', '{{count}} conversations', { count: shown.value.length })} · ${t('conversations.count', '{{count}} messages', { count: total.value })}`
)

// --- Threads open or folded, lines shown ----------------------------------------------------
const folded = reactive({}) // thread key -> true when folded
const toggleThread = (key) => (folded[key] = !folded[key])
// A thread's lines newest first (the latest message at the top); a long
// thread shows its latest ones, Show earlier (at the bottom) the rest.
const TAIL = 30
const whole = reactive({}) // thread key -> true: every line shown
const visibleLines = (thread) => {
  const newest = [...thread.lines].reverse()
  return whole[thread.key] || newest.length <= TAIL ? newest : newest.slice(0, TAIL)
}
const hiddenCount = (thread) => (whole[thread.key] ? 0 : Math.max(0, thread.lines.length - TAIL))
// A long text is clamped; a click on it shows it whole.
const LONG = 280
const expanded = reactive({}) // line key -> true
const isLong = (line) => line.text.length > LONG || line.text.split('\n').length > 4
const toggleLine = (line) => {
  if (isLong(line)) expanded[line.key] = !expanded[line.key]
}

// A color of its own for each agent's name and avatar, the same every time:
// the pane's accent when Tessel has one, else one of a palette by the name.
const PALETTE = ['#e06c75', '#61afef', '#98c379', '#d19a66', '#c678dd', '#56b6c2', '#f0a35e', '#7aa2f7', '#e5c07b', '#2ac3de']
function agentColor(who) {
  if (!who || who.kind !== 'agent') return null
  const pane = who.paneId ? panes.value[who.paneId] : null
  if (pane && pane.accent) return pane.accent
  let h = 0
  for (const ch of String(who.label || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}
// The program an agent runs (claude, codex, opencode...): its logo beside its
// name and in its avatar. From the line, else from its pane open now.
const agentKind = (who) => (who && (who.agentId || (who.paneId && panes.value[who.paneId] && panes.value[who.paneId].agentId))) || ''
// The program's name after an agent's name ("Ada · Claude Code"), so two
// agents with the same name are told apart.
const programOf = (who) => (agentKind(who) ? agentLabel(agentKind(who)) : '')
// Bubbles like Messenger's: consecutive ones of the same speaker (within ten
// minutes) make a group whose joined corners are nearly square; the name
// goes above the group's first bubble, the avatar beside its last one.
const sameSpeaker = (a, b) => !!a && !!b && a.kind !== 'notice' && b.kind !== 'notice' && a.from.kind === b.from.kind && a.from.label === b.from.label && Math.abs(b.t - a.t) < 10 * 60000
// A time stamp sits between messages an hour or more apart (and above the
// newest one), like Messenger's.
const STAMP_GAP = 60 * 60000
function rows(thread) {
  const lines = visibleLines(thread)
  return lines.map((line, i) => {
    const prev = sameSpeaker(lines[i - 1], line)
    const next = sameSpeaker(line, lines[i + 1])
    const stamp = !lines[i - 1] || Math.abs(lines[i - 1].t - line.t) >= STAMP_GAP
    return { line, shape: prev && next ? 'mid' : prev ? 'last' : next ? 'first' : 'single', head: !prev, tail: !next, stamp }
  })
}
// An agent's bubble carries a faint tint of its color; its avatar, a ring.
const tint = (who) => {
  const c = agentColor(who)
  return c ? { background: `color-mix(in srgb, ${c} 9%, var(--surface-3))` } : null // i18n-ignore
}
const ring = (who) => {
  const c = agentColor(who)
  return c ? { boxShadow: `0 0 0 1.5px ${c}`, background: `color-mix(in srgb, ${c} 18%, var(--surface-2))` } : null // i18n-ignore
}

// What a line says about itself: a reply's nature, a delivery status, its card.
function noteOf(line) {
  return [replyText(line, t), statusText(line, t), line.taskTitle ? t('conversations.onCard', 'on "{{title}}"', { title: line.taskTitle }) : '', line.lead ? t('conversations.lead', 'lead') : '']
    .filter(Boolean)
    .join(' · ')
}
const when = (at) => formatWhen(at, props.now)
const lastText = (thread) => t('conversations.last', 'Last message {{when}}', { when: when(thread.last) })
// Vue closes an interpolation at the first }}: the texts with placeholders
// are made here, not in the template.
const threadLabel = (thread) => (thread.kind === 'team' ? t('conversations.teamThread', 'Team "{{name}}"', { name: thread.title }) : thread.title)
const earlierLabel = (thread) => t('conversations.showEarlier', 'Show the {{count}} earlier messages', { count: hiddenCount(thread) })

function goTo(who) {
  if (who && who.paneId && paneAlive(who.paneId)) emit('focus-pane', who.paneId)
}

// --- Copy -------------------------------------------------------------------------------------
const copied = ref('')
let copiedTimer = 0
async function copyThread(thread) {
  const text = threadText(thread, { t, locale: intlLocale() })
  try {
    await navigator.clipboard.writeText(text)
    copied.value = thread.key
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = ''), 1500)
    emit('toast', t('conversations.copied', 'Conversation copied'))
  } catch {
    emit('toast', t('conversations.copyFailed', 'The conversation could not be copied'))
  }
}

// The model a message was sent with (the sender Tessel recorded): "Opus 5.5 · High".
function modelOf(sender) {
  return sender && typeof sender === 'object' ? sender.model || sender.modelId || '' : ''
}
</script>

<template>
  <div class="sh-panel cv-panel" data-test="conversations">
    <div class="sh-head">
      <div class="sh-head-row">
        <MessagesSquare :size="14" aria-hidden="true" class="cv-head-icon" />
        <div class="sh-head-text">
          <div class="sh-title">{{ t('conversations.title', 'Conversations') }}</div>
          <div class="sh-subtitle">{{ t('conversations.subtitle', 'Between the agents of a team, and with you') }}</div>
        </div>
      </div>
    </div>

    <div class="sh-scope cv-scope" role="group" :aria-label="t('conversations.scope.aria', 'Which conversations')" data-test="cv-scopes">
      <button
        v-for="sc in ['workspace', 'all']"
        :key="sc"
        type="button"
        class="sh-scope-btn"
        :class="{ on: scope === sc }"
        :disabled="sc === 'workspace' && !workspaceId"
        :aria-pressed="scope === sc ? 'true' : 'false'"
        :data-test="'cv-scope-' + sc"
        @click="scope = sc"
      >
        {{ sc === 'workspace' ? t('conversations.scope.workspace', 'This workspace') : t('conversations.scope.all', 'All workspaces') }}
      </button>
    </div>

    <div class="cv-filters">
      <ThemedSelect v-model="period" class="cv-select" :title="t('conversations.period.label', 'Period')" data-test="cv-period">
        <option v-for="p in Object.keys(PERIODS)" :key="p" :value="p">{{ periodLabel(p) }}</option>
      </ThemedSelect>
      <ThemedSelect v-model="participant" class="cv-select" :title="t('conversations.participant.label', 'Agent')" data-test="cv-participant">
        <option value="">{{ t('conversations.participant.all', 'All agents') }}</option>
        <option v-for="p in participants" :key="p" :value="p">{{ p }}</option>
      </ThemedSelect>
      <label class="cv-check" :title="t('conversations.noticesHint', 'Also show what Tessel told the agents (team, cards, deliveries)')">
        <input v-model="notices" type="checkbox" data-test="cv-notices" />
        <span>{{ t('conversations.notices', 'Tessel notices') }}</span>
      </label>
      <label class="sh-search cv-search">
        <Search :size="12" class="sh-search-icon" aria-hidden="true" />
        <input
          v-model="query"
          class="sh-search-input"
          type="search"
          :placeholder="t('conversations.search', 'Search the conversations')"
          :aria-label="t('conversations.search', 'Search the conversations')"
          data-test="cv-search"
        />
        <button
          v-if="query"
          type="button"
          class="sh-search-clear"
          :title="t('conversations.clearSearch', 'Clear search')"
          :aria-label="t('conversations.clearSearch', 'Clear search')"
          data-test="cv-search-clear"
          @click="query = ''"
        >
          <X :size="12" aria-hidden="true" />
        </button>
      </label>
    </div>

    <div class="sh-bar cv-bar" data-test="cv-count">
      <span class="sh-bar-label">{{ countText }}</span>
    </div>

    <div class="sh-list cv-list" role="list" data-test="cv-list">
      <div v-if="!threads.length" class="sh-empty" data-test="cv-empty">
        <MessagesSquare :size="28" class="sh-empty-icon" aria-hidden="true" />
        <p>
          {{
            t(
              'conversations.empty',
              'Nothing said yet. Messages between the agents of a team, and those you exchange with an agent through Tessel (its chat, the notes, decisions on a card), show up here.'
            )
          }}
        </p>
      </div>
      <div v-else-if="!shown.length" class="sh-empty" data-test="cv-none">
        <p>{{ t('conversations.noMatch', 'No message matches.') }}</p>
      </div>
      <section v-for="thread in shown" :key="thread.key" class="cv-thread" :class="{ folded: folded[thread.key] }" role="listitem" :data-test="'cv-thread-' + thread.key">
        <div class="sh-group cv-group">
          <button type="button" class="cv-group-main" :aria-expanded="!folded[thread.key]" :data-test="'cv-toggle-' + thread.key" @click="toggleThread(thread.key)">
            <ChevronRight :size="14" class="sh-chevron-r" :class="{ open: !folded[thread.key] }" aria-hidden="true" />
            <span v-if="thread.kind === 'team'" class="cv-team-icon" :style="thread.color ? { color: thread.color } : null">
              <Users :size="14" aria-hidden="true" />
            </span>
            <BrandIcon v-else :kind="thread.agentId || ''" :size="14" :label="thread.agent" />
            <span class="sh-group-label" :title="lastText(thread)">{{ threadLabel(thread) }}</span>
            <span class="cv-group-when">{{ when(thread.last) }}</span>
            <span class="sh-group-count">{{ thread.count }}</span>
          </button>
          <button
            type="button"
            class="sh-icon-btn cv-copy"
            :title="t('conversations.copy', 'Copy the conversation')"
            :aria-label="t('conversations.copy', 'Copy the conversation')"
            :data-test="'cv-copy-' + thread.key"
            @click.stop="copyThread(thread)"
          >
            <Check v-if="copied === thread.key" :size="13" aria-hidden="true" />
            <Copy v-else :size="13" aria-hidden="true" />
          </button>
        </div>
        <div v-if="!folded[thread.key]" class="cv-lines">
          <template v-for="row in rows(thread)" :key="row.line.key">
          <div v-if="row.stamp" class="cv-stamp" data-test="cv-stamp">{{ when(row.line.t) }}</div>
          <article
            class="cv-line"
            :class="['from-' + row.line.from.kind, 'kind-' + row.line.kind, 'shape-' + row.shape, { long: isLong(row.line), open: expanded[row.line.key], unsent: ['held', 'skipped', 'failed'].includes(row.line.status) }]"
            data-test="cv-line"
          >
            <!-- A Tessel notice: a line in the middle, like a system message. -->
            <div v-if="row.line.kind === 'notice'" class="cv-system" :title="when(row.line.t)">
              <span class="cv-who" data-test="cv-from">{{ row.line.from.label }}</span>
              <span class="cv-arrow" aria-hidden="true">→</span>
              <component
                :is="paneAlive(row.line.to.paneId) ? 'button' : 'span'"
                :type="paneAlive(row.line.to.paneId) ? 'button' : null"
                class="cv-who"
                :class="{ link: paneAlive(row.line.to.paneId) }"
                :style="{ color: agentColor(row.line.to) }"
                data-test="cv-to"
                @click="goTo(row.line.to)"
              >
                {{ row.line.to.label }}
              </component>
              <span class="cv-system-text" :class="{ clamp4: isLong(row.line) && !expanded[row.line.key] }" data-test="cv-text" @click="toggleLine(row.line)">{{ row.line.text }}</span>
            </div>
            <template v-else>
              <!-- The avatar, beside the last bubble of an agent's group. -->
              <div v-if="row.line.from.kind === 'agent'" class="cv-avatar" :class="{ shown: row.tail }" :style="row.tail ? ring(row.line.from) : null" aria-hidden="true">
                <BrandIcon v-if="row.tail" :kind="agentKind(row.line.from)" :size="16" :label="row.line.from.label" :accent="agentColor(row.line.from)" />
              </div>
              <div class="cv-col">
                <div v-if="row.head && row.line.from.kind === 'agent'" class="cv-line-head">
                  <component
                    :is="paneAlive(row.line.from.paneId) ? 'button' : 'span'"
                    :type="paneAlive(row.line.from.paneId) ? 'button' : null"
                    class="cv-who"
                    :class="{ link: paneAlive(row.line.from.paneId) }"
                    :style="{ color: agentColor(row.line.from) }"
                    :title="paneAlive(row.line.from.paneId) ? t('conversations.goToPane', 'Go to its pane') : null"
                    data-test="cv-from"
                    @click="goTo(row.line.from)"
                  >
                    <BrandIcon v-if="agentKind(row.line.from)" :kind="agentKind(row.line.from)" :size="12" class="cv-logo" data-test="cv-logo" />
                    {{ row.line.from.label }}
                    <span v-if="programOf(row.line.from)" class="cv-program" data-test="cv-program">· {{ programOf(row.line.from) }}</span>
                    <LocateFixed v-if="paneAlive(row.line.from.paneId)" :size="10" class="cv-locate" aria-hidden="true" />
                  </component>
                  <!-- The model it sent this with, as Tessel recorded it (every detail on hover). -->
                  <span v-if="modelOf(row.line.sender)" class="cv-model" :title="senderDetails(row.line.sender)" data-test="cv-model">{{ modelOf(row.line.sender) }}</span>
                  <template v-if="thread.kind === 'team'">
                    <span class="cv-arrow" aria-hidden="true">→</span>
                    <template v-for="(to, ti) in recipients(row.line)" :key="ti">
                      <span v-if="ti" class="cv-comma" aria-hidden="true">,</span>
                      <component
                        :is="paneAlive(to.paneId) ? 'button' : 'span'"
                        :type="paneAlive(to.paneId) ? 'button' : null"
                        class="cv-who"
                        :class="{ link: paneAlive(to.paneId) }"
                        :style="{ color: agentColor(to) }"
                        :title="paneAlive(to.paneId) ? t('conversations.goToPane', 'Go to its pane') : null"
                        data-test="cv-to"
                        @click="goTo(to)"
                      >
                        <BrandIcon v-if="agentKind(to)" :kind="agentKind(to)" :size="12" class="cv-logo" />
                        {{ to.label }}
                      </component>
                    </template>
                  </template>
                </div>
                <div class="cv-bubble" :style="row.line.from.kind === 'agent' ? tint(row.line.from) : null" :title="when(row.line.t)">
                  <div class="cv-text" :class="{ clamp4: isLong(row.line) && !expanded[row.line.key] }" data-test="cv-text" @click="toggleLine(row.line)">{{ row.line.text }}</div>
                  <button v-if="isLong(row.line)" type="button" class="cv-more" @click="toggleLine(row.line)">
                    {{ expanded[row.line.key] ? t('conversations.showLess', 'Show less') : t('conversations.showMore', 'Show all') }}
                  </button>
                </div>
                <div class="cv-caption" :class="{ shown: !!noteOf(row.line) }">
                  <span class="cv-when">{{ when(row.line.t) }}</span>
                  <span v-if="noteOf(row.line)" class="cv-note" data-test="cv-note">{{ noteOf(row.line) }}</span>
                </div>
              </div>
            </template>
          </article>
          </template>
          <button v-if="hiddenCount(thread)" type="button" class="cv-earlier" :data-test="'cv-earlier-' + thread.key" @click="whole[thread.key] = true">
            {{ earlierLabel(thread) }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.cv-panel {
  height: 100%;
  color: var(--text);
}
.cv-head-icon {
  flex: 0 0 auto;
  color: var(--text-dim);
}
.cv-scope {
  flex: 0 0 auto;
}
.cv-filters {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
.cv-select {
  flex: 1 1 90px;
  min-width: 0;
}
.cv-check {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  color: var(--text-dim);
  font-size: 11px;
  cursor: pointer;
  user-select: none;
}
.cv-check input {
  margin: 0;
}
.cv-search {
  flex: 1 1 100%;
  margin: 0;
}
.cv-bar {
  flex: 0 0 auto;
}
.cv-list {
  display: flex;
  flex-direction: column;
}
.cv-group {
  padding: 0 4px 0 6px;
  gap: 0;
}
.cv-group-main {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 100%;
  padding: 0 4px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.cv-team-icon {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--text-dim);
}
.cv-group-when {
  flex: 0 0 auto;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
.cv-copy {
  flex: 0 0 auto;
}
.cv-lines {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 10px 12px;
}
.cv-stamp {
  align-self: center;
  margin: 10px 0 4px;
  color: var(--text-dim);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.cv-earlier {
  align-self: center;
  margin-top: 10px;
  padding: 3px 10px;
  border: 0;
  border-radius: 12px;
  background: var(--surface-3);
  color: var(--text-dim);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.cv-earlier:hover {
  color: var(--text-strong);
}

/* --- A row: the avatar, then the name, the bubble and its caption. Like
   Messenger: yours blue on the right, an agent's gray on the left with its
   avatar, a Tessel notice as a small centered line. --- */
.cv-line {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  max-width: 100%;
}
.cv-line.shape-first,
.cv-line.shape-single {
  margin-top: 10px;
}
.cv-stamp + .cv-line {
  margin-top: 0;
}
.cv-line.from-you {
  flex-direction: row-reverse;
}
.cv-line.from-tessel {
  justify-content: center;
  margin: 8px 0 4px;
}
.cv-avatar {
  display: flex;
  flex: 0 0 26px;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-bottom: 2px;
  border-radius: 50%;
  overflow: hidden;
}
.cv-avatar.shown {
  background: var(--surface-2);
}
.cv-col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  max-width: 80%;
}
.cv-line.from-you .cv-col {
  align-items: flex-end;
}
.cv-line-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-width: 0;
  margin: 0 0 2px 10px;
  font-size: 11px;
}
.cv-who {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
}
.cv-who.link {
  cursor: pointer;
}
.cv-logo {
  flex: 0 0 auto;
}
.cv-program {
  color: var(--text-dim);
  font-weight: 500;
}
.cv-model {
  margin-left: 6px;
  color: var(--text-dim);
  font-size: 0.9em;
  white-space: nowrap;
}
.cv-locate {
  opacity: 0.6;
}
.cv-who.link:hover {
  text-decoration: underline;
}
.cv-arrow,
.cv-comma {
  color: var(--text-dim);
}
.cv-comma {
  margin-left: -3px;
}

.cv-bubble {
  position: relative;
  min-width: 0;
  max-width: 100%;
  padding: 8px 13px;
  border-radius: 18px;
  background: var(--surface-3);
  color: var(--text-strong);
  box-shadow: 0 1px 1.5px rgba(0, 0, 0, 0.12);
  transition: filter 80ms;
}
.cv-line:hover .cv-bubble {
  filter: brightness(1.04);
}
.cv-line.from-you .cv-bubble {
  background: linear-gradient(160deg, #2b9bff 0%, #0a7cff 55%, #0066f0 100%);
  color: #fff;
  box-shadow: 0 1px 2px rgba(0, 102, 240, 0.35);
}
/* The joined corners of a group. */
.cv-line.from-agent.shape-first .cv-bubble {
  border-bottom-left-radius: 4px;
}
.cv-line.from-agent.shape-mid .cv-bubble {
  border-top-left-radius: 4px;
  border-bottom-left-radius: 4px;
}
.cv-line.from-agent.shape-last .cv-bubble {
  border-top-left-radius: 4px;
}
.cv-line.from-you.shape-first .cv-bubble {
  border-bottom-right-radius: 4px;
}
.cv-line.from-you.shape-mid .cv-bubble {
  border-top-right-radius: 4px;
  border-bottom-right-radius: 4px;
}
.cv-line.from-you.shape-last .cv-bubble {
  border-top-right-radius: 4px;
}
.cv-line.unsent .cv-bubble {
  opacity: 0.6;
}
.cv-text {
  font-size: 13px;
  line-height: 18.5px;
  letter-spacing: 0.005em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cv-line.long .cv-text {
  cursor: pointer;
}
.cv-more {
  display: block;
  margin-top: 2px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  opacity: 0.8;
  cursor: pointer;
}
.cv-more:hover {
  opacity: 1;
  text-decoration: underline;
}

/* Under the bubble: the time (on hover, like Messenger's), and what the
   line says about itself (a decision asked, not read yet), always shown. */
.cv-caption {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 0;
  margin: 0 10px;
  overflow: hidden;
  color: var(--text-dim);
  font-size: 10.5px;
  line-height: 14px;
  opacity: 0;
  transition:
    max-height 120ms,
    opacity 120ms;
}
.cv-caption.shown,
.cv-line:hover .cv-caption {
  max-height: 40px;
  margin-top: 2px;
  opacity: 1;
}
.cv-caption .cv-when {
  opacity: 0;
}
.cv-line:hover .cv-caption .cv-when {
  opacity: 1;
}
.cv-note {
  font-style: italic;
}

.cv-system {
  max-width: 100%;
  padding: 3px 10px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-3) 55%, transparent);
  color: var(--text-dim);
  font-size: 11px;
  line-height: 15px;
  text-align: center;
}
.cv-system .cv-who {
  font-size: 11px;
}
.cv-system-text {
  display: inline;
  margin-left: 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cv-system-text.clamp4 {
  display: -webkit-box;
  cursor: pointer;
}
</style>
