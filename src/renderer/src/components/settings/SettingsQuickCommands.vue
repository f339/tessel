<script setup>
// Settings > Quick commands: text sent to the active pane from the command
// palette. One row each (the Skills look); a row opens its details, where
// the command is edited in place (saved as it is typed, while it has a name
// and a text) or removed.
import { inject, ref } from 'vue'
import { SquareTerminal } from 'lucide-vue-next'
import { t } from '../../i18n'
import { settings } from '../../settings'
import SettingsListItem from './SettingsListItem.vue'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const { shown } = useSettingsShell()
const askConfirm = inject('askConfirm', null)
const MAX_TEXT = 20000

// A new one.
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

// The one open, and what its fields hold (the saved command changes only
// while they make a valid one).
const openId = ref(null)
const edit = ref(null)
function toggle(q) {
  if (openId.value === q.id) {
    openId.value = null
    edit.value = null
    return
  }
  openId.value = q.id
  edit.value = { id: q.id, name: q.name, text: q.text, enter: q.enter, error: '' }
}
function change(field, value) {
  const e = edit.value
  if (!e) return
  e[field] = value
  const name = e.name.trim()
  const text = e.text.replace(/\s+$/, '')
  if (!name || !text.trim()) {
    e.error = t('settings.quick.missing', 'Give it a name and the text to send.')
    return
  }
  e.error = ''
  const q = settings.quickCommands.find((x) => x.id === e.id)
  if (q) Object.assign(q, { name, text, enter: !!e.enter })
}
async function removeQuickCommand(q) {
  if (askConfirm) {
    const ok = await askConfirm({
      title: t('settings.quick.removeTitle', 'Remove “{{name}}”?', { name: q.name }),
      text: t('settings.quick.removeText', 'It is no longer offered in the command palette.'),
      confirmLabel: t('settings.quick.remove', 'Remove'),
      danger: true
    })
    if (!ok) return
  }
  const i = settings.quickCommands.findIndex((x) => x.id === q.id)
  if (i >= 0) settings.quickCommands.splice(i, 1)
  if (openId.value === q.id) {
    openId.value = null
    edit.value = null
  }
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
      <h3 class="set-group-title">{{ t('settings.quick.listTitle', 'Your commands') }}</h3>
      <p class="set-group-desc">{{ t('settings.quick.paletteHint', 'Press Ctrl+Shift+P, then type “Run:” and the name: a command you type often, or a prompt for an agent.') }}</p>
      <div class="set-card set-card-pad quick-card">
        <p v-if="!settings.quickCommands.length" class="quick-empty" data-test="quick-empty">
          {{ t('settings.quick.empty', 'No quick commands yet: add your first one below.') }}
        </p>
        <ul v-else class="sl-list quick-list">
          <SettingsListItem
            v-for="q in settings.quickCommands"
            :key="q.id"
            :open="openId === q.id"
            :name="q.name"
            :desc="q.text"
            :data-quick="q.id"
            @toggle="toggle(q)"
          >
            <template #icon><SquareTerminal :size="16" class="quick-icon" aria-hidden="true" /></template>
            <template #tags>
              <span v-if="q.enter" class="tag tag-scope" :title="t('settings.quick.entersTitle', 'Presses Enter after the text')">{{ t('settings.quick.entersTag', 'Enter') }}</span>
            </template>
            <div v-if="edit && edit.id === q.id" class="quick-edit">
              <label class="quick-field">
                <span class="quick-field-label">{{ t('settings.quick.nameField', 'Name') }}</span>
                <input
                  class="set-number"
                  data-test="quick-edit-name"
                  spellcheck="false"
                  :value="edit.name"
                  @input="change('name', $event.target.value)"
                />
              </label>
              <label class="quick-field">
                <span class="quick-field-label">{{ t('settings.quick.textField', 'Text sent to the pane') }}</span>
                <textarea
                  class="set-number quick-textarea"
                  data-test="quick-edit-text"
                  rows="3"
                  spellcheck="false"
                  :maxlength="MAX_TEXT"
                  :value="edit.text"
                  @input="change('text', $event.target.value)"
                ></textarea>
              </label>
              <p v-if="edit.error" class="set-hint set-warn" role="alert" data-test="quick-edit-error">{{ edit.error }}</p>
              <div class="quick-edit-foot">
                <label class="quick-switch">
                  <input
                    type="checkbox"
                    class="set-switch"
                    data-test="quick-edit-enter"
                    :checked="edit.enter"
                    @change="change('enter', $event.target.checked)"
                  />
                  <span>{{ t('settings.quick.pressEnterAfter', 'Press Enter after the text') }}</span>
                </label>
                <button type="button" class="exit-btn small danger" data-test="quick-remove" @click="removeQuickCommand(q)">
                  {{ t('settings.quick.remove', 'Remove') }}
                </button>
              </div>
            </div>
          </SettingsListItem>
        </ul>

        <form class="quick-add" data-test="quick-add" @submit.prevent="addQuickCommand">
          <h4 class="quick-add-title">{{ t('settings.quick.addTitle', 'New command') }}</h4>
          <div class="quick-add-fields">
            <input
              v-model="quickDraft.name"
              class="set-number"
              data-test="quick-name"
              :placeholder="t('settings.quick.namePlaceholder', 'Name, e.g. Run tests')"
              :aria-label="t('settings.quick.nameLabel', 'Quick command name')"
              spellcheck="false"
            />
            <input
              v-model="quickDraft.text"
              class="set-number quick-text-input"
              data-test="quick-text"
              :placeholder="t('settings.quick.textPlaceholder', 'Text, e.g. npm test')"
              :aria-label="t('settings.quick.textLabel', 'Quick command text')"
              spellcheck="false"
            />
          </div>
          <div class="quick-add-foot">
            <label class="quick-switch">
              <input v-model="quickDraft.enter" type="checkbox" class="set-switch" data-test="quick-enter" />
              <span>{{ t('settings.quick.pressEnterAfter', 'Press Enter after the text') }}</span>
            </label>
            <button class="exit-btn primary quick-add-btn" type="submit">{{ t('settings.quick.add', 'Add') }}</button>
          </div>
          <p v-if="quickDraft.error" class="set-hint set-warn" role="alert" data-test="quick-error">{{ quickDraft.error }}</p>
        </form>
      </div>
    </div>
  </section>
</template>

<style scoped>
.quick-card {
  container-type: inline-size;
}
.quick-empty {
  margin: 0 0 12px;
  color: var(--text-dim);
  font-size: 12.5px;
}
.quick-list {
  margin: -6px 0 14px;
  border-top: 0;
}
.quick-list :deep(.sl-row-desc) {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
}
.quick-icon {
  color: var(--text-dim);
}
.quick-edit {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.quick-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.quick-field-label {
  color: var(--text-dim);
  font-size: 11.5px;
}
.quick-field .set-number {
  width: 100%;
  min-width: 0;
  font-weight: 400;
}
.quick-textarea {
  height: auto;
  min-height: 60px;
  padding: 6px 8px;
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.45;
  resize: vertical;
}
.quick-edit-foot,
.quick-add-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}
.quick-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  font-size: 12.5px;
  cursor: pointer;
}
.quick-add {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.quick-empty + .quick-add {
  padding-top: 0;
  border-top: 0;
}
.quick-add-title {
  margin: 0;
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 600;
}
.quick-add-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
  gap: 8px;
}
.quick-add-fields .set-number {
  min-width: 0;
  width: 100%;
}
.quick-add-btn {
  flex: 0 0 auto;
  white-space: nowrap;
}
.quick-add .set-warn {
  margin: 0;
}
@container (max-width: 460px) {
  .quick-add-fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
