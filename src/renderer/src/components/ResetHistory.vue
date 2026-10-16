<script setup>
// Stats & Usage > Reset history: the limit resets asked for in Tessel on
// this computer, and the Codex credit records read on click.
import { ref, watch, onBeforeUnmount } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import { t, intlLocale } from '../i18n'
const props = defineProps({
  provider: { type: String, default: undefined },
  accountId: { type: String, default: undefined },
  compact: Boolean,
  revision: { type: Number, default: 0 }
})
const expanded = ref(!props.compact),
  rows = ref([]),
  visible = ref(20),
  busy = ref(false),
  error = ref('')
const remote = ref(null),
  remoteBusy = ref(false),
  remoteError = ref('')
let sequence = 0,
  remoteSequence = 0,
  disposed = false
const outcomes = {
  reset: () => t('usage.history.outcome.reset', 'Limits reset'),
  nothing_to_reset: () => t('usage.history.outcome.nothingToReset', 'Nothing to reset'),
  no_credit: () => t('usage.history.outcome.noCredit', 'No credit'),
  already_redeemed: () => t('usage.history.outcome.alreadyRedeemed', 'Already redeemed'),
  error: () => t('usage.history.outcome.error', 'Failed'),
  pending: () => t('usage.history.resultUnknown', 'Result unknown')
}
// The outcome's tag: done, failed, unsure, or neutral (nothing to reset…).
const outcomeTag = (row) =>
  row.uncertain || row.outcome === 'pending'
    ? 'tag-warn'
    : row.outcome === 'reset'
      ? 'tag-ok'
      : row.outcome === 'error'
        ? 'tag-danger'
        : ''
const providerName = (row) => (row.provider === 'codex' ? 'Codex' : 'Claude') // product names // i18n-ignore
const outcomeText = (row) =>
  row.uncertain
    ? t('usage.history.resultUnknown', 'Result unknown')
    : outcomes[row.outcome]?.() || t('usage.history.unknown', 'Unknown')
const date = (value) =>
  value
    ? new Date(value).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' })
    : t('usage.history.notProvided', 'Not provided')
const count = (value) =>
  value === null || value === undefined
    ? t('usage.history.unknown', 'Unknown')
    : value.toLocaleString(intlLocale())
async function load() {
  const id = ++sequence
  busy.value = true
  error.value = ''
  try {
    const result = await window.shellApi?.providerUsage?.resetHistory({
      ...(props.provider ? { provider: props.provider } : {}),
      ...(props.accountId !== undefined ? { accountId: props.accountId } : {})
    })
    if (disposed || id !== sequence) return
    if (!result?.ok)
      throw new Error(
        result?.error ||
          t('usage.history.unavailable', 'Local reset history is unavailable.')
      )
    rows.value = result.entries || []
  } catch (err) {
    if (!disposed && id === sequence)
      error.value = err.message || t('usage.history.readError', 'Could not read reset history.')
  } finally {
    if (!disposed && id === sequence) busy.value = false
  }
}
async function loadCredits() {
  const id = ++remoteSequence
  remoteBusy.value = true
  remoteError.value = ''
  remote.value = null
  try {
    let accountId = props.accountId
    let label = t('usage.history.selectedAccount', 'Selected Codex account')
    if (accountId === undefined) {
      const state = await window.shellApi.accounts.list()
      if (disposed || id !== remoteSequence) return
      const provider = state?.providers?.find((row) => row.provider === 'codex')
      if (!state?.ok || !provider || provider.error)
        throw new Error(
          t('usage.history.verifyError', 'Could not verify the selected Codex account.')
        )
      accountId = provider.selectedId ?? null
      label =
        (accountId === null ? provider.system : provider.accounts?.find((a) => a.id === accountId))
          ?.label || label
    }
    const result = await window.shellApi.providerUsage.creditHistory({
      provider: 'codex',
      accountId
    })
    if (disposed || id !== remoteSequence) return
    if (!result?.ok)
      throw new Error(
        result?.error || t('usage.history.creditsError', 'Could not read Codex credits.')
      )
    if (result.provider !== 'codex' || result.accountId !== accountId)
      throw new Error(t('usage.history.accountChanged', 'The account changed. Refresh credits.'))
    remote.value = { ...result, label }
  } catch (err) {
    if (!disposed && id === remoteSequence)
      remoteError.value =
        err.message || t('usage.history.creditsError', 'Could not read Codex credits.')
  } finally {
    if (!disposed && id === remoteSequence) remoteBusy.value = false
  }
}
watch(
  () => [props.provider, props.accountId, props.revision, expanded.value],
  () => {
    ++sequence
    ++remoteSequence
    rows.value = []
    remote.value = null
    remoteError.value = ''
    remoteBusy.value = false
    visible.value = 20
    if (expanded.value) load()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  disposed = true
  ++sequence
  ++remoteSequence
})
</script>

