<script setup>
// Live Share: the invitations of this share, one per person or group (main's
// access model; LiveShareDialog's context runs the calls). Each one shows its
// code (copy it, or a message with it), when it stops letting new people in,
// how often it was used, what it offers, and whether it is blocked or used
// up; it can be changed, duplicated, given a new code (same label, projects
// and rights; the old code stops working) or revoked (offering to remove the
// people who joined with it). New invitation opens the same form.
import { ref, computed, nextTick, inject, watch } from 'vue'
import { Copy, Check, Pencil, CopyPlus, RefreshCw, Trash2, Plus, MessageSquareText } from 'lucide-vue-next'
import LsInviteEditor from './LsInviteEditor.vue'
import { invitesOf, inviteName, inviteExpiry, inviteUses, inviteBlockedText } from '../../liveShareAccess'
import { rightsShort } from '../../liveShareRights'
import { t } from '../../i18n'

const MAX_INVITES = 20

const ctx = inject('lsDialog')
const invites = computed(() => invitesOf(ctx.host.value))
const full = computed(() => invites.value.length >= MAX_INVITES)
// 'new', or the id of the invitation being changed.
const editing = ref(null)
const revoking = ref(null)
const removePeople = ref(false)
const copied = ref('')
let copiedTimer = 0
const root = ref(null)

// An invitation gone while it was being changed or revoked (it expired, or
// was revoked elsewhere): its form closes.
watch(invites, (list) => {
  if (editing.value && editing.value !== 'new' && !list.some((x) => x.id === editing.value)) editing.value = null
  if (revoking.value && !list.some((x) => x.id === revoking.value)) revoking.value = null
})

const focusIn = (selector) => nextTick(() => root.value?.querySelector(selector)?.focus())

function startNew() {
  if (full.value) return ctx.error(t('liveShare.error.full', 'You can have up to {{max}} invitations at once. Revoke one first.', { max: MAX_INVITES }))
  revoking.value = null
  editing.value = 'new'
}
function startEdit(inv) {
  revoking.value = null
  editing.value = inv.id
}
function cancelEdit() {
  const id = editing.value
  editing.value = null
  focusIn(id && id !== 'new' ? `[data-test="ls-invite-edit-${id}"]` : '[data-test="ls-invite-new"]') // i18n-ignore
}

async function create({ spec }) {
  const r = await ctx.run('invite:new', () => ctx.api.createInvite(spec))
  if (!r || !r.ok) return
  editing.value = null
  ctx.notice(t('liveShare.invite.created', 'Invitation ready: copy its code and send it.'))
  if (r.invite) focusIn(`[data-test="ls-invite-copy-${r.invite.id}"]`) // i18n-ignore
}
async function save(inv, { spec, applyRemovals, applyAdditions }) {
  const r = await ctx.run(`invite:${inv.id}`, () => ctx.api.updateInvite({ id: inv.id, patch: spec, applyRemovals, applyAdditions })) // i18n-ignore
  if (!r || !r.ok) return
  editing.value = null
  const n = Number.isInteger(r.applied) ? r.applied : 0
  ctx.notice(
    n === 0
      ? t('liveShare.invite.saved', 'Saved.')
      : n === 1
        ? t('liveShare.invite.savedApplied', 'Saved, and changed for {{count}} person.', { count: n })
        : t('liveShare.invite.savedApplied', 'Saved, and changed for {{count}} people.', { count: n })
  )
  focusIn(`[data-test="ls-invite-edit-${inv.id}"]`) // i18n-ignore
}
async function duplicate(inv) {
  if (full.value) return ctx.error(t('liveShare.error.full', 'You can have up to {{max}} invitations at once. Revoke one first.', { max: MAX_INVITES }))
  const r = await ctx.run(`invite:${inv.id}:dup`, () => ctx.api.duplicateInvite({ id: inv.id })) // i18n-ignore
  if (!r || !r.ok || !r.invite) return
  ctx.notice(t('liveShare.invite.duplicated', 'Copy made, with a code of its own: give it a label.'))
  editing.value = r.invite.id
}
async function rotate(inv) {
  const r = await ctx.run(`invite:${inv.id}:rotate`, () => ctx.api.rotateInvite({ id: inv.id })) // i18n-ignore
  if (!r || !r.ok) return
  ctx.notice(t('liveShare.invite.rotated', '“{{label}}” has a new code: send it again. The old code no longer lets anyone in.', { label: inviteName(inv) }))
  focusIn(`[data-test="ls-invite-copy-${inv.id}"]`) // i18n-ignore
}
function askRevoke(inv) {
  editing.value = null
  removePeople.value = false
  revoking.value = inv.id
  focusIn(`[data-test="ls-invite-revoke-cancel-${inv.id}"]`) // i18n-ignore
}
function cancelRevoke(inv) {
  revoking.value = null
  focusIn(`[data-test="ls-invite-revoke-${inv.id}"]`) // i18n-ignore
}
async function revoke(inv) {
  const remove = !!removePeople.value && inv.joined > 0
  const r = await ctx.run(`invite:${inv.id}:revoke`, () => ctx.api.revokeInvite({ id: inv.id, removePeople: remove })) // i18n-ignore
  revoking.value = null
  if (!r || !r.ok) return
  const n = Number.isInteger(r.removed) ? r.removed : 0
  ctx.notice(
    n === 0
      ? t('liveShare.invite.revoked', '“{{label}}” is revoked: its code no longer lets anyone in.', { label: inviteName(inv) })
      : n === 1
        ? t('liveShare.invite.revokedRemoved', '“{{label}}” is revoked, and {{count}} person who joined with it was removed.', { label: inviteName(inv), count: n })
        : t('liveShare.invite.revokedRemoved', '“{{label}}” is revoked, and {{count}} people who joined with it were removed.', { label: inviteName(inv), count: n })
  )
  focusIn('[data-test="ls-invite-new"]')
}

