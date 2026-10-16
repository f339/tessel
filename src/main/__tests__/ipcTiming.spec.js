// @vitest-environment node
// How long IPC handlers hold the main process (ipcTiming.js): a long one is
// logged (once a minute per channel), the slowest of the last seconds is
// named for the stall reports, and the busiest are summed up.
import { describe, expect, it, vi } from 'vitest'
import { createIpcTiming } from '../ipcTiming'

describe('ipcTiming', () => {
  it('logs a handler that held the process long, once per quiet period', () => {
    let now = 0
    const log = vi.fn()
    const timing = createIpcTiming({ log, now: () => now, slowMs: 500, quietMs: 60000 })
    timing.measure('agents:model', 20)
    timing.measure('agents:children', 6988)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toBe('IPC agents:children held the main process for 6988 ms')
    now = 30000
    timing.measure('agents:children', 900)
    expect(log).toHaveBeenCalledTimes(1)
    now = 61000
    timing.measure('agents:children', 900)
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('names the slowest handler of the last seconds', () => {
    let now = 0
    const timing = createIpcTiming({ now: () => now, recentMs: 15000 })
    expect(timing.slowestRecent()).toBe('')
    timing.measure('git:info', 30) // too short to count
    expect(timing.slowestRecent()).toBe('')
    timing.measure('agents:children', 1200)
    now = 5000
    timing.measure('agents:model', 300)
    expect(timing.slowestRecent()).toBe('slowest IPC lately: agents:children 1200 ms')
    now = 16000
    expect(timing.slowestRecent()).toBe('slowest IPC lately: agents:model 300 ms')
  })

  it('sums up the busiest channels', () => {
    const timing = createIpcTiming()
    for (let i = 0; i < 3; i++) timing.measure('agents:model', 10)
    timing.measure('layout:load', 5)
    timing.measure('agents:children', 200)
    timing.measure('noise', 0.2)
    expect(timing.busiest(2)).toBe('agents:children 1x 200 ms (max 200 ms), agents:model 3x 30 ms (max 10 ms)')
    expect(timing.busiest()).not.toContain('noise')
    timing.measure(null, 5)
    timing.measure('bad', NaN)
    expect(timing.busiest(10)).not.toContain('bad')
  })
})
