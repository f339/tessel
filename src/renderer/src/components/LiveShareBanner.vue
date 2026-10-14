<script setup>
// Live Share, said above the panes so nobody can miss it (App.vue):
// - host: you share projects (LIVE, red): each one by name (a click goes to
//   it, × takes it out of the share while another stays), whether the one on
//   screen is shared (if not, + Share this project adds it), how many guests
//   are in, guests waiting for your answer;
// - guest: you are in someone's session (blue): whose, and what you may do;
//   from one of your own projects, a way back to it.
// Manage opens the Live Share window (stop, guests, rights); Leave ends a
// guest's session.
import { computed } from 'vue'
import { X, Plus } from 'lucide-vue-next'
import { t } from '../i18n'

const props = defineProps({
  // { mode: 'host', starting, projects: [{ id, name, here }], here, canAdd,
  //   guests, waiting }
  // | { mode: 'guest', reconnecting, host, here, rights }
  banner: { type: Object, required: true }
})
// goto(id) (host: that shared project; guest: the session), remove(id), add
// (the project on screen), manage, leave.
const emit = defineEmits(['manage', 'goto', 'leave', 'remove', 'add'])

const projects = computed(() => (Array.isArray(props.banner.projects) ? props.banner.projects : []))
// The last project shared stays (Stop sharing, in Manage, ends the share).
const canRemove = computed(() => !props.banner.starting && projects.value.length > 1)
</script>

<template>
  <div class="live-banner" :class="banner.mode" role="status" data-test="live-share-banner">
    <span class="live-dot" aria-hidden="true"></span>
    <template v-if="banner.mode === 'host'">
      <strong class="live-tag">{{ banner.starting ? t('liveShare.banner.starting', 'STARTING') : t('liveShare.banner.live', 'LIVE') }}</strong>
      <span
        class="live-text live-lead"
        v-text="banner.here ? t('liveShare.banner.sharingHere2', 'Guests see this project live. You share:') : t('liveShare.banner.sharingOther2', 'This project is not shared. You share:')"
      ></span>
      <span class="live-projects" role="list" :aria-label="t('liveShare.banner.projectsLabel', 'Projects you share')" data-test="live-share-projects">
        <span v-for="p in projects" :key="p.id" class="live-project" :class="{ here: p.here }" role="listitem" :data-test="'live-project-' + p.id">
          <button
            type="button"
            class="live-project-name"
            :title="p.here ? t('liveShare.banner.projectHere', 'On screen now') : t('liveShare.banner.gotoProject', 'Go to {{project}}', { project: p.name })"
            @click="emit('goto', p.id)"
            v-text="p.name"
          ></button>
          <button
            v-if="canRemove"
            type="button"
            class="live-project-remove"
            :title="t('liveShare.banner.removeProject', 'Stop sharing {{project}}: guests no longer see it', { project: p.name })"
            :aria-label="t('liveShare.banner.removeProject', 'Stop sharing {{project}}: guests no longer see it', { project: p.name })"
            :data-test="'live-remove-' + p.id"
            @click="emit('remove', p.id)"
          >
            <X :size="11" aria-hidden="true" />
          </button>
        </span>
      </span>
      <span class="live-meta" v-text="t('liveShare.banner.guests', '{{count}} guest(s) in', { count: banner.guests })"></span>
      <span v-if="banner.waiting" class="live-meta live-waiting" v-text="t('liveShare.banner.waiting', '{{count}} waiting for your answer', { count: banner.waiting })"></span>
      <span class="live-spacer"></span>
      <button
        v-if="banner.canAdd"
        type="button"
        class="live-btn live-add"
        :title="t('liveShare.banner.addTitle', 'Guests already in see it once you turn it on for them (Manage…)')"
        data-test="live-share-add"
        @click="emit('add')"
      >
        <Plus :size="12" aria-hidden="true" /> {{ t('liveShare.banner.add', 'Share this project') }}
      </button>
      <button type="button" class="live-btn" data-test="live-share-manage" @click="emit('manage')">{{ t('liveShare.banner.manage', 'Manage…') }}</button>
    </template>
    <template v-else>
      <strong class="live-tag">{{ t('liveShare.banner.guestTag', 'LIVE SHARE') }}</strong>
      <span
        class="live-text"
        v-text="
          banner.reconnecting
            ? t('liveShare.banner.reconnecting', 'Reconnecting to {{host}}’s session…', { host: banner.host })
            : banner.here
              ? t('liveShare.banner.guestHere', 'You are in {{host}}’s session: these panes run on {{host}}’s computer.', { host: banner.host })
              : t('liveShare.banner.guestOther', 'You are in {{host}}’s session (this project is yours).', { host: banner.host })
        "
      ></span>
      <span v-if="banner.rights" class="live-meta" v-text="banner.rights"></span>
      <span class="live-spacer"></span>
      <button v-if="!banner.here" type="button" class="live-btn" @click="emit('goto')">{{ t('liveShare.banner.gotoSession', 'Go to the session') }}</button>
      <button type="button" class="live-btn" @click="emit('manage')">{{ t('liveShare.banner.manage', 'Manage…') }}</button>
      <button type="button" class="live-btn danger" data-test="live-share-leave" @click="emit('leave')">{{ t('liveShare.banner.leave', 'Leave') }}</button>
    </template>
  </div>
