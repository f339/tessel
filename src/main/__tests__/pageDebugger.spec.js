// @vitest-environment node
// A browser page's debugger shared by its holders (pageDebugger.js): the
// first lease attaches it, the last one released detaches it, each lease
// hears the debugger's events until it is released, and the debugger going
// away on its own ends every lease.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { leaseDebugger, debuggerHolders, DebuggerUnavailableError } from '../pageDebugger'

// webContents.debugger as Electron has it: an emitter; detach() emits
// 'detach' as Electron does.
function fakePage({ attachError = null } = {}) {
  const dbg = new EventEmitter()
  dbg.attached = false
  dbg.attaches = 0
  dbg.sent = []
  dbg.isAttached = () => dbg.attached
  dbg.attach = vi.fn(() => {
    if (attachError) throw new Error(attachError)
    dbg.attached = true
    dbg.attaches++
  })
  dbg.detach = vi.fn(() => {
    dbg.attached = false
    dbg.emit('detach', {}, 'target closed')
  })
  dbg.sendCommand = vi.fn(async (method, params, sessionId) => {
    dbg.sent.push(sessionId ? [method, params, sessionId] : [method, params])
    return { ok: method }
  })
  let destroyed = false
  return { debugger: dbg, isDestroyed: () => destroyed, destroy: () => (destroyed = true) }
}

describe('page debugger lease', () => {
  it('attaches for the first holder and detaches only when the last one lets go', async () => {
    const page = fakePage()
    const a = leaseDebugger(page, 'agent')
    const b = leaseDebugger(page, 'live-share')
    expect(page.debugger.attach).toHaveBeenCalledTimes(1)
    expect(debuggerHolders(page)).toEqual(['agent', 'live-share'])
    expect(a.alone).toBe(false)
    expect(a.release()).toBe(false)
    expect(a.release()).toBe(false) // twice is once
    expect(page.debugger.attached).toBe(true)
    expect(b.alone).toBe(true)
    expect(await b.send('Page.captureScreenshot', { format: 'jpeg' })).toEqual({ ok: 'Page.captureScreenshot' })
    await expect(a.send('Page.enable')).rejects.toBeInstanceOf(DebuggerUnavailableError)
    expect(b.release()).toBe(true)
    expect(page.debugger.attached).toBe(false)
    expect(page.debugger.detach).toHaveBeenCalledTimes(1)
    expect(debuggerHolders(page)).toEqual([])
    // A new holder attaches again.
    const c = leaseDebugger(page, 'agent')
    expect(page.debugger.attaches).toBe(2)
    c.release()
  })

  it("each lease hears the debugger's events until it is released", () => {
    const page = fakePage()
    const a = leaseDebugger(page, 'agent')
    const b = leaseDebugger(page, 'live-share')
    const heardA = []
    const heardB = []
    a.on((_e, method, params, sessionId) => heardA.push([method, sessionId]))
    const offB = b.on((_e, method) => heardB.push(method))
    b.on(() => {
      throw new Error('one listener failing')
    })
    page.debugger.emit('message', {}, 'Page.screencastFrame', { sessionId: 1 })
    page.debugger.emit('message', {}, 'Page.frameNavigated', {}, 'S1')
    expect(heardA).toEqual([
      ['Page.screencastFrame', undefined],
      ['Page.frameNavigated', 'S1']
    ])
    expect(heardB).toEqual(['Page.screencastFrame', 'Page.frameNavigated'])
    offB()
    a.release()
    page.debugger.emit('message', {}, 'Page.loadEventFired', {})
    expect(heardA).toHaveLength(2)
    expect(heardB).toHaveLength(2)
    // Listeners are installed once per page, however many leases come and go.
    b.release()
    for (let i = 0; i < 5; i++) leaseDebugger(page, 'x').release()
    expect(page.debugger.listenerCount('message')).toBe(1)
    expect(page.debugger.listenerCount('detach')).toBe(1)
  })

  it('the debugger going away on its own (devtools opened) ends every lease and tells its holder', async () => {
    const page = fakePage()
    const onA = vi.fn()
    const onB = vi.fn()
    const a = leaseDebugger(page, 'agent', { onDetach: onA })
    const b = leaseDebugger(page, 'live-share', { onDetach: onB })
    page.debugger.attached = false
    page.debugger.emit('detach', {}, 'replaced_with_devtools')
    expect(onA).toHaveBeenCalledWith('replaced_with_devtools')
    expect(onB).toHaveBeenCalledWith('replaced_with_devtools')
    expect(a.active).toBe(false)
    expect(b.active).toBe(false)
    await expect(b.send('Page.enable')).rejects.toBeInstanceOf(DebuggerUnavailableError)
    expect(a.release()).toBe(false)
    expect(page.debugger.detach).not.toHaveBeenCalled()
    expect(debuggerHolders(page)).toEqual([])
  })

  it('our own detach (the last release) does not count as the debugger going away', () => {
    const page = fakePage()
    const onA = vi.fn()
    const a = leaseDebugger(page, 'agent', { onDetach: onA })
    a.release()
    expect(onA).not.toHaveBeenCalled()
  })

  it('a debugger detached without telling (no event) ends the old leases at the next lease', () => {
    const page = fakePage()
    const onA = vi.fn()
    const a = leaseDebugger(page, 'agent', { onDetach: onA })
    page.debugger.attached = false // silently
    const b = leaseDebugger(page, 'live-share')
    expect(onA).toHaveBeenCalledWith('detached')
    expect(a.active).toBe(false)
    expect(page.debugger.attaches).toBe(2)
    expect(debuggerHolders(page)).toEqual(['live-share'])
    b.release()
  })

  it("throws the debugger's own error when it cannot be attached, and never for a closed page", () => {
    const busy = fakePage({ attachError: 'Another debugger is already attached' })
    expect(() => leaseDebugger(busy, 'agent')).toThrow('Another debugger is already attached')
    expect(debuggerHolders(busy)).toEqual([])
    const page = fakePage()
    page.destroy()
    expect(() => leaseDebugger(page, 'agent')).toThrow(DebuggerUnavailableError)
    expect(() => leaseDebugger(null, 'agent')).toThrow(DebuggerUnavailableError)
  })

  it('a page closed meanwhile: release does not touch its debugger', () => {
    const page = fakePage()
    const a = leaseDebugger(page, 'agent')
    page.destroy()
    expect(a.release()).toBe(true)
    expect(page.debugger.detach).not.toHaveBeenCalled()
  })

  it('a command that throws at once is a rejected promise, not an exception', async () => {
    const page = fakePage()
    const a = leaseDebugger(page, 'agent')
    page.debugger.sendCommand.mockImplementation(() => {
      throw new Error('No target')
    })
    await expect(a.send('Page.enable')).rejects.toThrow('No target')
    a.release()
  })
})