<template>
  <section class="reset-history" :class="{ compact }" data-test="reset-history">
    <header class="rh-heading">
      <h4 class="rh-head">
        <button
          type="button"
          class="rh-title"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          <ChevronRight :size="14" class="rh-chevron" :class="{ open: expanded }" aria-hidden="true" />
          {{ t('usage.history.title', 'Reset history') }}
        </button>
      </h4>
      <button v-if="expanded" type="button" class="exit-btn small rh-button" :disabled="busy" @click="load">
        {{ t('usage.history.refresh', 'Refresh') }}
      </button>
    </header>
    <div v-if="expanded">
      <p class="rh-muted">
        {{
          t('usage.history.intro', 'Resets requested in Tessel on this computer. Keeps the latest 500 attempts. Earlier resets are not reconstructed.'
          )
        }}
      </p>
      <p v-if="busy" role="status" class="rh-muted">
        {{ t('usage.history.loading', 'Loading history…') }}
      </p>
      <!-- A failed read: one sentence, the raw message behind Details. -->
      <div v-if="error" class="set-callout warn rh-callout" role="alert">
        <span class="set-callout-text">{{ t('usage.history.readError', 'Could not read reset history.') }}</span>
        <details class="set-more rh-more">
          <summary>{{ t('usage.history.details', 'Details') }}</summary>
          <p>{{ error }}</p>
        </details>
      </div>
      <p v-else-if="!busy && !rows.length" class="rh-muted">
        {{ t('usage.history.empty', 'No resets recorded yet.') }}
      </p>
      <ol v-if="rows.length" class="rh-list">
        <li v-for="row in rows.slice(0, visible)" :key="row.id" class="rh-row">
          <div class="rh-line">
            <span class="rh-what">
              <span class="tag" :class="outcomeTag(row)">{{ outcomeText(row) }}</span>
              <span class="rh-account">{{ providerName(row) }}<template v-if="row.accountLabel"> · {{ row.accountLabel }}</template></span>
            </span>
            <time>{{ date(row.at) }}</time>
          </div>
          <div
            class="rh-muted"
            v-text="
              t('usage.history.credits', 'Credits: {{before}} → {{after}}', {
                before: count(row.creditsBefore),
                after: count(row.creditsAfter)
              })
            "
          ></div>
          <p v-if="row.uncertain" class="rh-muted">
            {{
              t('usage.history.notConfirmed', 'Not confirmed. Check current usage before requesting another reset.'
              )
            }}
          </p>
          <p v-else-if="row.outcome === 'error'" class="rh-muted">
            {{
              row.code === 'history'
                ? t('usage.history.notSaved', 'History could not be saved; no reset was sent.')
                : t('usage.history.requestFailed', 'The request failed before a reset was confirmed.')
            }}
          </p>
          <details v-if="row.windows?.length" class="set-more rh-windows">
            <summary>{{ t('usage.history.windows', 'Windows observed before request') }}</summary>
            <div
              v-for="(win, i) in row.windows"
              :key="i"
              v-text="
                t('usage.history.window', '{{window}} · {{pct}}% used · reset {{date}}', {
                  window: win.label,
                  pct: win.usedPct ?? t('usage.history.unknown', 'Unknown'),
                  date: date(win.resetsAt)
                })
              "
            ></div>
          </details>
        </li>
      </ol>
      <button
        v-if="rows.length > visible"
        type="button"
        class="exit-btn small"
        @click="visible += 20"
        v-text="t('usage.history.showMore', 'Show more ({{count}})', { count: rows.length - visible })"
      ></button>
      <div v-if="!provider || provider === 'codex'" class="rh-provider">
        <button
          type="button"
          class="exit-btn small"
          :disabled="remoteBusy"
          data-test="reset-provider-credits"
          @click="loadCredits"
        >
          {{
            remoteBusy
              ? t('usage.history.readingCredits', 'Reading Codex credits…')
              : t('usage.history.readCredits', 'Read Codex credit records')
          }}
        </button>
        <p class="rh-muted">
          {{
            t('usage.history.creditsIntro', 'Reads the selected account only on click. Provider credit statuses are separate from local reset attempts; grant and expiry dates are not reset dates.'
            )
          }}
        </p>
        <div v-if="remoteError" class="set-callout warn rh-callout" role="alert">
          <span class="set-callout-text">{{ remoteError }}</span>
        </div>
        <template v-if="remote">
          <p class="rh-muted">{{ remote.label }} · {{ date(remote.observedAt) }}</p>
          <p v-if="!remote.available" class="rh-muted">
            {{
              t('usage.history.noIndividual', 'The provider did not return individual credit records.')
            }}
          </p>
          <p v-else-if="!remote.entries.length" class="rh-muted">
            {{ t('usage.history.noRecords', 'No credit records returned by the provider.') }}
          </p>
          <ul v-else class="rh-list rh-credits">
            <li v-for="(credit, i) in remote.entries" :key="i" class="rh-row">
              <span class="tag">{{ credit.status }}</span>
              <div
                class="rh-muted"
                v-text="
                  t('usage.history.grantedExpires', 'Granted {{granted}} · Expires {{expires}}', {
                    granted: date(credit.grantedAt),
                    expires: date(credit.expiresAt)
                  })
                "
              ></div>
            </li>
          </ul>
          <p v-if="remote.truncated" class="rh-muted">
            {{ t('usage.history.truncated', 'Showing the first 500 provider records.') }}
          </p>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* The Stats & Usage page's type: 14 px headings, 13 px rows, 12 px notes,
   in a panel like the page's others. */
