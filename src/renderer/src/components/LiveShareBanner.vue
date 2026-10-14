<script setup>
// Live Share, said above the panes so nobody can miss it (App.vue):
// - host: you share a project (LIVE, red): its name, how many guests are in,
//   guests waiting for your answer; from another project, a way back to it;
// - guest: you are in someone's session (blue): whose, and what you may do;
//   from one of your own projects, a way back to it.
// Manage opens the Live Share window (stop, guests, rights); Leave ends a
// guest's session.
import { t } from '../i18n'

defineProps({
  // { mode: 'host', starting, project, here, guests, waiting }
  // | { mode: 'guest', reconnecting, host, here, rights }
  banner: { type: Object, required: true }
})
const emit = defineEmits(['manage', 'goto', 'leave'])
</script>

<template>
  <div class="live-banner" :class="banner.mode" role="status" data-test="live-share-banner">
    <span class="live-dot" aria-hidden="true"></span>
    <template v-if="banner.mode === 'host'">
      <strong class="live-tag">{{ banner.starting ? t('liveShare.banner.starting', 'STARTING') : t('liveShare.banner.live', 'LIVE') }}</strong>
      <span
        class="live-text"
        v-text="
          banner.here
            ? t('liveShare.banner.sharingHere', 'You are sharing this project ({{project}}): guests see what you do here.', { project: banner.project || '?' })
            : t('liveShare.banner.sharingOther', 'You are sharing {{project}} (not this project).', { project: banner.project || '?' })
        "
      ></span>
      <span class="live-meta" v-text="t('liveShare.banner.guests', '{{count}} guest(s) in', { count: banner.guests })"></span>
      <span v-if="banner.waiting" class="live-meta live-waiting" v-text="t('liveShare.banner.waiting', '{{count}} waiting for your answer', { count: banner.waiting })"></span>
      <span class="live-spacer"></span>
      <button v-if="!banner.here && banner.project" type="button" class="live-btn" @click="emit('goto')">{{ t('liveShare.banner.gotoShared', 'Go to the shared project') }}</button>
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
