<script setup>
// Settings > Agents > Your own agents: add a command-line agent of your own
// (settings.customAgents). It shows in the New menu and runs in the default
// shell. Its color is one of a few swatches (no native color input), and a
// preview shows the icon it will have.
import { reactive, computed } from 'vue'
import { t } from '../../i18n'
import { settings } from '../../settings'
import BrandIcon from '../BrandIcon.vue'

const emit = defineEmits(['added'])

// The colors offered, named for screen readers. The first is the default.
const SWATCHES = computed(() => [
  { value: '#8a93a6', label: t('settings.agents.custom.colorGray', 'Gray') },
  { value: '#e07a5f', label: t('settings.agents.custom.colorOrange', 'Orange') },
  { value: '#e5c07b', label: t('settings.agents.custom.colorYellow', 'Yellow') },
  { value: '#56b870', label: t('settings.agents.custom.colorGreen', 'Green') },
  { value: '#2bb5a8', label: t('settings.agents.custom.colorTeal', 'Teal') },
  { value: '#5b8def', label: t('settings.agents.custom.colorBlue', 'Blue') },
  { value: '#a371f7', label: t('settings.agents.custom.colorPurple', 'Purple') },
  { value: '#e06c9f', label: t('settings.agents.custom.colorPink', 'Pink') }
])
const form = reactive({ name: '', command: '', accent: '#8a93a6', error: '' })

function add() {
  form.error = ''
  const name = form.name.trim()
  const command = form.command.trim()
  if (!name || !command) {
    form.error = t('tools.custom.needNameCommand', 'Enter a name and the command that starts the agent.')
    return
  }
  if (settings.customAgents.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
    form.error = t('tools.custom.nameTaken', 'An agent with that name already exists.')
    return
  }
  settings.customAgents.push({
    id: `custom-${Date.now().toString(36)}`, // i18n-ignore
    name,
    command,
    accent: form.accent
  })
  form.name = ''
  form.command = ''
  emit('added')
}

// Arrow keys move between the swatches, as in any radio group.
function swatchKey(e) {
  const list = SWATCHES.value.map((s) => s.value)
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
  if (!step) return
  e.preventDefault()
  const i = (list.indexOf(form.accent) + step + list.length) % list.length
  form.accent = list[i]
  e.currentTarget.querySelectorAll('[role="radio"]')[i]?.focus()
}
</script>

<template>
  <form class="agent-add" data-test="custom-agent-form" @submit.prevent="add">
    <div class="agent-add-fields">
      <BrandIcon class="agent-add-preview" kind="custom-preview" :accent="form.accent" :label="form.name.trim() || '?'" :size="22" />
      <input
        v-model="form.name"
        class="set-number agent-add-name"
        :placeholder="t('tools.custom.namePlaceholder', 'Name, e.g. Crush')"
        :aria-label="t('settings.agents.custom.name', 'Name')"
        spellcheck="false"
      />
      <input
        v-model="form.command"
        class="set-number agent-add-command"
        :placeholder="t('tools.custom.commandPlaceholder', 'Command, e.g. crush --yolo')"
        :aria-label="t('settings.agents.custom.command', 'Command')"
        spellcheck="false"
      />
    </div>
    <div class="agent-add-foot">
      <div class="agent-swatches" role="radiogroup" :aria-label="t('tools.custom.color', 'Color')" @keydown="swatchKey">
        <span class="set-hint">{{ t('tools.custom.color', 'Color') }}</span>
        <button
          v-for="s in SWATCHES"
          :key="s.value"
          type="button"
          role="radio"
          class="agent-swatch"
          :class="{ on: form.accent === s.value }"
          :style="{ '--swatch': s.value }"
          :aria-checked="form.accent === s.value"
          :aria-label="s.label"
          :title="s.label"
          :tabindex="form.accent === s.value ? 0 : -1"
          @click="form.accent = s.value"
        ></button>
      </div>
      <button class="exit-btn" type="submit" data-test="custom-agent-add">{{ t('tools.custom.add', 'Add agent') }}</button>
    </div>
    <p v-if="form.error" class="set-callout warn agent-add-error" role="alert">
      <span class="set-callout-text">{{ form.error }}</span>
    </p>
  </form>
</template>

<style scoped>
.agent-add {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.agent-add-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.agent-add-preview {
  flex: 0 0 auto;
}
.agent-add-name {
  flex: 1 1 150px;
  min-width: 0;
}
.agent-add-command {
  flex: 3 1 220px;
  min-width: 0;
  font-family: 'Cascadia Mono', Consolas, monospace;
}
.agent-add-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}
.agent-swatches {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.agent-swatches .set-hint {
  margin-right: 2px;
}
.agent-swatch {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
  background: var(--swatch);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25);
  cursor: pointer;
}
.agent-swatch.on {
  border-color: var(--text-strong);
}
.agent-swatch:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.agent-add-error {
  margin: 0;
}
</style>
