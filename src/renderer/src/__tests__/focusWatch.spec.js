import { describe, it, expect, afterEach } from 'vitest'
import { installFocusWatch, shortStack, describeEl } from '../focusWatch'

let off = null
afterEach(() => {
  if (off) off()
  off = null
  document.body.innerHTML = ''
})

function setup() {
  document.body.innerHTML = `
    <div class="pane" data-pane-id="pane-1"><textarea class="xterm-helper-textarea"></textarea></div>
    <div class="pane" data-pane-id="pane-2"><textarea class="xterm-helper-textarea"></textarea></div>
    <div class="board"><button class="card">Card</button></div>`
  const lines = []
  let t = 1000
  const clock = { now: () => t, add: (ms) => (t += ms) }
  off = installFocusWatch({ log: (s) => lines.push(s), now: clock.now, settleMs: 0 })
  const [a, b] = document.querySelectorAll('.xterm-helper-textarea')
  return { lines, clock, a, b, card: document.querySelector('.card') }
}
const key = (el, k = 'a', mods = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...mods }))
const settle = () => new Promise((r) => setTimeout(r, 5))

describe('focus watch', () => {
  it('logs the keyboard leaving a pane while typing, with the element and code that took it', async () => {
    const { lines, clock, a, card } = setup()
    a.focus()
    key(a)
    clock.add(300)
    card.focus()
    await settle()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('left pane-1 while typing')
    expect(lines[0]).toContain('now in button.card in .board')
    expect(lines[0]).toContain('last focus() on button.card')
  })

  it('says when the pane input was taken off the page (no focusout: the next key tells)', async () => {
    const { lines, clock, a } = setup()
    a.focus()
    key(a)
    a.parentNode.removeChild(a)
    clock.add(200)
    key(document.body)
    await settle()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('a key went elsewhere')
    expect(lines[0]).toContain('its input was taken off the page')
    expect(lines[0]).toContain('now in the page (no element)')
  })

  it('stays quiet after a click, a shortcut, or when the user was not typing', async () => {
    const { lines, clock, a, b, card } = setup()
    a.focus()
    key(a)
    window.dispatchEvent(new Event('pointerdown'))
    b.focus()
    await settle()
    clock.add(1000)
    key(b)
    key(b, 'Tab')
    card.focus()
    await settle()
    clock.add(1000)
    b.focus()
    clock.add(5000)
    a.focus()
    await settle()
    expect(lines).toEqual([])
  })

  it('restores focus() and blur() when removed', () => {
    const before = HTMLElement.prototype.focus
    const stop = installFocusWatch({ log: () => {} })
    expect(HTMLElement.prototype.focus).not.toBe(before)
    stop()
    expect(HTMLElement.prototype.focus).toBe(before)
  })

  it('shortens stacks and describes elements', () => {
    const stack = 'Error\n    at HTMLElement.focus (http://localhost:5173/src/focusWatch.js?t=1:3:1)\n    at termFocus (http://localhost:5173/src/components/TerminalPane.vue?t=12:945:7)\n    at onMounted (http://localhost:5173/src/App.vue:9:1)'
    expect(shortStack(stack)).toBe('termFocus (src/components/TerminalPane.vue:945:7) < onMounted (src/App.vue:9:1)')
    expect(describeEl(null)).toBe('nothing')
  })
})
