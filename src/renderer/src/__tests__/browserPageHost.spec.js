// A browser pane's page lives in its workspace's page layer, outside the
// split tree (browser/pageHost.js): a layout change (split, move, a
// neighbour closed, maximize, another workspace shown) never rebuilds the
// <webview>, so Electron never loads the page again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, reactive, ref } from 'vue'
import { RELEASE_MS, _resetPagesForTests, pageOf } from '../browser/pageHost'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss from 'postcss'

vi.mock('../components/DesignModePanel.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'DesignModePanel',
      props: { guestId: { type: Number, default: null }, pageUrl: String, pageTitle: String, paneId: String },
      emits: ['active'],
      setup(_props, { expose }) {
        expose({ toggle() {}, stop() {}, screenshot() {}, isActive: () => false })
        return () => h('div', { class: 'dm-stub' })
      }
    })
  }
})
import BrowserPane from '../components/BrowserPane.vue'

describe('the page layer (browser/pageHost.js)', () => {
  let wrapper, ctx, node, where, hidden, prevApi

  // A workspace layer: the split tree (here: the pane in one place or
  // another, or gone) and the page layer next to it.
  const Harness = defineComponent({
    setup() {
      return () =>
        h('div', { class: ['ws-layer', { hidden: hidden.value }] }, [
          where.value === 'left' ? h('div', { class: 'slot-left' }, [h(BrowserPane, { node })]) : null,
          where.value === 'right' ? h('div', { class: 'slot-right' }, [h('div', { class: 'split' }, [h(BrowserPane, { node })])]) : null,
          h('div', { class: 'browser-host' })
        ])
    }
  })

  const host = () => wrapper.find('.browser-host').element
  const boxes = () => host().querySelectorAll('.bp-box')
  const webviewInHost = () => host().querySelector('webview')

  beforeEach(() => {
    _resetPagesForTests()
    where = ref('left')
    hidden = ref(false)
    node = reactive({ type: 'leaf', kind: 'browser', id: 'b1', num: 1, title: '', url: 'https://example.com/', zoom: 0, focusAddress: 0 })
    ctx = {
      activeId: ref('b1'),
      maximizedId: ref(null),
      highlightId: ref(null),
      setActive: vi.fn(),
      closeLeaf: vi.fn(),
      toggleMaximize: vi.fn(),
      beginPaneDrag: vi.fn(),
      toast: vi.fn(),
      browserPorts: () => []
    }
    prevApi = window.shellApi
    window.shellApi = { browser: {} }
    wrapper = mount(Harness, { attachTo: document.body, global: { provide: { panelCtx: ctx } } })
  })
  afterEach(() => {
    vi.useRealTimers()
    if (wrapper) wrapper.unmount()
    _resetPagesForTests()
    window.shellApi = prevApi
  })

  it('the page is in the page layer, not in the pane; hardened as before', () => {
    const el = webviewInHost()
    expect(el).toBeTruthy()
    expect(wrapper.find('.browser-pane').element.contains(el)).toBe(false)
    expect(el.getAttribute('partition')).toBe('persist:tessel-browser')
    expect(el.getAttribute('webpreferences')).toBe('contextIsolation=yes,sandbox=yes,nodeIntegration=no')
    expect(el.getAttribute('src')).toBe('https://example.com/')
    expect(el.style.flex).toBe('1 1 auto')
    expect(el.style.minHeight).toBe('0px')
    // The overlays over the page are in its box, above it.
    expect(host().querySelector('.bp-box-overlay .dm-stub')).toBeTruthy()
    expect(wrapper.find('.browser-pane').classes()).toContain('hosted')
  })

  it('a layout change keeps the very same page element: never loaded again', async () => {
    const el = webviewInHost()
    el.getURL = () => 'https://example.com/deeper'
    el.getTitle = () => 'Deeper page'
    el.isLoading = () => true
    el.canGoBack = () => true
    el.canGoForward = () => false
    el.getWebContentsId = () => 42
    el.setZoomLevel = vi.fn()
    el.dispatchEvent(new Event('dom-ready'))

    where.value = 'right'
    await nextTick()
    await nextTick()
    expect(wrapper.find('.slot-right .browser-pane').exists()).toBe(true)
    expect(boxes()).toHaveLength(1)
    expect(webviewInHost()).toBe(el)
    // The pane built again shows the live page: where it is, its title, history.
    expect(wrapper.find('[data-test="browser-title"]').text()).toBe('Deeper page')
    expect(wrapper.find('.bp-address-input').element.value).toBe('https://example.com/deeper')
    expect(wrapper.find('[data-test="browser-back"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-test="browser-reload"]').attributes('aria-label')).toBe('Stop')
    // Its events reach the new pane only (the old one let go of them).
    const ev = new Event('page-title-updated')
    ev.title = 'Renamed'
    el.dispatchEvent(ev)
    await nextTick()
    expect(node.title).toBe('Renamed')
    // Moved back: still the same.
    where.value = 'left'
    await nextTick()
    expect(webviewInHost()).toBe(el)
  })

  it('laid over the pane’s page area, hidden under another maximized pane', async () => {
    const rect = (left, top, width, height) => () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top })
    host().getBoundingClientRect = rect(100, 50, 1000, 800)
    wrapper.find('.bp-page').element.getBoundingClientRect = rect(400, 118, 500, 600)
    ctx.maximizedId.value = 'other'
    await nextTick()
    await nextTick()
    const box = boxes()[0]
    expect(box.style.left).toBe('300px')
    expect(box.style.top).toBe('68px')
    expect(box.style.width).toBe('500px')
    expect(box.style.height).toBe('600px')
    expect(box.style.visibility).toBe('hidden')
    ctx.maximizedId.value = 'b1'
    await nextTick()
    await nextTick()
    // Shown (never 'visible': a hidden workspace layer hides it).
    expect(box.style.visibility).toBe('')
    expect(wrapper.find('.browser-pane').classes()).toContain('maximized')
  })

  // A maximized pane is its own stacking layer (z-index 100) over the page
  // layer (1): its see-through page area lay over the page and took the
  // wheel, the clicks and the keyboard (a maximized page did not scroll).
  // The maximized browser pane whose page is hosted stays at the panes' level.
  it('maximized: its page area does not lie over its page (style.css)', async () => {
    ctx.maximizedId.value = 'b1'
    await nextTick()
    const el = wrapper.find('.browser-pane').element
    const rules = []
    postcss.parse(readFileSync(join(__dirname, '..', 'style.css'), 'utf8')).walkRules((rule) => {
      if (rule.parent && rule.parent.type !== 'root') return
      const z = rule.nodes.find((d) => d.type === 'decl' && d.prop === 'z-index')
      if (z && rule.selectors.some((sel) => /^\.pane\.maximized/.test(sel) && el.matches(sel))) rules.push(z.value)
    })
    // The last rule that matches it wins (the more precise one, also last).
    expect(rules.length).toBeGreaterThan(1)
    expect(rules[rules.length - 1]).toBe('auto')
    // Its page is in the page layer (the case the rule is for).
    expect(el.classList.contains('hosted')).toBe(true)
  })

  // A browser pane is a tab of its own above the grid (App.vue, paneViews.js):
  // its page is not inside the pane, so it is hidden by hand while another
  // tab shows; a pane maximized in the grid never covers it.
  it('a tab above the panes: its header holds the tabs, its page hides while another tab shows', async () => {
    const rect = (left, top, width, height) => () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top })
    wrapper.unmount()
    _resetPagesForTests()
    const shown = ref('terminal')
    ctx.paneTabs = (id) => (id === 'b1' ? { leaves: [node], shown: shown.value } : null)
    ctx.selectViewTab = vi.fn()
    ctx.maximizedId.value = 'a-grid-pane'
    wrapper = mount(Harness, { attachTo: document.body, global: { provide: { panelCtx: ctx } } })
    await nextTick()
    host().getBoundingClientRect = rect(100, 50, 1000, 800)
    wrapper.find('.bp-page').element.getBoundingClientRect = rect(100, 110, 1000, 740)
    const box = boxes()[0]
    expect(box.style.visibility).toBe('hidden')
    expect(wrapper.find('.pane-nav').classes()).toContain('with-view-tabs')
    expect(wrapper.findAll('[data-test="view-tab"]').map((w) => w.attributes('data-tab'))).toEqual(['terminal', 'b1'])
    // Its own tab fills the room: no maximize button.
    expect(wrapper.find('.pane-nav-actions').findAll('.pane-nav-btn')).toHaveLength(1)
    shown.value = 'b1'
    await nextTick()
    await nextTick()
    expect(box.style.visibility).toBe('')
    shown.value = 'terminal'
    await nextTick()
    await nextTick()
    expect(box.style.visibility).toBe('hidden')
    await wrapper.find('[data-tab="terminal"]').trigger('click')
    expect(ctx.selectViewTab).toHaveBeenCalledWith('b1', 'terminal', null)
  })

  it('another workspace shown: the page stays as it is, hidden with its layer', async () => {
    const el = webviewInHost()
    hidden.value = true
    await nextTick()
    expect(wrapper.find('.ws-layer').classes()).toContain('hidden')
    expect(webviewInHost()).toBe(el)
    expect(host().contains(el)).toBe(true)
  })

  it('a pane closed: its page is hidden at once and gone a moment later', async () => {
    vi.useFakeTimers()
    const el = webviewInHost()
    where.value = null
    await nextTick()
    expect(boxes()).toHaveLength(1)
    expect(boxes()[0].style.visibility).toBe('hidden')
    vi.advanceTimersByTime(RELEASE_MS + 10)
    expect(boxes()).toHaveLength(0)
    expect(pageOf('b1')).toBe(null)
    // Opened again later: a new page.
    where.value = 'left'
    await nextTick()
    expect(webviewInHost()).toBeTruthy()
    expect(webviewInHost()).not.toBe(el)
  })

  it('a click on an overlay of the page activates its pane', async () => {
    ctx.activeId.value = 'other'
    await nextTick()
    boxes()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(ctx.setActive).toHaveBeenCalledWith('b1')
  })
})