async function copy(inv, message) {
  if (!inv.code) return
  const text = message ? t('liveShare.invite.message', 'Join my Tessel Live Share: in Tessel, open Live Share, then Join, and paste this code: {{code}}', { code: inv.code }) : inv.code
  if (!(await ctx.copy(text))) return
  copied.value = `${inv.id}:${message ? 'message' : 'code'}` // i18n-ignore
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = ''), 1500)
}
const isCopied = (inv, message) => copied.value === `${inv.id}:${message ? 'message' : 'code'}` // i18n-ignore

const projectsText = (inv) => {
  const names = (inv.projects || []).map(ctx.projectName).filter(Boolean)
  const list = names.length ? names.join(', ') : t('liveShare.invite.noProject', 'no project')
  return inv.later ? t('liveShare.invite.projectsLater', '{{list}}, and projects shared later', { list }) : list
}
const joinedText = (inv) =>
  inv.joined === 1 ? t('liveShare.invite.joined', '{{count}} person in with it', { count: 1 }) : t('liveShare.invite.joined', '{{count}} people in with it', { count: inv.joined || 0 })
const revokeLabel = (inv) =>
  inv.joined === 1
    ? t('liveShare.invite.revokeRemove', 'Also remove the {{count}} person who joined with it', { count: 1 })
    : t('liveShare.invite.revokeRemove', 'Also remove the {{count}} people who joined with it', { count: inv.joined })
</script>

