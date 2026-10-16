<script setup>
// Settings > Quick commands: text sent to the active pane from the command
// palette.
import { ref } from 'vue'
import { t } from '../../i18n'
import { settings } from '../../settings'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const { shown } = useSettingsShell()

// Quick commands: text sent to the active pane from the command palette.
const quickDraft = ref({ name: '', text: '', enter: true, error: '' })
function addQuickCommand() {
  const d = quickDraft.value
  const name = d.name.trim()
  const text = d.text.replace(/\s+$/, '')
  if (!name || !text.trim()) {
    d.error = t('settings.quick.missing', 'Give it a name and the text to send.')
    return
  }
  settings.quickCommands.push({ id: `qc-${Date.now().toString(36)}`, name, text, enter: !!d.enter }) // i18n-ignore
  quickDraft.value = { name: '', text: '', enter: d.enter, error: '' }
}
function removeQuickCommand(id) {
  const i = settings.quickCommands.findIndex((q) => q.id === id)
  if (i >= 0) settings.quickCommands.splice(i, 1)
}
</script>

<template>
  <section
    id="set-quick-commands"
    class="set-page"
    data-page="quick-commands"
    :hidden="!shown('quick-commands')"
    aria-labelledby="set-quick-commands-title"
  >
    <header class="set-page-head">
      <h2 id="set-quick-commands-title">{{ PAGES['quick-commands'].title }}</h2>
      <p class="set-page-desc">{{ PAGES['quick-commands'].desc }}</p>
    </header>
    <div class="set-group">
      <div class="set-card">
        <p class="set-hint set-card-text">
          {{ t('settings.quick.intro', 'Text you send to the active pane from the command palette (Ctrl+Shift+P, then "Run: name"): a command you type often, or a prompt for an agent.') }}
        </p>
        <div v-for="q in settings.quickCommands" :key="q.id" class="set-row quick-row">
          <div class="set-label">
            {{ q.name }}
            <span class="set-hint quick-text">{{ q.text }}{{ q.enter ? ' ⏎' : '' }}</span>
          </div>
          <button class="exit-btn" type="button" @click="removeQuickCommand(q.id)">{{ t('settings.quick.remove', 'Remove') }}</button>
        </div>
        <form class="custom-agent-form" @submit.prevent="addQuickCommand">
          <input
            v-model="quickDraft.name"
            class="set-number"
            :placeholder="t('settings.quick.namePlaceholder', 'Name, e.g. Run tests')"
            :aria-label="t('settings.quick.nameLabel', 'Quick command name')"
            spellcheck="false"
          />
          <input
            v-model="quickDraft.text"
            class="set-number mcp-input"
            :placeholder="t('settings.quick.textPlaceholder', 'Text, e.g. npm test')"
            :aria-label="t('settings.quick.textLabel', 'Quick command text')"
            spellcheck="false"
          />
          <label class="quick-enter"><input v-model="quickDraft.enter" type="checkbox" /> {{ t('settings.quick.pressEnter', 'Press Enter') }}</label>
          <button class="exit-btn primary" type="submit">{{ t('settings.quick.add', 'Add') }}</button>
        </form>
        <p v-if="quickDraft.error" class="mcp-error">{{ quickDraft.error }}</p>
      </div>
    </div>
  </section>
</template>
