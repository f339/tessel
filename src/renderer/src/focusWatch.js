// Diagnostics: the keyboard leaves a pane while the user types in it, with no
// click or shortcut of theirs. Each time, one "focus:" line in tessel.log says
// where it went: another element (with the code that focused it), the pane's
// input taken off the page (the pane was drawn again), or another window.

const INPUT_SEL = '.xterm-helper-textarea, [contenteditable="true"], textarea, input' // i18n-ignore

function paneIdOf(el) {
  const pane = el && el.closest ? el.closest('.pane') : null
  return pane ? pane.getAttribute('data-pane-id') || '?' : null
}

export function describeEl(el) {
  if (!el) return 'nothing' // i18n-ignore
  if (el.tagName === 'BODY') return 'the page (no element)' // i18n-ignore
  let s = String(el.tagName || '').toLowerCase()
  if (el.id) s += `#${el.id}`
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : []
  if (cls.length) s += `.${cls.join('.')}`
  const test = el.getAttribute && el.getAttribute('data-test')
  if (test) s += `[${test}]`
  const pane = paneIdOf(el)
  if (pane) s += ` in ${pane}` // i18n-ignore
  else {
    const box = el.parentElement && el.parentElement.closest('[class]')
    const where = box && typeof box.className === 'string' ? box.className.trim().split(/\s+/)[0] : ''
    if (where) s += ` in .${where}` // i18n-ignore
  }
  return s
}

// The frames that called focus() or blur(), without this file's own and the
// dev server's address.
export function shortStack(stack, max = 5) {
  return String(stack || '')
    .split('\n')
    .slice(1)
    .map((l) => l.trim().replace(/^at\s+/, ''))
    .filter((l) => l && !/focusWatch/.test(l))
    .slice(0, max)
    .map((l) => l.replace(/\(?https?:\/\/[^/]+\//, '(').replace(/\?[^:)]*/, ''))
    .join(' < ')
}

export function installFocusWatch({ win = typeof window !== 'undefined' ? window : null, doc = typeof document !== 'undefined' ? document : null, log, now = () => Date.now(), typingMs = 3000, gestureMs = 600, settleMs = 60, maxLines = 200 } = {}) {
  if (!win || !doc || typeof log !== 'function') return () => {}
  let lastKey = { at: 0, pane: null, el: null }
  let lastGesture = -Infinity
  let lastCall = null
  let lastLine = -Infinity
  let lines = 0

  function report({ from, pane, to, keyAt, how }) {
    const t = now()
    if (lines >= maxLines || t - lastLine < 2000) return
    lastLine = t
    lines++
    lastKey = { at: 0, pane: null, el: null }
    const parts = [`focus: the keyboard left ${pane} while typing (${how}, ${Math.round((t - keyAt) / 100) / 10} s after a key there)`] // i18n-ignore
    parts.push(`now in ${describeEl(to)}`) // i18n-ignore
    if (!doc.hasFocus()) parts.push('the Tessel window lost the focus to another window') // i18n-ignore
    if (!from.isConnected) parts.push('its input was taken off the page (pane drawn again)') // i18n-ignore
    else if (from.getClientRects && !from.getClientRects().length) parts.push('its input is hidden') // i18n-ignore
    if (lastCall && lastCall.at >= keyAt) parts.push(`last ${lastCall.what}() on ${describeEl(lastCall.el)} from ${shortStack(lastCall.stack)}`) // i18n-ignore
    try {
      log(parts.join('; '))
    } catch {
      /* the log is gone */
    }
  }
  const typedLately = (t) => !!lastKey.el && t - lastKey.at <= typingMs && t - lastGesture >= gestureMs && lastGesture < lastKey.at

  const onPointer = () => (lastGesture = now())
  const onKey = (e) => {
    // Shortcuts and Tab move the keyboard on purpose.
    if (e.key === 'Tab' || e.key === 'Escape' || e.ctrlKey || e.altKey || e.metaKey || /^F\d+$/.test(e.key)) {
      lastGesture = now()
      return
    }
    const t = e.target
    const pane = t && t.matches && t.matches(INPUT_SEL) ? paneIdOf(t) : null
    if (pane && (pane === lastKey.pane || !typedLately(now()))) {
      lastKey = { at: now(), pane, el: t }
      return
    }
    // A key that reaches something else right after typing in a pane, with no
    // click or shortcut between (Chromium sends no focusout when the focused
    // input is taken off the page).
    if (typedLately(now())) report({ from: lastKey.el, pane: lastKey.pane, to: doc.activeElement, keyAt: lastKey.at, how: 'a key went elsewhere' }) // i18n-ignore
  }
  win.addEventListener('pointerdown', onPointer, true)
  win.addEventListener('keydown', onKey, true)

  // Who called focus() or blur() last (the stack says which code).
  const proto = win.HTMLElement && win.HTMLElement.prototype
  const origFocus = proto && proto.focus
  const origBlur = proto && proto.blur
  if (proto) {
    proto.focus = function (...args) {
      lastCall = { at: now(), what: 'focus', el: this, stack: new Error().stack }
      return origFocus.apply(this, args)
    }
    proto.blur = function (...args) {
      lastCall = { at: now(), what: 'blur', el: this, stack: new Error().stack }
      return origBlur.apply(this, args)
    }
  }

  const onFocusOut = (e) => {
    const from = e.target
    if (!from || from !== lastKey.el || !typedLately(now())) return
    const { pane, at } = lastKey
    win.setTimeout(() => {
      const to = doc.activeElement
      // Still there and the window still has the keyboard: nothing was lost.
      if (to === from && doc.hasFocus()) return
      if (lastKey.el !== from || !typedLately(now())) return
      report({ from, pane, to, keyAt: at, how: 'focus moved' }) // i18n-ignore
    }, settleMs)
  }
  doc.addEventListener('focusout', onFocusOut, true)

  return () => {
    win.removeEventListener('pointerdown', onPointer, true)
    win.removeEventListener('keydown', onKey, true)
    doc.removeEventListener('focusout', onFocusOut, true)
    if (proto) {
      proto.focus = origFocus
      proto.blur = origBlur
    }
  }
}
