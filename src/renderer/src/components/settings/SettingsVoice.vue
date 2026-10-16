<script setup>
// Settings > Voice typing: Windows dictation in the panes.
import { ref, onMounted } from 'vue'
import ThemedSelect from '../ui/ThemedSelect.vue'
import { t } from '../../i18n'
import { settings } from '../../settings'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const { shown } = useSettingsShell()

// The input languages Windows has, for the dictation language.
const languages = ref([])
onMounted(async () => {
  if (window.shellApi.inputLanguages) {
    try {
      languages.value = (await window.shellApi.inputLanguages()) || []
    } catch {
      languages.value = []
    }
  }
})
</script>

<template>
  <section
    id="set-voice"
    class="set-page"
    data-page="voice"
    :hidden="!shown('voice')"
    aria-labelledby="set-voice-title"
  >
    <header class="set-page-head">
      <h2 id="set-voice-title">{{ PAGES.voice.title }}</h2>
      <p class="set-page-desc">{{ PAGES.voice.desc }}</p>
    </header>
    <div class="set-group">
      <div class="set-card">
        <div class="set-row">
          <label class="set-label" for="settings-language">
            {{ t('settings.voice.language', 'Language') }}
            <span class="set-hint">{{ t('settings.voice.languageHint', 'Windows dictation listens in one language. The mic button switches to this one first. Add languages in Windows Settings, Time & language.') }}</span>
          </label>
          <ThemedSelect
            id="settings-language"
            v-model="settings.voiceTip"
            class="set-select"
            @change="settings.voiceTipChosen = true"
          >
            <option value="">{{ t('settings.voice.currentKeyboard', 'Current keyboard language') }}</option>
            <option v-for="l in languages.filter((x) => x.tip)" :key="l.tip" :value="l.tip">
              {{ l.name }}
            </option>
          </ThemedSelect>
        </div>
      </div>
    </div>
  </section>
</template>
