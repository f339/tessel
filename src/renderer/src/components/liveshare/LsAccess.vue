<script setup>
// Live Share: who has access to what, from main's one access model. The
// grid shows every person (the guests in, the people offline, the trusted
// people not connected) and every invitation against the shared projects,
// with their rights after: each box a live change. One project's view
// ("Who has access to <project>", also from a project's menu) lists who has
// it and who could be given it, with their rights.
//
// An invitation people joined with: a change asks whether it is made for
// them too (yes first for something taken away; for something given, you
// choose), as in the invitation's own form.
import { ref, computed, watch, nextTick, inject } from 'vue'
import { ChevronRight, ShieldCheck } from 'lucide-vue-next'
import RightsChecks from './RightsChecks.vue'
import LsAvatars from './LsAvatars.vue'
import ThemedSelect from '../ui/ThemedSelect.vue'
import { accessPeople, invitesOf, projectAccess, inviteName, inviteExpiry, personName } from '../../liveShareAccess'
import { shownRights, rightWords } from '../../liveShareRights'
import { t } from '../../i18n'

const props = defineProps({
  // A project to show on its own first (a project's "Who has access…").
  focusProject: { type: String, default: null }
})

const ctx = inject('lsDialog')
const host = computed(() => ctx.host.value)
const sharing = computed(() => host.value.state === 'sharing')
const shared = computed(() => ctx.shared.value)
const rights = computed(() => shownRights())
const people = computed(() => accessPeople(host.value))
const invites = computed(() => invitesOf(host.value))
// 'all' (the grid) or a shared project's id.
const view = ref(props.focusProject || 'all')
watch(
  () => props.focusProject,
  (id) => id && (view.value = id)
)
// A project no longer shared: back to the grid.
watch(shared, (list) => {
  if (view.value !== 'all' && !list.some((p) => p.id === view.value)) view.value = 'all'
})
const project = computed(() => (view.value === 'all' ? null : shared.value.find((p) => p.id === view.value) || null))
const access = computed(() => (project.value ? projectAccess(host.value, project.value.id) : null))
const root = ref(null)

const has = (row, projectId) => Array.isArray(row.projects) && row.projects.includes(projectId)
const busyKey = (id, what, key) => `${id}:${what}:${key}` // i18n-ignore

// --- Changes -----------------------------------------------------------------
// An invitation's change waiting for "them too?": { inv, what, key, on }.
const asking = ref(null)
function setProject(subject, projectId, on, inv = null) {
  if (inv && inv.joined > 0) return ask(inv, 'project', projectId, on)
  ctx.run(busyKey(subject, 'project', projectId), () => ctx.api.access({ subject, project: projectId, on }))
}
function setRight(subject, right, on, inv = null) {
  if (inv && inv.joined > 0) return ask(inv, 'right', right, on)
  ctx.run(busyKey(subject, 'right', right), () => ctx.api.access({ subject, right, on }))
}
function ask(inv, what, key, on) {
  asking.value = { inv, what, key, on }
  nextTick(() => root.value?.querySelector('[data-test="ls-access-apply"] button')?.focus())
}
async function answer(themToo) {
  const a = asking.value
  asking.value = null
  if (!a || themToo === null) return
  const inv = invites.value.find((x) => x.id === a.inv.id)
  if (!inv) return ctx.error(t('liveShare.error.missing', 'This invitation no longer exists (it expired or was revoked).'))
  const patch =
    a.what === 'project'
      ? { projects: a.on ? [...new Set([...(inv.projects || []), a.key])] : (inv.projects || []).filter((id) => id !== a.key) }
      : { rights: { ...(inv.rights || {}), [a.key]: !!a.on } }
  const r = await ctx.run(busyKey(inv.id, a.what, a.key), () => ctx.api.updateInvite({ id: inv.id, patch, applyRemovals: !a.on && themToo, applyAdditions: a.on && themToo }))
  if (r && r.ok && themToo && Number.isInteger(r.applied) && r.applied > 0)
    ctx.notice(r.applied === 1 ? t('liveShare.invite.savedApplied', 'Saved, and changed for {{count}} person.', { count: 1 }) : t('liveShare.invite.savedApplied', 'Saved, and changed for {{count}} people.', { count: r.applied }))
}
const askText = computed(() => {
  const a = asking.value
  if (!a) return ''
  const what = a.what === 'project' ? ctx.projectName(a.key) : (rightWords(a.key) || { short: a.key }).short
  const vars = { label: inviteName(a.inv), count: a.inv.joined, what }
  if (a.on) return a.inv.joined === 1 ? t('liveShare.access.askAdd', '{{count}} person joined with “{{label}}”. Give {{what}} to them too?', vars) : t('liveShare.access.askAdd', '{{count}} people joined with “{{label}}”. Give {{what}} to them too?', vars)
  return a.inv.joined === 1 ? t('liveShare.access.askRemove', '{{count}} person joined with “{{label}}”. Take {{what}} away from them too?', vars) : t('liveShare.access.askRemove', '{{count}} people joined with “{{label}}”. Take {{what}} away from them too?', vars)
})

