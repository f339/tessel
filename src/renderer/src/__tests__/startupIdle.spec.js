// What waits for the start (startupIdle.js): run at once outside a start;
// during one, held until it is over, then one job at a time, a moment apart.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { afterStartup, isStartupFinished, resetStartupIdleForTests, startupBegins, startupFinished } from '../startupIdle'

afterEach(() => {
  resetStartupIdleForTests()
  vi.useRealTimers()
})

describe('startupIdle', () => {
  it('runs at once when no start is going on (a pane opened later, a test)', () => {
    const job = vi.fn()
    expect(isStartupFinished()).toBe(true)
    afterStartup(job)
    expect(job).toHaveBeenCalledTimes(1)
  })

  it('holds jobs during a start, then runs them one at a time, a moment apart', () => {
    vi.useFakeTimers()
    const done = []
    startupBegins()
    expect(isStartupFinished()).toBe(false)
    afterStartup(() => done.push('a'))
    afterStartup(() => {
      throw new Error('one failing job')
    })
    afterStartup(() => done.push('c'))
    vi.advanceTimersByTime(5000)
    expect(done).toEqual([])
    startupFinished({ gap: 40 })
    expect(isStartupFinished()).toBe(true)
    vi.advanceTimersByTime(0)
    expect(done).toEqual(['a'])
    vi.advanceTimersByTime(40)
    // The failing one ran (and threw) without stopping the next.
    expect(done).toEqual(['a'])
    vi.advanceTimersByTime(40)
    expect(done).toEqual(['a', 'c'])
    // Once started: at once.
    afterStartup(() => done.push('d'))
    expect(done).toEqual(['a', 'c', 'd'])
  })

  it('a second finish changes nothing', () => {
    const job = vi.fn()
    startupFinished()
    startupBegins()
    afterStartup(job)
    vi.useFakeTimers()
    startupFinished()
    startupFinished()
    vi.runAllTimers()
    expect(job).toHaveBeenCalledTimes(1)
  })
})
