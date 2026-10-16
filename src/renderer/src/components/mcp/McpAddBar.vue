<script setup>
// The bar at the bottom of Catalog and Custom, always in view while the page
// scrolls: which agents get the server (chips that wrap, never a row of
// checkboxes running out of the card), Claude Code's scope, and Add.
import { computed } from 'vue'
import BrandIcon from '../BrandIcon.vue'
import { t } from '../../i18n'
import { AGENT_NAME } from './mcpShared'

const props = defineProps({
  agents: { type: Array, default: () => [] }, // the agents installed here
  targets: { type: Object, required: true }, // agent -> chosen
  // agent -> why it cannot take this server (already has it, no SSE…).
  blocked: { type: Object, default: () => ({}) },
  scope: { type: String, default: 'user' },
  cwd: { type: String, default: null },
  label: { type: String, required: true }, // the Add button's text
  busy: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  error: { type: String, default: '' }
})
const emit = defineEmits(['update:scope', 'toggle', 'add'])

const chosen = computed(() => props.agents.filter((a) => props.targets[a] && !props.blocked[a]))
function toggle(a) {
  if (!props.blocked[a]) emit('toggle', a)
}
</script>

<template>
  <div class="mcp-addbar" role="group" :aria-label="t('mcp.addbar.label', 'Add to agents')">
    <div class="mcp-addbar-agents">
      <span class="mcp-addbar-label">{{ t('mcp.addTo', 'Add to') }}</span>
      <div class="mcp-addbar-chips">
        <button
          v-for="a in agents"
          :key="a"
          type="button"
          class="chip"
          :class="{ on: targets[a] && !blocked[a] }"
          :aria-pressed="targets[a] && !blocked[a] ? 'true' : 'false'"
          :disabled="!!blocked[a]"
          :title="blocked[a] || ''"
          :data-agent="a"
          @click="toggle(a)"
        >
          <BrandIcon :kind="a" :size="12" />{{ AGENT_NAME[a] }}
        </button>
      </div>
    </div>
    <div class="mcp-addbar-actions">
      <template v-if="chosen.includes('claude')">
        <span class="mcp-addbar-scope-label">{{ t('mcp.addbar.claudeScope', 'Claude Code:') }}</span>
        <div class="launch-seg set-seg mcp-addbar-scope" role="radiogroup" :aria-label="t('mcp.claudeScope', 'For Claude Code, use it in')">
          <button
            type="button"
            role="radio"
            class="launch-seg-btn"
            :class="{ on: scope === 'user' }"
            :aria-checked="scope === 'user' ? 'true' : 'false'"
            @click="emit('update:scope', 'user')"
          >
            {{ t('mcp.scope.user', 'All projects') }}
          </button>
          <button
            type="button"
            role="radio"
            class="launch-seg-btn"
            :class="{ on: scope === 'project' }"
            :aria-checked="scope === 'project' ? 'true' : 'false'"
            :disabled="!cwd"
            :title="cwd || t('mcp.claudeScopeHint', 'Set a workspace folder to limit it to one project')"
            @click="emit('update:scope', 'project')"
          >
            {{ t('mcp.scope.thisProject', 'This project') }}
          </button>
        </div>
      </template>
      <!-- "This project" is for Claude Code: Codex servers are global. -->
      <span v-if="scope === 'project' && chosen.includes('codex')" class="mcp-addbar-note">{{ t('mcp.codexScope', 'Codex servers always apply to all projects.') }}</span>
      <span class="mcp-addbar-spacer"></span>
      <slot name="secondary" />
      <button type="button" class="exit-btn primary mcp-addbar-add" :disabled="busy || disabled || !chosen.length" @click="emit('add')">
        {{ busy ? t('mcp.adding', 'Adding…') : label }}
      </button>
    </div>
    <p v-if="error" class="mcp-addbar-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.mcp-addbar {
  position: sticky;
  z-index: 5;
  bottom: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* Edge to edge in its card: the card's padding, set by McpDialog. */
  margin: 12px calc(-1 * var(--mcp-pad-x, 18px)) calc(-1 * var(--mcp-pad-b, 14px));
  padding: 10px var(--mcp-pad-x, 18px) 12px;
  border-top: 1px solid var(--border);
  border-radius: 0 0 10px 10px;
  background: var(--surface-2);
  box-shadow: 0 -8px 16px -12px rgba(0, 0, 0, 0.6);
}
.mcp-addbar-agents {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.mcp-addbar-label,
.mcp-addbar-scope-label {
  flex: 0 0 auto;
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 22px;
  white-space: nowrap;
}
.mcp-addbar-chips {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
.mcp-addbar-chips .chip:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.mcp-addbar-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}
.mcp-addbar-scope {
  flex: 0 0 auto;
  width: auto;
}
.mcp-addbar-scope .launch-seg-btn {
  flex: 0 0 auto;
  padding: 0 10px;
  white-space: nowrap;
}
.mcp-addbar-note {
  color: var(--text-dim);
  font-size: 11px;
}
.mcp-addbar-spacer {
  flex: 1 1 auto;
}
.mcp-addbar-add {
  white-space: nowrap;
}
.mcp-addbar-error {
  margin: 0;
  color: #ffb4b6;
  font-size: 11.5px;
  white-space: pre-line;
}
</style>
