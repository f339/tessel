<script setup>
// Settings > Skills: the Skills window (SkillsDialog.vue) in the page.
import { t } from '../../i18n'
import SkillsDialog from '../SkillsDialog.vue'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

defineProps({
  // Built-in and your own agents, with `available` (found on the PATH).
  agents: { type: Array, default: () => [] },
  // The current workspace's project folder (the Skills and MCP servers pages).
  projectCwd: { type: String, default: null }
})
const { page, searching, shown, go, emit } = useSettingsShell()
</script>

<template>
  <section id="set-skills" class="set-page" data-page="skills" :hidden="!shown('skills')" aria-labelledby="set-skills-title">
    <header class="set-page-head">
      <h2 id="set-skills-title">{{ PAGES.skills.title }}</h2>
      <p class="set-page-desc">{{ PAGES.skills.desc }}</p>
    </header>
    <div class="set-group">
      <div v-if="page === 'skills' && !searching" class="set-card set-card-pad">
        <SkillsDialog embedded :cwd="projectCwd" :agents="agents" @run="emit('run-job', $event)" />
      </div>
      <div v-else class="set-row">
        <div class="set-label">{{ t('settings.skills.installed', 'Installed skills') }}
          <span class="set-hint">{{ t('settings.skills.installedHint', 'Each skill, which agents see it and where it is; add one from GitHub or a folder.') }}</span>
        </div>
        <button type="button" class="exit-btn" @click="go('skills')">{{ t('settings.skills.open', 'Open Skills') }}</button>
      </div>
    </div>
  </section>
</template>
