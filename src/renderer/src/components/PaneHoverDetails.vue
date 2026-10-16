<script setup>
// What a pane header's hover card shows, laid out like the sidebar's agent
// card (AgentHoverDetails, after Orca's worktree details hover; MIT,
// Copyright (c) 2026 Lovecast Inc.): the pane's name as the heading, the
// agent (or shell) with its icon, its model and conversation under it, its
// state with the dot, its team and a muted hint. It
// replaces the header title's native tooltip.
import { computed, watch } from 'vue'
import { Users, SquareTerminal, Cpu, MessageSquareText, GitBranch, Coins, UserRound, Layers } from 'lucide-vue-next'
import BrandIcon from './BrandIcon.vue'
import AgentStateDot from './sidebar/AgentStateDot.vue'
import { t, currentLocale } from '../i18n'
import { useJobCost, hasUsage, jobCostLine, jobCostDetails } from '../jobCost'
import { contextStart, loadContextStart, startKey, tokensText, groupsText } from '../contextCost'

const props = defineProps({
  // Built by TerminalPane: { heading, agentName, iconKind, accent, model,
  // conversation, branch, state: { dot, label } | null, stateDetail, warn,
  // yolo, team: { name, lead } | null, session, id }
  info: { type: Object, required: true }
})
// On an SSH host (info.accountCheck): ask the host now which account it is.
// Restarting on another account is the pane menu's (Restart on…): one click
// in a card that opens on hover would stop a busy agent mid-turn.
defineEmits(['check-account'])

const modelLine = computed(() => (props.info.model ? t('pane.model.title', 'Model: {{model}}', { model: props.info.model }) : ''))
// The account it runs on (when its agent has more than one).
const accountLine = computed(() => (props.info.account ? t('pane.account.chip', 'Account: {{account}}', { account: props.info.account }) : ''))
const branchLine = computed(() =>
  props.info.branch ? t('pane.title.branch', 'Branch: {{branch}} (separate copy)', { branch: props.info.branch }) : ''
)
const teamLine = computed(() => {
  const team = props.info.team
  if (!team) return ''
  return team.lead ? t('sidebar.hover.teamLead', '{{team}} (lead)', { team: team.name }) : team.name
})
// What the pane's current session used (tokens, time, estimated cost), asked
// while the card is open (jobCost.js).
const costOf = useJobCost('panes', () => (props.info.id ? [props.info.id] : []))
const cost = computed(() => costOf(props.info.id))
const costLine = computed(() => (currentLocale(), hasUsage(cost.value) ? jobCostLine(cost.value) : ''))
const costDetails = computed(() => (currentLocale(), costLine.value ? jobCostDetails(cost.value, undefined, { withSummary: false }).split('\n') : []))
const sessionLine = computed(() => (props.info.session ? t('pane.status.session', 'Session {{id}}', { id: props.info.session }) : ''))
// What its agent loaded before the first message (Settings > Context),
// read while the card is open.
watch(() => startKey(props.info), () => loadContextStart(props.info), { immediate: true })
const start = computed(() => contextStart[startKey(props.info)] || null)
const startLine = computed(() => (start.value && start.value.total ? t('context.pane.start', 'At start: {{tokens}}', { tokens: tokensText({ tokens: start.value.total, exact: start.value.exact }) }) : ''))
const startDetail = computed(() => (start.value ? groupsText(start.value.groups) : ''))
</script>

<template>
  <div class="hc-body" data-pane-hover-details="" role="group" :aria-label="info.agentName ? `${info.heading} (${info.agentName})` : info.heading">
    <div class="hc-identity">
      <div class="hc-title hc-title-row" data-hover-heading="">
        <BrandIcon :kind="info.iconKind" :accent="info.accent" :label="info.agentName || null" :size="14" />
        <span v-text="info.heading"></span>
      </div>
      <div v-if="modelLine" class="hc-agent hc-model" data-hover-model="">
        <Cpu :size="12" aria-hidden="true" />
        <span v-text="modelLine"></span>
      </div>
      <div v-if="accountLine" class="hc-agent" data-hover-account="">
        <UserRound :size="12" aria-hidden="true" />
        <span v-text="accountLine"></span>
      </div>
      <div v-for="(note, i) in info.accountNotes || []" :key="`n${i}`" class="hc-detail hc-account-note" data-hover-account-note="" v-text="note"></div>
      <!-- Its Claude account has no subscription (or a payment issue). -->
      <div v-if="info.accountWarn" class="hc-warn hc-account-warn" data-hover-account-warn="" v-text="info.accountWarn"></div>
      <div v-if="info.accountCheck" class="hc-account-actions">
        <button type="button" class="hc-link" data-test="hover-check-account" @click="$emit('check-account')">
          {{ t('pane.account.checkAgain', 'Check again') }}
        </button>
      </div>
      <div v-if="info.conversation" class="hc-agent" data-hover-conversation="">
        <MessageSquareText :size="12" aria-hidden="true" />
        <span v-text="info.conversation"></span>
      </div>
      <div v-if="branchLine" class="hc-agent hc-branch-line">
        <GitBranch :size="12" aria-hidden="true" />
        <span v-text="branchLine"></span>
      </div>
    </div>

    <template v-if="info.state">
      <div class="hc-status" data-hover-state="">
        <AgentStateDot :state="info.state.dot" :tooltip="false" />
        <span class="hc-status-label" v-text="info.state.label"></span>
      </div>
      <div v-if="info.stateDetail" class="hc-detail" v-text="info.stateDetail"></div>
    </template>
    <div v-if="info.warn" class="hc-warn" v-text="info.warn"></div>
    <div v-if="info.yolo" class="hc-warn" v-text="info.yolo"></div>

    <section v-if="teamLine" class="hc-section" data-hover-team="">
      <div class="hc-section-title">
        <Users :size="12" aria-hidden="true" />
        <span>{{ t('sidebar.hover.team', 'Team') }}</span>
      </div>
      <div class="hc-section-body hc-strong" v-text="teamLine"></div>
    </section>

    <section v-if="costLine" class="hc-section" data-hover-cost="">
      <div class="hc-section-title">
        <Coins :size="12" aria-hidden="true" />
        <span>{{ t('jobCost.hover.title', 'This session') }}</span>
      </div>
      <div class="hc-section-body hc-lines">
        <span class="hc-strong" data-hover-cost-line="" v-text="costLine"></span>
        <span v-for="(line, i) in costDetails" :key="i" class="hc-muted" v-text="line"></span>
      </div>
    </section>

    <section v-if="startLine" class="hc-section" data-hover-context="">
      <div class="hc-section-title">
        <Layers :size="12" aria-hidden="true" />
        <span>{{ t('context.pane.title', 'Context') }}</span>
      </div>
      <div class="hc-section-body hc-lines" :title="t('context.pane.hint', 'Rules files, skills, MCP tools and Tessel’s team tools it loads before your first message. Details in Settings > Context.')">
        <span class="hc-strong" v-text="startLine"></span>
        <span v-if="startDetail" class="hc-muted" v-text="startDetail"></span>
      </div>
    </section>

    <div v-if="sessionLine" class="hc-footer" data-hover-pane="">
      <SquareTerminal :size="12" aria-hidden="true" />
      <span v-if="sessionLine" class="hc-session" v-text="sessionLine"></span>
    </div>
    <div class="hc-hint" data-hover-hint="">
      {{ t('pane.title.hint', 'Double-click to rename. Drag the header to move the pane. More in the … menu') }}
    </div>
  </div>
</template>
