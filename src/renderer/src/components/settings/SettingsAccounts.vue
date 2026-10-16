<script setup>
// Settings > AI provider accounts: sign-ins, usage keys and where you are
// signed in.
import ProviderAccounts from '../ProviderAccounts.vue'
import ProviderUsageAccounts from '../ProviderUsageAccounts.vue'
import SignedInPlaces from '../SignedInPlaces.vue'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const { shown } = useSettingsShell()
</script>

<template>
  <section
    id="set-accounts"
    class="set-page"
    data-page="accounts"
    :hidden="!shown('accounts')"
    aria-labelledby="set-accounts-title"
  >
    <header class="set-page-head">
      <h2 id="set-accounts-title">{{ PAGES.accounts.title }}</h2>
      <p class="set-page-desc">{{ PAGES.accounts.desc }}</p>
    </header>
    <div class="set-group">
      <div class="set-card set-accounts-card">
        <ProviderAccounts />
        <ProviderUsageAccounts />
        <SignedInPlaces />
      </div>
    </div>
  </section>
</template>
