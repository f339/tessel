// Startup's re-attaches (restoreAttach.js): asked a few at a time in the
// order given (the project you were in first), each pane's output seeded the
// moment its answer comes, a failure never stopping the others.
import { describe, expect, it, vi } from 'vitest'
import { prefetchAttaches, terminalLeafIds } from '../restoreAttach'

const leaf = (id, extra = {}) => ({ type: 'leaf', id, ...extra })
const split = (...children) => ({ type: 'split', dir: 'row', children })
const tick = () => new Promise((r) => setTimeout(r, 0))

function deferredAttach() {
  const pending = new Map()
  const asked = []
  const attach = vi.fn((id) => {
    asked.push(id)
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  })
  return { attach, asked, pending, inFlight: () => pending.size }
}

describe('terminalLeafIds', () => {
  it('lists the wanted leaves in tree order, nested splits included', () => {
    const tree = split(leaf('pane-a'), split(leaf('pane-b', { kind: 'browser' }), leaf('pane-c')), leaf('pane-d'))
    expect(terminalLeafIds(tree, (s) => s.kind !== 'browser')).toEqual(['pane-a', 'pane-c', 'pane-d'])
    expect(terminalLeafIds(null, () => true)).toEqual([])
    expect(terminalLeafIds(leaf('pane-x'), () => true)).toEqual(['pane-x'])
  })
})

describe('prefetchAttaches', () => {
  it('asks at most `limit` at a time, in the order given, each id once', async () => {
    const host = deferredAttach()
    const ids = ['p1', 'p2', 'p3', 'p1', 'p4', 'p5']
    const pre = prefetchAttaches(ids, { attach: host.attach, seed: () => {}, limit: 2 })
    expect(host.asked).toEqual(['p1', 'p2'])
    host.pending.get('p2').resolve({ ok: true, buffer: 'two' })
    host.pending.delete('p2')
    await tick()
    expect(host.asked).toEqual(['p1', 'p2', 'p3'])
    for (const id of ['p1', 'p3']) {
      host.pending.get(id).resolve({ ok: true, buffer: id })
      host.pending.delete(id)
    }
    await tick()
    expect(host.asked).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
    expect(host.attach).toHaveBeenCalledTimes(5)
    expect(pre.get('p9')).toBeUndefined()
  })

  it('seeds a pane’s output as its answer comes, before its promise is taken', async () => {
    const order = []
    const host = deferredAttach()
    const seed = vi.fn((id, buffer) => order.push(`seed ${id} ${buffer}`))
    const pre = prefetchAttaches(['p1', 'p2'], { attach: host.attach, seed, limit: 4 })
    host.pending.get('p1').resolve({ ok: true, buffer: 'screen' })
    await tick()
    // Seeded although nobody asked for p1's answer yet.
    expect(order).toEqual(['seed p1 screen'])
    expect(await pre.get('p1')).toMatchObject({ ok: true })
    host.pending.get('p2').resolve({ ok: false })
    expect(await pre.get('p2')).toEqual({ ok: false })
    // A terminal not running: nothing seeded.
    expect(seed).toHaveBeenCalledTimes(1)
  })

  it('a failed or throwing attach answers null and the queue goes on', async () => {
    const attach = vi.fn((id) => {
      if (id === 'boom') throw new Error('sync failure')
      if (id === 'bad') return Promise.reject(new Error('host gone'))
      return Promise.resolve({ ok: true, buffer: '' })
    })
    const seed = vi.fn(() => {
      throw new Error('seed failure')
    })
    const pre = prefetchAttaches(['boom', 'bad', 'good'], { attach, seed, limit: 1 })
    expect(await pre.get('boom')).toBeNull()
    expect(await pre.get('bad')).toBeNull()
    // A failing seed still lets the pane come back (and the queue go on).
    expect(await pre.get('good')).toMatchObject({ ok: true })
    expect(pre.stats()).toMatchObject({ count: 3, attached: 1, limit: 1 })
  })

  it('reports how many came back, how long it took and the slowest', async () => {
    let now = 1000
    const host = deferredAttach()
    const pre = prefetchAttaches(['a', 'b'], { attach: host.attach, limit: 2, now: () => now })
    now = 1300
    host.pending.get('a').resolve({ ok: true })
    await pre.get('a')
    now = 1900
    host.pending.get('b').resolve(null)
    await pre.get('b')
    expect(pre.stats()).toEqual({ count: 2, attached: 1, ms: 900, slowest: 900, limit: 2 })
  })
})