// --- Words -------------------------------------------------------------------
const kindText = (row) => (row.kind === 'trusted' ? t('liveShare.access.trustedOffline', 'Trusted, not connected') : row.kind === 'offline' ? t('liveShare.people.offlineBadge', 'Offline') : '')
const cellLabel = (name, what) => t('liveShare.access.cell', '{{name}}: {{what}}', { name, what })
const projectTitle = computed(() => (project.value ? t('liveShare.access.projectTitle', 'Who has access to {{project}}', { project: project.value.name }) : ''))
const empty = computed(() => !people.value.length && !invites.value.length)
function changeView(event) {
  view.value = event.target.value
}
</script>

<template>
  <section ref="root" class="lsd-section" data-test="ls-access" :aria-label="t('liveShare.section.access', 'Access')">
    <p v-if="!sharing" class="lsd-empty" data-test="ls-access-off">{{ t('liveShare.access.off', 'Start sharing to see who has access to each project. Trusted people are in Trusted.') }}</p>
    <p v-else-if="!shared.length" class="lsd-empty">{{ t('liveShare.access.noProjects', 'Tessel is still finding the projects you share.') }}</p>
    <template v-else>
      <div class="lsd-section-head">
        <label class="lsx-pick">
          <span>{{ t('liveShare.access.show', 'Show') }}</span>
          <ThemedSelect class="ls-input lsx-select" :value="view" data-test="ls-access-view" @change="changeView">
            <option value="all">{{ t('liveShare.access.all', 'All shared projects') }}</option>
            <option v-for="p in shared" :key="p.id" :value="p.id">{{ p.name }}</option>
          </ThemedSelect>
        </label>
      </div>

      <div v-if="asking" class="lsd-confirm" role="group" :aria-label="askText" data-test="ls-access-apply" @keydown.escape.stop.prevent="answer(null)">
        <p class="lsd-confirm-text">{{ askText }}</p>
        <div class="lsd-actions">
          <button type="button" class="confirm-btn ls-small" :class="{ primary: !asking.on }" data-test="ls-access-apply-yes" @click="answer(true)">{{ t('liveShare.access.themToo', 'Them too') }}</button>
          <button type="button" class="confirm-btn ls-small" :class="{ primary: asking.on }" data-test="ls-access-apply-no" @click="answer(false)">{{ t('liveShare.access.onlyInvite', 'Only the invitation') }}</button>
          <button type="button" class="confirm-btn ls-small" data-test="ls-access-apply-cancel" @click="answer(null)">{{ t('liveShare.cancel', 'Cancel') }}</button>
        </div>
      </div>

      <!-- The grid: people and invitations x shared projects, then rights. -->
      <template v-if="!project">
        <p v-if="empty" class="lsd-empty" data-test="ls-access-empty">{{ t('liveShare.access.empty', 'Nobody has access yet: make an invitation, or trust someone.') }}</p>
        <div v-else class="lsx-scroll">
          <table class="lsx-grid" data-test="ls-access-grid">
            <caption class="lsx-caption">{{ t('liveShare.access.caption', 'Who sees each shared project, and what they can do') }}</caption>
            <thead>
              <tr>
                <th scope="col" class="lsx-who">{{ t('liveShare.access.who', 'Person or invitation') }}</th>
                <th v-for="p in shared" :key="p.id" scope="col" class="lsx-col">
                  <button type="button" class="lsx-col-btn" :title="t('liveShare.access.projectTitle', 'Who has access to {{project}}', { project: p.name })" :data-test="'ls-access-col-' + p.id" @click="view = p.id">{{ p.name }}</button>
                </th>
                <th v-for="(r, i) in rights" :key="r.id" scope="col" class="lsx-col lsx-right" :class="{ first: i === 0 }" :title="r.label">{{ r.short }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="people.length" class="lsx-group">
                <th :colspan="1 + shared.length + rights.length" scope="colgroup">{{ t('liveShare.section.people', 'People') }}</th>
              </tr>
              <tr v-for="row in people" :key="row.id" :data-test="'ls-access-row-' + row.id">
                <th scope="row" class="lsx-who">
                  <span class="lsx-who-in">
                    <LsAvatars :people="[{ id: row.id, name: row.name }]" :size="18" />
                    <span class="lsx-name">{{ row.name }}</span>
                    <ShieldCheck v-if="row.trusted" :size="12" class="lsx-trusted" :aria-label="t('liveShare.people.trustedBadge', 'Trusted')" />
                    <span v-if="kindText(row)" class="lsx-kind">{{ kindText(row) }}</span>
                  </span>
                </th>
                <td v-for="p in shared" :key="p.id" class="lsx-cell">
                  <input type="checkbox" :checked="has(row, p.id)" :disabled="ctx.busy(busyKey(row.id, 'project', p.id))" :aria-label="cellLabel(row.name, p.name)" :data-test="'ls-access-' + row.id + '-' + p.id" @change="($event.target.checked = has(row, p.id)), setProject(row.id, p.id, !has(row, p.id))" />
                </td>
                <td v-for="(r, i) in rights" :key="r.id" class="lsx-cell lsx-right" :class="{ first: i === 0 }">
                  <input type="checkbox" :checked="row.rights[r.id] === true" :disabled="ctx.busy(busyKey(row.id, 'right', r.id))" :aria-label="cellLabel(row.name, r.label)" :data-test="'ls-access-' + row.id + '-right-' + r.id" @change="($event.target.checked = row.rights[r.id] === true), setRight(row.id, r.id, row.rights[r.id] !== true)" />
                </td>
              </tr>
              <tr v-if="invites.length" class="lsx-group">
                <th :colspan="1 + shared.length + rights.length" scope="colgroup">{{ t('liveShare.section.invites', 'Invitations') }}</th>
              </tr>
              <tr v-for="inv in invites" :key="inv.id" :data-test="'ls-access-row-' + inv.id">
                <th scope="row" class="lsx-who">
                  <span class="lsx-who-in">
                    <span class="lsx-name">{{ inviteName(inv) }}</span>
                    <span class="lsx-kind">{{ inviteExpiry(inv, ctx.now.value).text }}</span>
                  </span>
                </th>
                <td v-for="p in shared" :key="p.id" class="lsx-cell">
                  <input type="checkbox" :checked="has(inv, p.id)" :disabled="ctx.busy(busyKey(inv.id, 'project', p.id))" :aria-label="cellLabel(inviteName(inv), p.name)" :data-test="'ls-access-' + inv.id + '-' + p.id" @change="($event.target.checked = has(inv, p.id)), setProject(inv.id, p.id, !has(inv, p.id), inv)" />
                </td>
                <td v-for="(r, i) in rights" :key="r.id" class="lsx-cell lsx-right" :class="{ first: i === 0 }">
                  <input type="checkbox" :checked="!!(inv.rights && inv.rights[r.id] === true)" :disabled="ctx.busy(busyKey(inv.id, 'right', r.id))" :aria-label="cellLabel(inviteName(inv), r.label)" :data-test="'ls-access-' + inv.id + '-right-' + r.id" @change="($event.target.checked = !!(inv.rights && inv.rights[r.id] === true)), setRight(inv.id, r.id, !(inv.rights && inv.rights[r.id] === true), inv)" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <!-- One project: who has it, who could be given it. -->
      <div v-else class="lsx-project" data-test="ls-access-project">
        <div class="lsx-project-head">
          <button type="button" class="confirm-btn ls-small" data-test="ls-access-back" @click="view = 'all'">{{ t('liveShare.access.backToAll', 'All projects') }}</button>
          <ChevronRight :size="13" aria-hidden="true" />
          <h3 class="lsx-project-title">{{ projectTitle }}</h3>
        </div>
        <p v-if="!access.people.length && !access.invites.length" class="lsd-empty" data-test="ls-access-project-empty" v-text="t('liveShare.access.projectEmpty', 'Nobody has access to {{project}} yet.', { project: project.name })"></p>
        <template v-for="group in [{ key: 'with', label: t('liveShare.access.haveIt', 'Have access'), people: access.people, invites: access.invites }, { key: 'without', label: t('liveShare.access.canGive', 'Can be given access'), people: access.candidates.people, invites: access.candidates.invites }]" :key="group.key">
          <div v-if="group.people.length || group.invites.length" class="lsx-group-title">{{ group.label }}</div>
          <ul v-if="group.people.length || group.invites.length" class="lsd-list" :data-test="'ls-access-' + group.key">
            <li v-for="row in group.people" :key="row.id" class="lsd-item lsx-line">
              <label class="lsx-has">
                <input type="checkbox" :checked="has(row, project.id)" :disabled="ctx.busy(busyKey(row.id, 'project', project.id))" :data-test="'ls-access-has-' + row.id" @change="($event.target.checked = has(row, project.id)), setProject(row.id, project.id, !has(row, project.id))" />
                <LsAvatars :people="[{ id: row.id, name: row.name }]" :size="18" />
                <span class="lsx-name">{{ personName(row) }}</span>
                <ShieldCheck v-if="row.trusted" :size="12" class="lsx-trusted" :aria-label="t('liveShare.people.trustedBadge', 'Trusted')" />
                <span v-if="kindText(row)" class="lsx-kind">{{ kindText(row) }}</span>
              </label>
              <RightsChecks compact :rights="row.rights" :test-key="'p-' + row.id" :busy="(id) => ctx.busy(busyKey(row.id, 'right', id))" @toggle="(id, on) => setRight(row.id, id, on)" />
            </li>
            <li v-for="inv in group.invites" :key="inv.id" class="lsd-item lsx-line">
              <label class="lsx-has">
                <input type="checkbox" :checked="has(inv, project.id)" :disabled="ctx.busy(busyKey(inv.id, 'project', project.id))" :data-test="'ls-access-has-' + inv.id" @change="($event.target.checked = has(inv, project.id)), setProject(inv.id, project.id, !has(inv, project.id), inv)" />
                <span class="lsx-name">{{ inviteName(inv) }}</span>
                <span class="lsx-kind">{{ t('liveShare.access.invitation', 'Invitation') }} · {{ inviteExpiry(inv, ctx.now.value).text }}</span>
              </label>
              <RightsChecks compact :rights="inv.rights || {}" :test-key="'p-' + inv.id" :busy="(id) => ctx.busy(busyKey(inv.id, 'right', id))" @toggle="(id, on) => setRight(inv.id, id, on, inv)" />
            </li>
          </ul>
        </template>
      </div>
    </template>
  </section>
</template>

<style scoped>
.lsx-pick {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-dim);
  font-size: 12px;
}
.lsx-select {
  width: auto;
  max-width: 260px;
  height: 26px;
  padding: 0 6px;
}
.lsx-scroll {
  max-width: 100%;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 9px;
}
.lsx-grid {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.lsx-caption {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.lsx-grid th,
.lsx-grid td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  text-align: center;
  vertical-align: middle;
}
.lsx-grid tbody tr:last-child th,
.lsx-grid tbody tr:last-child td {
  border-bottom: 0;
}
.lsx-grid thead th {
  color: var(--text-dim);
  font-weight: 500;
  white-space: nowrap;
}
.lsx-who {
  min-width: 140px;
  text-align: left !important;
}
.lsx-who-in {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.lsx-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lsx-kind {
  flex: none;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 400;
  white-space: nowrap;
}
.lsx-trusted {
  flex: none;
  color: var(--accent);
}
.lsx-col-btn {
  max-width: 120px;
  padding: 2px 4px;
  overflow: hidden;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.lsx-col-btn:hover {
  background: var(--surface-3);
  color: var(--text-strong);
}
.lsx-col-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.lsx-right.first {
  border-left: 1px solid var(--border-strong);
}
.lsx-group th {
  padding-top: 8px;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-align: left;
  text-transform: uppercase;
}
.lsx-cell input {
  margin: 0;
  accent-color: var(--accent);
}
.lsx-cell input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.lsx-project-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--text-dim);
}
.lsx-project-title {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 600;
}
.lsx-group-title {
  margin: 12px 0 5px;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.lsx-line {
  gap: 6px;
}
.lsx-has {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  cursor: pointer;
}
.lsx-has input {
  flex: none;
  margin: 0;
  accent-color: var(--accent);
}
</style>
