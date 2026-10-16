<script setup>
// Settings > SSH Hosts (Remote Hosts): RemoteHostsSettings.vue.
import RemoteHostsSettings from '../remote/RemoteHostsSettings.vue'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const { shown } = useSettingsShell()
</script>

<template>
  <section id="set-ssh" class="set-page" data-page="ssh" :hidden="!shown('ssh')" aria-labelledby="set-ssh-title">
    <header class="set-page-head">
      <h2 id="set-ssh-title">{{ PAGES.ssh.title }}</h2>
      <p class="set-page-desc">{{ PAGES.ssh.desc }}</p>
    </header>
    <div class="set-group">
      <RemoteHostsSettings />
    </div>
  </section>
</template>
