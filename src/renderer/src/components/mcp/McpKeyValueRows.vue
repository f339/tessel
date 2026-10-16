<script setup>
// Environment variables or HTTP headers as name / value rows. Values are
// masked (they are usually keys and tokens) until their eye shows them; a
// bad name says so once it is typed, never before.
import { Eye, EyeOff, X, Plus } from 'lucide-vue-next'
import { t } from '../../i18n'

const props = defineProps({
  rows: { type: Array, required: true }, // [{ key, value, show }] (changed here)
  kind: { type: String, default: 'env' }, // 'env' | 'header'
  submitted: { type: Boolean, default: false } // Add was tried
})

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
// Why a row's name is wrong ('' when fine). An empty name with a value
// counts only once Add was tried.
function nameError(row) {
  const key = row.key.trim()
  if (!key) return props.submitted && row.value ? t('mcp.kv.nameMissing', 'Enter a name.') : ''
  if (props.kind === 'env' && !ENV_NAME.test(key)) return t('mcp.kv.envName', 'Letters, digits and _, not starting with a digit.')
  if (props.kind === 'header' && !HEADER_NAME.test(key)) return t('mcp.kv.headerName', 'No spaces or colons in a header name.')
  return ''
}
defineExpose({ hasErrors: () => props.rows.some((r) => nameError(r) || (!r.key.trim() && r.value)) })

const showLabel = (row) => (row.show ? t('mcp.kv.hide', 'Hide the value') : t('mcp.kv.show', 'Show the value'))

function add() {
  props.rows.push({ key: '', value: '', show: false })
}
function drop(i) {
  props.rows.splice(i, 1)
}
</script>

<template>
  <div class="mcpkv">
    <div v-for="(row, i) in rows" :key="i" class="mcpkv-row">
      <input
        v-model="row.key"
        class="set-number mcpkv-key"
        :class="{ invalid: nameError(row) }"
        :placeholder="kind === 'env' ? 'API_KEY' : 'Authorization'"
        :aria-label="kind === 'env' ? t('mcp.kv.envKey', 'Variable name') : t('mcp.kv.headerKey', 'Header name')"
        :aria-invalid="nameError(row) ? 'true' : 'false'"
        spellcheck="false"
        autocomplete="off"
      />
      <input
        v-model="row.value"
        class="set-number mcpkv-value"
        :type="row.show ? 'text' : 'password'"
        :placeholder="t('mcp.kv.value', 'Value')"
        :aria-label="t('mcp.kv.value', 'Value')"
        spellcheck="false"
        autocomplete="off"
      />
      <button type="button" class="tb-icon" :aria-label="showLabel(row)" :title="showLabel(row)" :aria-pressed="row.show ? 'true' : 'false'" @click="row.show = !row.show">
        <EyeOff v-if="row.show" :size="13" aria-hidden="true" />
        <Eye v-else :size="13" aria-hidden="true" />
      </button>
      <button type="button" class="tb-icon" :aria-label="t('mcp.kv.remove', 'Remove this row')" :title="t('mcp.kv.remove', 'Remove this row')" @click="drop(i)">
        <X :size="13" aria-hidden="true" />
      </button>
      <span v-if="nameError(row)" class="mcpkv-error" role="alert">{{ nameError(row) }}</span>
    </div>
    <button type="button" class="exit-btn small mcpkv-add" @click="add">
      <Plus :size="12" aria-hidden="true" />
      {{ kind === 'env' ? t('mcp.kv.addEnv', 'Add a variable') : t('mcp.kv.addHeader', 'Add a header') }}
    </button>
  </div>
</template>

<style scoped>
.mcpkv {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
}
.mcpkv-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  width: 100%;
}
.mcpkv-key {
  flex: 0 1 38%;
  width: auto;
  min-width: 90px;
  height: 28px;
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11.5px;
  text-align: left;
}
.mcpkv-value {
  flex: 1 1 140px;
  width: auto;
  min-width: 0;
  height: 28px;
  text-align: left;
}
.mcpkv-key.invalid {
  border-color: var(--danger);
}
.mcpkv-error {
  flex-basis: 100%;
  color: #ffb4b6;
  font-size: 11.5px;
}
</style>
