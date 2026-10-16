// What waits for the start (startupIdle.js): run at once outside a start;
// during one, held until it is over, then one job at a time, a moment apart.
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
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

// App.vue: the start's finish runs even when one of its steps throws, so the
// held work and the tessel command's requests never wait for the 60 s guard.
describe('App.vue', () => {
  it('finishes the start in a finally', () => {
    const app = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8').replace(/\r\n/g, '\n')
    const mounted = app.slice(app.indexOf("onMounted(async () => {\n  // The finish below runs"))
    const finish = mounted.slice(mounted.indexOf('  } finally {'), mounted.indexOf('\n  }\n'))
    expect(mounted.indexOf('  try {')).toBeLessThan(mounted.indexOf('shells.value = await window.shellApi.listShells()'))
    expect(mounted.indexOf('await startAutomations()')).toBeLessThan(mounted.indexOf('  } finally {'))
    expect(finish).toContain('startupFinished()')
    expect(finish).toContain('startCliRequests()')
  })
})