</template>

<style scoped>
.live-banner {
  --live: var(--danger);
  position: absolute;
  inset: 0 0 auto 0;
  height: 30px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  background: color-mix(in srgb, var(--live) 22%, var(--chrome));
  border-bottom: 1px solid color-mix(in srgb, var(--live) 55%, transparent);
  color: var(--text-strong);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
}
.live-banner.guest {
  --live: var(--accent);
}
.live-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--live);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--live) 70%, transparent);
  animation: live-pulse 1.6s ease-out infinite;
}
@keyframes live-pulse {
  70% {
    box-shadow: 0 0 0 7px transparent;
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}
.live-tag {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--live);
  color: #fff;
  font-size: 11px;
  letter-spacing: 0.04em;
}
.live-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
.live-lead {
  flex: none;
}
.live-projects {
  display: flex;
  flex: 0 1 auto;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}
.live-project {
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  min-width: 0;
  height: 20px;
  border: 1px solid color-mix(in srgb, var(--live) 55%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--live) 14%, transparent);
}
.live-project.here {
  background: color-mix(in srgb, var(--live) 40%, transparent);
}
.live-project-name {
  min-width: 0;
  max-width: 180px;
  padding: 0 8px;
  overflow: hidden;
  border: 0;
  background: transparent;
  color: var(--text-strong);
  font: inherit;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.live-project.here .live-project-name {
  font-weight: 600;
}
.live-project-remove {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-right: 2px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-strong);
  cursor: pointer;
}
.live-project-remove:hover {
  background: color-mix(in srgb, var(--live) 45%, transparent);
}
.live-project-name:focus-visible,
.live-project-remove:focus-visible {
  outline: 2px solid var(--text-strong);
  outline-offset: -2px;
}
.live-add {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.live-meta {
  flex: none;
  color: color-mix(in srgb, var(--text-strong) 75%, transparent);
}
.live-waiting {
  color: var(--warn);
  font-weight: 600;
}
.live-spacer {
  flex: 1 1 auto;
}
.live-btn {
  flex: none;
  height: 22px;
  padding: 0 9px;
  border: 1px solid color-mix(in srgb, var(--live) 60%, transparent);
  border-radius: 5px;
  background: transparent;
  color: var(--text-strong);
  font-size: 12px;
  cursor: pointer;
}
.live-btn:hover {
  background: color-mix(in srgb, var(--live) 25%, transparent);
}
.live-btn.danger {
  border-color: color-mix(in srgb, var(--danger) 70%, transparent);
}
</style>
