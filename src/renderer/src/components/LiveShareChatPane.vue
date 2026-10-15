<script setup>
// Live Share, as a guest: a host's agent pane that the host has in chat mode
// (no terminal: liveShareWindow.js chatLeaf). Your own view of it: its
// conversation as a chat, read only (from the host: chatSource), or its
// terminal view, which says there is none to show. Switching is on your
// screen only: nothing goes to the host, whose pane stays as it is.
import { computed, inject } from 'vue'
import { t } from '../i18n'
import BrandIcon from './BrandIcon.vue'
import NativeChatTranscriptView from './chat/orca/NativeChatTranscriptView.vue'

const props = defineProps({ node: { type: Object, required: true } })
const ctx = inject('panelCtx')

const ls = computed(() => props.node.liveShare || {})
const host = computed(() => ls.value.host || '?')
const isActive = computed(() => !!ctx.activeId && ctx.activeId.value === props.node.id)
const isMaximized = computed(() => !!ctx.maximizedId && ctx.maximizedId.value === props.node.id)
const chatShown = computed(() => ls.value.view !== 'terminal')
const source = computed(() => (ctx.liveShareChatSource ? ctx.liveShareChatSource(props.node.id) : null))
const title = computed(() => props.node.title || ls.value.agentId || '')
const toggleTitle = computed(() =>
  chatShown.value
    ? t('liveShare.guestView.showTerminal', 'Your view: chat. Show the terminal (only on your screen: {{host}}’s pane does not change)', { host: host.value })
    : t('liveShare.guestView.showChat', 'Your view: terminal. Show the conversation as a chat (only on your screen: {{host}}’s pane does not change)', { host: host.value })
)

const noTerminalText = computed(() => t('liveShare.guestView.noTerminal', '{{host}} has this pane in chat mode: it has no terminal to show. Its conversation shows as a chat.', { host: host.value }))

function activate() {
  if (ctx.setActive) ctx.setActive(props.node.id)
}
function toggle() {
  if (ctx.liveShareView) ctx.liveShareView(props.node.id, chatShown.value ? 'terminal' : 'chat')
}
</script>

<template>
  <div
    class="pane ls-chat-pane"
    :class="{ active: isActive, maximized: isMaximized, highlighted: ctx.highlightId && ctx.highlightId.value === node.id }"
    :data-pane-id="node.id"
    data-pane-kind="liveshare-chat"
    tabindex="-1"
    @mousedown="activate"
  >
    <div class="pane-nav agent" :style="node.accent ? { '--accent': node.accent } : null" data-test="pane-header">
      <div class="pane-nav-left">
        <span class="pane-icon agent" :style="node.accent ? { '--accent': node.accent } : null" :data-agent="ls.agentId || undefined" :aria-label="title">
          <BrandIcon :kind="ls.agentId || 'claude'" :accent="node.accent || null" :size="15" />
        </span>
        <span class="pane-title" data-test="pane-title">{{ title }}</span>
      </div>
      <div class="pane-nav-actions" @mousedown.stop>
        <!-- your own view: its chat or its terminal (on your screen only) -->
        <button
          class="pane-nav-btn"
          :class="{ on: chatShown }"
          data-test="pane-chat-toggle"
          :title="toggleTitle"
          :aria-label="chatShown ? t('liveShare.guestView.showTerminalLabel', 'Your view: show the terminal') : t('liveShare.guestView.showChatLabel', 'Your view: show the chat')"
          :aria-pressed="chatShown"
          @click="toggle"
        >
          <svg v-if="chatShown" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.6" stroke="currentColor" stroke-width="1.4" />
            <path d="M4.5 6.2l2 1.8-2 1.8M8 10h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2.5 3.5h11v7.2H7l-3 2.6v-2.6H2.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          v-if="ctx.toggleMaximize"
          class="pane-nav-btn"
          :title="isMaximized ? t('editor.pane.restore', 'Restore pane') : t('editor.pane.maximize', 'Maximize pane')"
          :aria-label="isMaximized ? t('editor.pane.restore', 'Restore pane') : t('editor.pane.maximize', 'Maximize pane')"
          @click="ctx.toggleMaximize(node.id)"
        >
          <svg v-if="isMaximized" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </div>
    <div v-if="chatShown && source" class="term-transcript" data-test="liveshare-chat-view">
      <NativeChatTranscriptView
        :agent="ls.agentId || 'claude'"
        :session-id="`liveshare-${node.id}`"
        :agent-name="title"
        :node="node"
        :is-visible="true"
        :source="source"
        :read-only-note="t('liveShare.guestView.readOnly', 'Read only: {{host}}’s conversation, on your screen only', { host })"
        :back-label="t('liveShare.guestView.backToTerminal', 'Show the terminal')"
        @close="toggle"
      />
    </div>
    <div v-else class="term-transcript" data-test="liveshare-no-terminal">
      <div class="ls-guest-note" role="note">
        <p>{{ noTerminalText }}</p>
        <button v-if="source" class="exit-btn primary" data-test="liveshare-show-chat" @click="toggle">{{ t('liveShare.guestView.showChatButton', 'Show the chat') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ls-chat-pane {
  outline: none;
}
</style>
