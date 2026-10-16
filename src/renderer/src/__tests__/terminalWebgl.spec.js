// The window's WebGL terminals (terminalWebgl.js): at most MAX_WEBGL at once,
// so Chromium (16 per window) never drops the context of a pane on screen.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_WEBGL, claimWebgl, releaseWebgl, noteWebglShown, _webglHoldersForTests, _resetWebglForTests } from '../terminalWebgl'

function pane(onScreen = true) {
  const p = {
    shown: onScreen,
    onScreen: () => p.shown,
    release: vi.fn(() => releaseWebgl(p)),
    retry: vi.fn()
  }
  return p
}

describe('terminalWebgl: the WebGL places of the window', () => {
  afterEach(() => _resetWebglForTests())

  it('stays under the 16 contexts Chromium keeps per window', () => {
    expect(MAX_WEBGL).toBeLessThan(16)
    expect(MAX_WEBGL).toBeGreaterThanOrEqual(8)
  })

  it('gives a place to each pane up to the limit, once each', () => {
    const panes = Array.from({ length: MAX_WEBGL }, () => pane())
    for (const p of panes) expect(claimWebgl(p)).toBe(true)
    expect(claimWebgl(panes[0])).toBe(true)
    expect(_webglHoldersForTests().holders).toBe(MAX_WEBGL)
  })

  it('full: the pane out of sight shown least recently gives its place back', () => {
    const panes = Array.from({ length: MAX_WEBGL }, () => pane())
    for (const p of panes) claimWebgl(p)
    panes[2].shown = false
    panes[5].shown = false
    // panes[2] shown again lately (still out of sight now): panes[5] goes first.
    noteWebglShown(panes[2])
    const next = pane()
    expect(claimWebgl(next)).toBe(true)
    expect(panes[5].release).toHaveBeenCalledTimes(1)
    expect(panes[2].release).not.toHaveBeenCalled()
    expect(_webglHoldersForTests().holders).toBe(MAX_WEBGL)
  })

  it('full of panes on screen: the new one waits, and gets a place once one frees', async () => {
    const panes = Array.from({ length: MAX_WEBGL }, () => pane())
    for (const p of panes) claimWebgl(p)
    const late = pane()
    expect(claimWebgl(late)).toBe(false)
    expect(panes.some((p) => p.release.mock.calls.length)).toBe(false)
    expect(_webglHoldersForTests().waiting).toBe(1)
    releaseWebgl(panes[0])
    expect(late.retry).not.toHaveBeenCalled() // told after the change, not inside it
    await Promise.resolve()
    expect(late.retry).toHaveBeenCalledTimes(1)
    expect(_webglHoldersForTests().waiting).toBe(0)
  })

  it('a waiting pane gone out of sight is not told; one that gives up its wait is forgotten', async () => {
    const panes = Array.from({ length: MAX_WEBGL }, () => pane())
    for (const p of panes) claimWebgl(p)
    const hidden = pane()
    const gone = pane()
    claimWebgl(hidden)
    claimWebgl(gone)
    hidden.shown = false
    releaseWebgl(gone)
    releaseWebgl(panes[0])
    await Promise.resolve()
    expect(hidden.retry).not.toHaveBeenCalled()
    expect(gone.retry).not.toHaveBeenCalled()
    expect(_webglHoldersForTests()).toEqual({ holders: MAX_WEBGL - 1, waiting: 0 })
  })

  it('a pane that throws (gone meanwhile) counts as out of sight and never breaks a claim', () => {
    const panes = Array.from({ length: MAX_WEBGL }, () => pane())
    for (const p of panes) claimWebgl(p)
    panes[3].onScreen = () => {
      throw new Error('gone')
    }
    panes[3].release = vi.fn(() => {
      throw new Error('gone')
    })
    expect(claimWebgl(pane())).toBe(true)
    expect(panes[3].release).toHaveBeenCalledTimes(1)
    expect(_webglHoldersForTests().holders).toBe(MAX_WEBGL)
  })
})
