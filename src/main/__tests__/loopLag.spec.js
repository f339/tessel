import { describe, it, expect, afterEach, vi } from 'vitest'
import { watchLoopLag } from '../loopLag'

// A process's event-loop stalls in the log (2026-10-12: the terminal host was
// stuck 11 minutes and nothing said so). The clock is driven by hand: each
// tick() runs the 1 s timer once, `late` ms after it was due.
function setup(opts = {}) {
  vi.useFakeTimers()
  let clock = 0
  const lines = []
  const stop = watchLoopLag({ log: (m) => lines.push(m), now: () => clock, ...opts })
  const tick = (late = 0) => {
    clock += 1000 + late
    vi.advanceTimersByTime(1000)
  }
  return { lines, stop, tick }
}

let stopper = null
afterEach(() => {
  if (stopper) stopper()
  stopper = null
  vi.useRealTimers()
})

describe('watchLoopLag', () => {
  it('says nothing while the timer runs on time or a little late', () => {
    const { lines, stop, tick } = setup()
    stopper = stop
    for (let i = 0; i < 20; i++) tick(i % 2 ? 1500 : 0)
    expect(lines).toEqual([])
  })

  it('reports a stall at once, with how long, the memory and the extra details', () => {
    const { lines, stop, tick } = setup({ extra: () => '18 terminal(s), 1 app connection(s)' })
    stopper = stop
    tick()
    tick(4200)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^event loop blocked for 4200 ms \(rss \d+ MB, heap \d+\/\d+ MB, 18 terminal\(s\), 1 app connection\(s\)\)$/)
  })

  it('holds back the stalls that follow and reports them once the quiet time is over', () => {
    const { lines, stop, tick } = setup()
    stopper = stop
    tick(3000) // reported
    tick(5000) // held
    tick(2500) // held
    expect(lines).toHaveLength(1)
    for (let i = 0; i < 10; i++) tick() // back to normal past the 10 s quiet time
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatch(/^event loop: 2 more stall\(s\) after the last report, longest 5000 ms/)
  })

  it('adds the held-back stalls to the next report when the PC stays stuck', () => {
    const { lines, stop, tick } = setup()
    stopper = stop
    tick(3000) // reported (clock 4 s)
    tick(2000) // held (7 s)
    for (let i = 0; i < 6; i++) tick() // on time, the quiet time not over yet (13 s)
    tick(2100) // over (16.1 s): reported with the one held
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatch(/^event loop blocked for 2100 ms .*; 1 more since the last report, longest 2000 ms$/)
  })

  it('never breaks the watched process: a failing log or extra is ignored', () => {
    const { stop, tick } = setup({
      log: () => {
        throw new Error('disk full')
      },
      extra: () => {
        throw new Error('gone')
      }
    })
    stopper = stop
    expect(() => tick(5000)).not.toThrow()
  })

  it('stops when asked', () => {
    const { lines, stop, tick } = setup()
    stop()
    tick(9000)
    expect(lines).toEqual([])
  })
})