.reset-history {
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-2) 40%, transparent);
  color: var(--text);
  font-size: 13px;
}
.reset-history.compact {
  padding: 10px 12px;
}
.rh-heading,
.rh-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.rh-head {
  margin: 0;
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}
.rh-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.rh-title:focus-visible {
  border-radius: 4px;
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.rh-chevron {
  color: var(--text-dim);
  transition: transform 0.12s ease;
}
.rh-chevron.open {
  transform: rotate(90deg);
}
.rh-muted,
time {
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.rh-muted {
  margin: 4px 0;
}
.rh-callout {
  margin: 8px 0;
}
.rh-more {
  flex: 1 1 100%;
}
.rh-more > p {
  margin: 4px 0 0;
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.rh-list {
  list-style: none;
  margin: 8px 0;
  padding: 0;
  border-top: 1px solid var(--border);
}
.rh-row {
  padding: 9px 0;
  border-bottom: 1px solid var(--border);
  overflow-wrap: anywhere;
}
.rh-what {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.rh-account {
  color: var(--text-strong);
}
.rh-windows {
  margin-top: 4px;
}
.rh-windows > div {
  color: var(--text-dim);
  font-size: 12px;
}
.rh-provider {
  margin-top: 12px;
}
.rh-credits {
  max-height: 240px;
  overflow-y: auto;
}
</style>
