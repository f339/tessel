<script setup>
// The context cost of a server's tool definitions ("≈ 1.2k tokens", or
// "1.2k tokens" when exact), which an agent loads in every conversation, in
// Settings > MCP servers and Settings > Context (src/main/contextCost).
//
// Where it is drawn:
//   variant="row"     in each server's row, beside its agent icons. The row
//                     is a <button>: a tag only here, nothing clickable, and
//                     read only (a kept measurement: no server started, no
//                     count API asked, no list of servers read again).
//   variant="details" in each agent's line of the server's details: the tag
//                     and a "Measure" action, which starts the server (or
//                     connects to it) the way Test does, on that click only,
//                     and keeps its definitions; the count then follows the
//                     agent's model. A project server (.mcp.json) Claude Code
//                     was not allowed to start is started only after the user
//                     saw its command and said yes.
// Each number says whether it is exact (and from where) or an estimate.
import { ref, computed, watch, inject } from 'vue'
import { t } from '../../i18n'
import { contextCounts, loadMcpCount, measureMcp, mcpKey, tokensText, sourceLabel, sourceTitle } from '../../contextCost'

const props = defineProps({
  server: { type: String, required: true }, // the server's name
  agent: { type: String, default: null }, // the agent whose settings start it
  scope: { type: String, default: null }, // its scope there (user, local, project)
  cwd: { type: String, default: null }, // the project folder (project scope)
  variant: { type: String, default: 'row' }, // 'row' | 'details'
  model: { type: String, default: null } // the model to count for (default: the agent's own)
})
const emit = defineEmits(['measured'])
const askConfirm = inject('askConfirm', (o) => Promise.resolve(window.confirm(`${o.title}\n\n${o.message}`))) // i18n-ignore

const scopeOf = computed(() => props.scope || 'user')
const key = computed(() => (props.agent ? mcpKey(props.agent, scopeOf.value, props.server, props.cwd) : ''))
const entry = computed(() => (key.value ? contextCounts.mcp[key.value] || null : null))
const busy = computed(() => !!(key.value && contextCounts.measuring[key.value]))
const error = ref('')
const details = computed(() => props.variant === 'details')

// The kept measurement (one read for every tag of the page).
watch(
  () => [props.agent, scopeOf.value, props.server, props.cwd],
  () => props.agent && loadMcpCount({ agent: props.agent, scope: scopeOf.value, name: props.server, cwd: props.cwd }),
  { immediate: true }
)

const toolsText = (n) => (n === 1 ? t('context.mcp.tool', '{{count}} tool', { count: n }) : t('context.mcp.tools', '{{count}} tools', { count: n }))
const title = computed(() => (entry.value && entry.value.result ? `${sourceTitle(entry.value.result)}\n${t('context.mcp.hint', 'Its tool definitions, loaded in every conversation.')}` : ''))

const confirmTitle = (name) => t('context.mcp.confirmTitle', 'Start {{name}}?', { name })
async function measure() {
  if (!props.agent) return
  error.value = ''
  const target = { agent: props.agent, name: props.server, scope: scopeOf.value, cwd: props.cwd, model: props.model }
  let res = await measureMcp(target)
  if (res && res.code === 'needsConfirm') {
    const yes = await askConfirm({
      title: confirmTitle(props.server),
      message: `${t('context.mcp.confirmBody', 'This server comes with the project, and Claude Code has not been allowed to start it. Measuring runs it:')}\n\n${res.target}`, // i18n-ignore
      confirmLabel: t('context.mcp.confirmRun', 'Start and measure')
    })
    if (!yes) return
    res = await measureMcp({ ...target, confirmed: true })
  }
  if (res && res.code === 'disabled') error.value = t('context.mcp.disabled', 'This server is turned off for the project.')
  else if (!res || !res.ok) error.value = (res && res.error) || t('context.mcp.failed', 'The server did not list its tools.')
  emit('measured', res)
}
</script>

<template>
  <span v-if="!details" v-show="entry && entry.result" class="ctx-tag" :class="{ estimate: entry && entry.result && !entry.result.exact }" :title="title" data-test="mcp-token-tag">
    <template v-if="entry && entry.result">{{ tokensText(entry.result) }}</template>
  </span>
  <span v-else class="ctx-mcp" data-test="mcp-token-tag">
    <span v-if="entry && entry.result" class="ctx-tag" :class="{ estimate: !entry.result.exact }" :title="title">
      {{ tokensText(entry.result) }} · {{ toolsText(entry.tools) }}
    </span>
    <span v-if="entry && entry.result" class="ctx-src" :class="{ estimate: !entry.result.exact }" :title="title">{{ sourceLabel(entry.result) }}</span>
    <button
      v-if="agent"
      type="button"
      class="exit-btn small"
      :disabled="busy"
      :title="t('context.mcp.measureHint', 'Starts the server (or connects to it) to read its tool definitions and count them.')"
      @click.stop="measure"
    >
      {{ busy ? t('context.mcp.measuring', 'Measuring…') : entry ? t('context.mcp.measureAgain', 'Measure again') : t('context.mcp.measure', 'Measure') }}
    </button>
    <span v-if="error" class="ctx-error" role="status">{{ error }}</span>
  </span>
</template>

<style scoped>
.ctx-mcp {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.ctx-tag {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border-radius: 9px;
  font-size: 11px;
  white-space: nowrap;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--accent, #4c8dff) 12%, transparent);
  font-variant-numeric: tabular-nums;
}
.ctx-tag.estimate {
  background: color-mix(in srgb, var(--text-dim) 14%, transparent);
}
.ctx-src {
  font-size: 11px;
  color: var(--text-dim);
}
.ctx-src.estimate {
  font-style: italic;
}
.ctx-error {
  font-size: 11px;
  color: var(--warn, #d9a441);
}
</style>