<template>
  <section ref="root" class="lsd-section" data-test="ls-invitations" :aria-label="t('liveShare.section.invites', 'Invitations')">
    <div class="lsd-section-head">
      <p class="lsd-intro">
        {{ t('liveShare.invite.intro', 'One invitation per person or group: each has its own code, projects and rights. Everyone still waits for your yes.') }}
        {{ t('liveShare.invite.endsWithShare', 'Codes stop working when you stop sharing; trusted people get in with any new code.') }}
      </p>
      <button type="button" class="confirm-btn ls-small" :disabled="full || editing === 'new'" :title="full ? t('liveShare.error.full', 'You can have up to {{max}} invitations at once. Revoke one first.', { max: 20 }) : ''" data-test="ls-invite-new" @click="startNew">
        <Plus :size="13" aria-hidden="true" /> {{ t('liveShare.invite.new', 'New invitation') }}
      </button>
    </div>

    <LsInviteEditor v-if="editing === 'new'" :projects="ctx.shared.value" :busy="ctx.busy('invite:new')" :now="ctx.now.value" @submit="create" @cancel="cancelEdit" />

    <p v-if="!invites.length && editing !== 'new'" class="lsd-empty" data-test="ls-invites-empty">{{ t('liveShare.invite.empty', 'No invitation yet. Make one to let someone ask to join.') }}</p>

    <ul v-if="invites.length" class="lsd-list">
      <li v-for="inv in invites" :key="inv.id" class="lsd-item" :data-test="'ls-invite-' + inv.id">
        <LsInviteEditor v-if="editing === inv.id" :invite="inv" :projects="ctx.shared.value" :busy="ctx.busy('invite:' + inv.id)" :now="ctx.now.value" @submit="(e) => save(inv, e)" @cancel="cancelEdit" />
        <template v-else>
          <div class="lsd-item-head">
            <span class="lsd-name">{{ inviteName(inv) }}</span>
            <span v-if="inv.state === 'blocked'" class="lsd-badge danger">{{ t('liveShare.invite.badgeBlocked', 'Blocked') }}</span>
            <span v-else-if="inv.state === 'used'" class="lsd-badge warn">{{ t('liveShare.invite.badgeUsed', 'Used up') }}</span>
          </div>
          <div class="lsd-meta" :class="{ warn: inviteExpiry(inv, ctx.now.value).never }" data-test="ls-invite-expiry">
            <span>{{ inviteExpiry(inv, ctx.now.value).text }}</span>
            <span aria-hidden="true">·</span>
            <span data-test="ls-invite-uses">{{ inviteUses(inv) }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ joinedText(inv) }}</span>
          </div>
          <div class="lsd-meta">
            <span v-text="t('liveShare.invite.offers', 'Offers: {{projects}}. Can: {{rights}}.', { projects: projectsText(inv), rights: rightsShort(inv.rights) })"></span>
          </div>
          <p v-if="inviteBlockedText(inv)" class="lsd-warn-line" role="note" data-test="ls-invite-blocked">{{ inviteBlockedText(inv) }}</p>
          <div class="lsd-code-row">
            <input class="ls-input ls-code" type="text" readonly spellcheck="false" :value="inv.code || t('liveShare.invite.codeNotReady', 'The code is not ready yet')" :aria-label="t('liveShare.invite.codeLabel', 'Code of {{label}}', { label: inviteName(inv) })" :data-test="'ls-invite-code-' + inv.id" @focus="$event.target.select()" />
            <button type="button" class="confirm-btn ls-small primary" :disabled="!inv.code" :data-test="'ls-invite-copy-' + inv.id" @click="copy(inv, false)">
              <Check v-if="isCopied(inv, false)" :size="13" aria-hidden="true" />
              <Copy v-else :size="13" aria-hidden="true" />
              {{ isCopied(inv, false) ? t('liveShare.share.copied', 'Copied') : t('liveShare.invite.copyCode', 'Copy code') }}
            </button>
            <button type="button" class="confirm-btn ls-small" :disabled="!inv.code" :title="t('liveShare.invite.copyMessageTitle', 'The code with a line saying how to join')" :data-test="'ls-invite-copy-message-' + inv.id" @click="copy(inv, true)">
              <Check v-if="isCopied(inv, true)" :size="13" aria-hidden="true" />
              <MessageSquareText v-else :size="13" aria-hidden="true" />
              {{ isCopied(inv, true) ? t('liveShare.share.copied', 'Copied') : t('liveShare.invite.copyMessage', 'Copy message') }}
            </button>
          </div>

          <div v-if="revoking === inv.id" class="lsd-confirm" role="group" :aria-label="t('liveShare.invite.revokeTitle', 'Revoke “{{label}}”?', { label: inviteName(inv) })" :data-test="'ls-invite-revoke-confirm-' + inv.id" @keydown.escape.stop.prevent="cancelRevoke(inv)">
            <p class="lsd-confirm-text" v-text="t('liveShare.invite.revokeText', 'Revoke “{{label}}”? Its code stops letting anyone in.', { label: inviteName(inv) })"></p>
            <label v-if="inv.joined > 0" class="lsd-check" :data-test="'ls-invite-revoke-remove-' + inv.id">
              <input v-model="removePeople" type="checkbox" />
              <span>{{ revokeLabel(inv) }}</span>
            </label>
            <p v-if="inv.joined > 0 && !removePeople" class="lsd-hint">{{ t('liveShare.invite.revokeKeep', 'They stay in, and can come back by themselves.') }}</p>
            <div class="lsd-actions">
              <button type="button" class="confirm-btn ls-small" :data-test="'ls-invite-revoke-cancel-' + inv.id" @click="cancelRevoke(inv)">{{ t('liveShare.cancel', 'Cancel') }}</button>
              <button type="button" class="confirm-btn ls-small primary danger" :disabled="ctx.busy('invite:' + inv.id + ':revoke')" :data-test="'ls-invite-revoke-yes-' + inv.id" @click="revoke(inv)">
                {{ t('liveShare.invite.revoke', 'Revoke') }}
              </button>
            </div>
          </div>
          <div v-else class="lsd-actions start">
            <button type="button" class="confirm-btn ls-small" :data-test="'ls-invite-edit-' + inv.id" @click="startEdit(inv)"><Pencil :size="12" aria-hidden="true" /> {{ t('liveShare.invite.edit', 'Edit') }}</button>
            <button type="button" class="confirm-btn ls-small" :disabled="full || ctx.busy('invite:' + inv.id + ':dup')" :data-test="'ls-invite-duplicate-' + inv.id" @click="duplicate(inv)">
              <CopyPlus :size="12" aria-hidden="true" /> {{ t('liveShare.invite.duplicate', 'Duplicate') }}
            </button>
            <button
              type="button"
              class="confirm-btn ls-small"
              :disabled="ctx.busy('invite:' + inv.id + ':rotate')"
              :title="t('liveShare.invite.rotateTitle', 'A new code with the same label, projects and rights: the old code stops working, people already in stay')"
              :data-test="'ls-invite-rotate-' + inv.id"
              @click="rotate(inv)"
            >
              <RefreshCw :size="12" aria-hidden="true" /> {{ t('liveShare.invite.rotate', 'New code') }}
            </button>
            <button type="button" class="confirm-btn ls-small danger" :data-test="'ls-invite-revoke-' + inv.id" @click="askRevoke(inv)"><Trash2 :size="12" aria-hidden="true" /> {{ t('liveShare.invite.revoke', 'Revoke') }}</button>
          </div>
        </template>
      </li>
    </ul>
  </section>
</template>
