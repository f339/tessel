// The read-only conversation view fed from elsewhere (a Live Share host's
// pane, liveShareWindow.js chatSource): read through the source only, let go
// even when its first read failed, and the files it names are another
// computer's (no "Show in Folder", no opening here).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import NativeChatTranscriptView from '../NativeChatTranscriptView.vue'
import { installNativeChatMessageListTestViewport } from '../../../../chat/orca/native-chat-message-list-test-viewport.js'

let restoreViewport = () => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())

const conversation = [
  { type: 'user', id: 'hist-u1', text: 'Where is the picture?', origin: 'user', status: 'accepted', imported: true, at: 1000 },
  { type: 'assistant', messageId: 'hist-a1', text: 'Here:\n\n```\nC:/Users/ada/Downloads/livery.png\n```', imported: true, at: 2000 },
  { type: 'turnEnd', status: 'completed', imported: true, at: 3000 }
]

let wrapper, prevApi, local
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  prevApi = window.shellApi
  local = { open: vi.fn(), close: vi.fn(), onEvent: vi.fn(() => () => {}) }
  window.shellApi = { transcriptView: local, chatFiles: { reveal: vi.fn(), stat: vi.fn(async () => ({})) }, openFile: vi.fn(), writeClipboard: vi.fn() }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  window.shellApi = prevApi
  vi.useRealTimers()
  document.body.replaceChildren()
})

const sourceOf = (open) => ({ open: vi.fn(open), close: vi.fn(), onEvent: vi.fn(() => () => {}) })
async function mountView(source) {
  wrapper = mount(NativeChatTranscriptView, {
    props: { agent: 'claude', sessionId: 'liveshare-pane-ls1-a', agentName: 'Babbage', source, readOnlyNote: 'Read only: Ada’s conversation' },
    attachTo: document.body,
    global: { stubs: { transition: false } }
  })
  await flushPromises()
}

describe('NativeChatTranscriptView fed from a Live Share host', () => {
  it('reads through its source only, read only', async () => {
    const source = sourceOf(async () => ({ ok: true, viewId: 'pane-ls1-a', events: conversation, truncated: false }))
    await mountView(source)
    expect(source.open).toHaveBeenCalledTimes(1)
    expect(local.open).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Where is the picture?')
    expect(document.body.textContent).toContain('Read only: Ada’s conversation')
    expect(document.querySelector('[data-test="chat-composer"]')).toBeNull()
  })

  it('the files it names are another computer’s: no Show in Folder', async () => {
    const source = sourceOf(async () => ({ ok: true, viewId: 'pane-ls1-a', events: conversation, truncated: false }))
    await mountView(source)
    expect(document.body.textContent).toContain('livery.png')
    expect(document.querySelector('[data-test="code-reveal"]')).toBeNull()
    expect(window.shellApi.chatFiles.stat).not.toHaveBeenCalled()
  })

  it('let go when it goes away, even when its first read failed', async () => {
    const source = sourceOf(async () => ({ ok: false, code: 'missing' }))
    await mountView(source)
    expect(source.open).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    wrapper = null
    expect(source.close).toHaveBeenCalled()
  })

  it('let go when it is hidden, also before anything came', async () => {
    const source = sourceOf(async () => ({ ok: false, code: 'missing' }))
    await mountView(source)
    await wrapper.setProps({ isVisible: false })
    expect(source.close).toHaveBeenCalledTimes(1)
  })
})
