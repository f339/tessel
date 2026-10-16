<script setup>
// An MCP server's token cost for one agent (Settings > Context's counts): its
// tool definitions, which the agent loads in every conversation. Known once
// measured: Measure starts the server (or connects to it) the way Test does,
// on that click only, and keeps its definitions; the count then follows the
// agent's model. Each number says whether it is exact (and from where) or an
// estimate.
import { ref, computed, onMounted, watch } from 'vue'
import { t } from '../../i18n'
import { contextCounts, loadMcpCounts, measureMcp, mcpKey, tokensText, sourceLabel, sourceTitle } from '../../contextCost'

const props = defineProps({
  // The server as the MCP page lists it for that agent: { name, scope }.
  server: { type: Object, required: true },
  // The agent it is installed in ('claude', 'codex', ...).
  agent: { type: String, required: true },
  // The project folder (its project-scoped servers).
  cwd: { type: String, default: null },
  // The model to count for (default: the agent's own).
  model: { type: String, default: null },
  // Without the Measure button (a list that measures elsewhere).
  readonly: { type: Boolean, default: false }
})
const emit = defineEmits(['measured'])

const key = computed(() => mcpKey(props.agent, props.server.scope, props.server.name))
const entry = computed(() => contextCounts.mcp[key.value] || null)
const busy = computed(() => !!contextCounts.measuring[key.value])
const error = ref('')

onMounted(() => loadMcpCounts(props.cwd))
watch(() => props.cwd, (cwd) => loadMcpCounts(cwd))

const toolsText = (n) => (n === 1 ? t('context.mcp.tool', '{{count}} tool', { count: n }) : t('context.mcp.tools', '{{count}} tools', { count: n }))
const title = computed(() => (entry.value && entry.value.result ? `${sourceTitle(entry.value.result)}\n${t('context.mcp.hint', 'Its tool definitions, loaded in every conversation.')}` : ''))

async function measure() {
  error.value = ''
  const res = await measureMcp({ agent: props.agent, name: props.server.name, scope: props.server.scope || 'user', cwd: props.cwd, model: props.model })
  if (!res || !res.ok) error.value = (res && res.error) || t('context.mcp.failed', 'The server did not list its tools.')
  emit('measured', res)
}
</script>

<template>
  <span class="ctx-mcp" data-test="mcp-token-tag">
    <span v-if="entry && entry.result" class="ctx-tag" :class="{ estimate: !entry.result.exact }" :title="title">
      {{ tokensText(entry.result) }} · {{ toolsText(entry.tools) }}
    </span>
    <span v-if="entry && entry.result" class="ctx-src" :class="{ estimate: !entry.result.exact }" :title="title">{{ sourceLabel(entry.result) }}</span>
    <button
      v-if="!readonly"
      type="button"
      class="exit-btn ctx-small"
      :disabled="busy"
      :title="t('context.mcp.measureHint', 'Starts the server (or connects to it) to read its tool definitions and count them.')"
      @click="measure"
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
.ctx-small {
  height: 24px;
  padding: 0 9px;
  font-size: 11.5px;
}
.ctx-error {
  font-size: 11px;
  color: var(--warn, #d9a441);
}
</style>
