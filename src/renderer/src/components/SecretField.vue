<script setup>
// A pasted key or cookie in Settings > AI provider accounts: it goes to the
// main process (encrypted there) and never comes back; the field shows only
// whether one is saved. After Orca's accounts-pane-minimax-credentials.tsx
// (MIT, Copyright (c) 2026 Lovecast Inc.).
import { inject, ref } from 'vue'
import { t } from '../i18n'

const props = defineProps({
  id: { type: String, required: true },
  label: { type: String, required: true },
  placeholder: { type: String, default: '' },
  saved: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  forgetLabel: { type: String, default: '' },
  // async (value) => boolean: true once saved.
  save: { type: Function, required: true },
  forget: { type: Function, required: true }
})
const draft = ref('')
// Forget removes a saved key: asked first (Tessel's own dialog, when there).
const askConfirm = inject('askConfirm', null)

async function submit() {
  const value = draft.value.trim()
  if (!value || props.busy) return
  if (await props.save(value)) draft.value = ''
}
async function clear() {
  if (props.busy) return
  if (askConfirm) {
    const ok = await askConfirm({
      title: t('settings.accounts.forgetTitle', 'Forget the saved value of “{{label}}”?', { label: props.label }),
      text: t('settings.accounts.forgetText', 'Tessel deletes it from this computer. You can paste it again later.'),
      confirmLabel: props.forgetLabel || t('settings.accounts.forget', 'Forget'),
      danger: true
    })
    if (!ok) return
  }
  await props.forget()
  draft.value = ''
}
</script>

<template>
  <div class="usage-field" :data-secret="id">
    <div class="usage-label">
      <label :for="id">{{ label }}</label>
      <span class="usage-saved" :class="{ on: saved }" data-test="secret-state">{{
        saved ? t('settings.accounts.secretSaved', 'Saved') : t('settings.accounts.notSaved', 'Not saved')
      }}</span>
      <slot name="help" />
    </div>
    <div class="usage-row">
      <input
        :id="id"
        v-model="draft"
        class="usage-input"
        type="password"
        autocomplete="off"
        spellcheck="false"
        :disabled="busy"
        :placeholder="placeholder"
        data-test="secret-input"
        @keydown.enter.prevent="submit"
      />
      <button
        type="button"
        class="exit-btn small"
        :disabled="busy || !draft.trim()"
        data-test="secret-save"
        @click="submit"
      >
        {{ saved ? t('settings.accounts.replace', 'Replace') : t('settings.accounts.save', 'Save') }}
      </button>
      <button
        v-if="saved"
        type="button"
        class="exit-btn small danger"
        :disabled="busy"
        data-test="secret-forget"
        @click="clear"
      >
        {{ forgetLabel || t('settings.accounts.forget', 'Forget') }}
      </button>
    </div>
    <slot />
  </div>
</template>

<style scoped src="./usageAccount.css"></style>
