<script setup>
// A skill's token cost, for the Skills page (Settings > Context's counts):
//   tag      "≈ 45 tokens": what the agent loads up front for it (its name
//            and description), for the first agent that reads it, or for
//            `agent`. One read per project folder for all the page's tags
//            (contextCost.js).
//   detailed for each agent that reads it, the up-front cost and its whole
//            SKILL.md (what reading it costs when the skill is used); asked
//            when the details are shown.
//   packageId a skill about to be added (Skills > Add, its preview): the same
//            details from the package the main process already holds, for
//            `agents` (the agents chosen to get it).
// Each number says whether it is exact (and from where) or an estimate.
import { ref, computed, watch } from 'vue'
import { t } from '../../i18n'
import { contextCounts, cwdKey, skillCount, loadSkillCounts, tokensText, sourceLabel, sourceTitle, agentLabel, signIns } from '../../contextCost'

const props = defineProps({
  // A skill from skills:list (its skillFile), or the Skills page's group of
  // copies (its first copy is counted).
  skill: { type: Object, default: null },
  // Whose model counts it (default: the first agent that reads it).
  agent: { type: String, default: null },
  // The project folder (its project skills).
  cwd: { type: String, default: null },
  // The details: per agent, up front and the whole SKILL.md.
  detailed: { type: Boolean, default: false },
  // A previewed package (Skills > Add) and the agents it would go to.
  packageId: { type: String, default: null },
  agents: { type: Array, default: null }
})

const skillFile = computed(() => (props.skill ? props.skill.skillFile || (Array.isArray(props.skill.copies) && props.skill.copies[0] && props.skill.copies[0].skillFile) || null : null))
const rows = ref(null) // detailed (or a chosen agent): [{ agent, model, upfront, full }]
const loading = ref(false)
const detailMode = computed(() => props.detailed || !!props.packageId)

const shared = computed(() => (skillFile.value ? skillCount(props.cwd, skillFile.value) : null))
const sharedLoading = computed(() => !!contextCounts.skillsLoading[cwdKey(props.cwd)])
// The tag's count: the shared one, unless another agent was asked for.
const tagResult = computed(() => {
  if (props.agent && shared.value && shared.value.agent !== props.agent) {
    const row = rows.value && rows.value.find((r) => r.agent === props.agent)
    return row ? row.upfront : null
  }
  return shared.value ? shared.value.result : null
})

let seq = 0
async function loadDetail() {
  const ctx = window.shellApi?.context
  const mine = ++seq
  let ask = null
  if (props.packageId && ctx?.skillPackage) ask = () => ctx.skillPackage({ cwd: props.cwd, id: props.packageId, agents: props.agents && props.agents.length ? [...props.agents] : null, remote: true, ...signIns() })
  else if (skillFile.value && ctx?.skillDetail) ask = () => ctx.skillDetail({ cwd: props.cwd, skillFile: skillFile.value, agents: props.agent ? [props.agent] : null, remote: true, ...signIns() })
  if (!ask) return
  loading.value = true
  try {
    const res = await ask()
    // A later question (another skill, other agents) wins.
    if (mine === seq) rows.value = (res && Array.isArray(res.rows) && res.rows) || []
  } catch {
    if (mine === seq) rows.value = []
  } finally {
    if (mine === seq) loading.value = false
  }
}

function load() {
  if (detailMode.value) return loadDetail()
  loadSkillCounts(props.cwd).then(() => {
    if (props.agent && shared.value && shared.value.agent !== props.agent) loadDetail()
  })
}
watch(() => [skillFile.value, props.agent, props.cwd, props.detailed, props.packageId, (props.agents || []).join(',')], load, { immediate: true })

const upfrontTitle = (r) => t('context.skill.upfrontHint', "What the agent loads in every conversation: the skill's name and description.") + '\n' + sourceTitle(r)
const fullTitle = (r) => t('context.skill.fullHint', 'What reading the whole SKILL.md costs when the skill is used.') + '\n' + sourceTitle(r)
</script>

<template>
  <span v-if="!detailMode" class="ctx-tag" :class="{ estimate: tagResult && !tagResult.exact, empty: !tagResult }" :title="tagResult ? upfrontTitle(tagResult) : undefined" data-test="skill-token-tag">
    <template v-if="tagResult">{{ tokensText(tagResult) }}</template>
    <template v-else-if="sharedLoading || loading">{{ t('context.counting', 'Counting…') }}</template>
  </span>
  <div v-else class="ctx-skill-detail" data-test="skill-token-detail">
    <div v-if="loading && !rows" class="ctx-dim">{{ t('context.counting', 'Counting…') }}</div>
    <div v-for="r in rows || []" :key="r.agent" class="ctx-skill-row">
      <span class="ctx-skill-agent">{{ agentLabel(r.agent) }}</span>
      <span v-if="r.upfront" class="ctx-skill-cost" :title="upfrontTitle(r.upfront)">
        {{ t('context.skill.upfront', 'Up front') }} <strong>{{ tokensText(r.upfront) }}</strong>
      </span>
      <span v-if="r.full" class="ctx-skill-cost" :title="fullTitle(r.full)">
        {{ t('context.skill.full', 'When used') }} <strong>{{ tokensText(r.full) }}</strong>
      </span>
      <span v-if="r.upfront || r.full" class="ctx-src" :class="{ estimate: !(r.full || r.upfront).exact }">{{ sourceLabel(r.full || r.upfront) }}</span>
    </div>
  </div>
</template>

<style scoped>
.ctx-tag {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border-radius: 9px;
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--accent, #4c8dff) 12%, transparent);
  font-variant-numeric: tabular-nums;
}
.ctx-tag.estimate {
  background: color-mix(in srgb, var(--text-dim) 14%, transparent);
}
.ctx-tag.empty:empty {
  display: none;
}
.ctx-skill-detail {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.ctx-skill-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
}
.ctx-skill-agent {
  min-width: 110px;
  color: var(--text);
}
.ctx-skill-cost {
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.ctx-skill-cost strong {
  color: var(--text);
  font-weight: 600;
}
.ctx-src {
  font-size: 11px;
  color: var(--text-dim);
}
.ctx-src.estimate {
  font-style: italic;
}
.ctx-dim {
  color: var(--text-dim);
}
</style>
