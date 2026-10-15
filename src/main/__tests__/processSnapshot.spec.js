// @vitest-environment node
// The process list from a PowerShell kept open (processTree.js
// createSnapshotWorker): started on the first list, one list at a time,
// closed when unused or when it stops answering; the one-time query
// otherwise.
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { createSnapshotWorker, listProcessNames, stopProcessSnapshots } from '../processTree'

// A PowerShell that does what `answer` says for each line it reads.
function fakePs({ ready = true, answer = () => '' } = {}) {
  const made = []
  const spawnImpl = (file, args, opts) => {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.killed = false
    child.kill = () => {
      child.killed = true
      child.emit('exit', 1)
    }
    made.push({ file, args, opts, child })
    let lines = ''
    child.stdin.on('data', (d) => {
      lines += String(d)
      let i
      while ((i = lines.indexOf('\n')) >= 0) {
        const l = lines.slice(0, i)
        lines = lines.slice(i + 1)
        const out = answer(l, made.length)
        if (out !== null) child.stdout.write(out + '__TESSEL_END__\r\n')
      }
    })
    if (ready) setTimeout(() => child.stdout.write('__TESSEL_READY__\r\n'), 1)
    return child
  }
  return { spawnImpl, made }
}

describe('the process list kept open', () => {
  it('started once, hidden, with its script encoded; each list parsed; one at a time', async () => {
    let n = 0
    const { spawnImpl, made } = fakePs({ answer: () => `4\t0\tSystem\n${100 + ++n}\t4\tpwsh.exe\n` })
    const w = createSnapshotWorker({ spawnImpl })
    const [a, b] = await Promise.all([w.list(), w.list()])
    expect(a).toEqual([
      { pid: 4, ppid: 0, name: 'System' },
      { pid: 101, ppid: 4, name: 'pwsh.exe' }
    ])
    expect(b[1].pid).toBe(102)
    expect(made).toHaveLength(1)
    expect(made[0].file).toBe('powershell.exe')
    expect(made[0].args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(Buffer.from(made[0].args[4], 'base64').toString('utf16le')).toContain('CreateToolhelp32Snapshot')
    expect(made[0].opts).toMatchObject({ windowsHide: true })
    w.stop()
    expect(made[0].child.killed).toBe(true)
  })

  it('no answer in time: null, closed, started again for the next list', async () => {
    let silent = true
    const { spawnImpl, made } = fakePs({ answer: () => (silent ? null : '7\t1\tnode.exe\n') })
    const w = createSnapshotWorker({ spawnImpl, answerMs: 30 })
    expect(await w.list()).toBe(null)
    expect(made[0].child.killed).toBe(true)
    silent = false
    expect(await w.list()).toEqual([{ pid: 7, ppid: 1, name: 'node.exe' }])
    expect(made).toHaveLength(2)
    w.stop()
  })

  it('never ready, or gone: null (the one-time query is used), then started again', async () => {
    const never = createSnapshotWorker({ spawnImpl: fakePs({ ready: false }).spawnImpl, startMs: 30 })
    expect(await never.list()).toBe(null)
    const { spawnImpl, made } = fakePs({ answer: () => '9\t1\tcmd.exe\n' })
    const w = createSnapshotWorker({ spawnImpl })
    expect(await w.list()).toEqual([{ pid: 9, ppid: 1, name: 'cmd.exe' }])
    made[0].child.emit('exit', 0)
    expect(await w.list()).toEqual([{ pid: 9, ppid: 1, name: 'cmd.exe' }])
    expect(made).toHaveLength(2)
    w.stop()
    const broken = createSnapshotWorker({
      spawnImpl: () => {
        throw new Error('no powershell')
      }
    })
    expect(await broken.list()).toBe(null)
  })

  it('closed after a while unused', async () => {
    const { spawnImpl, made } = fakePs({ answer: () => '9\t1\tcmd.exe\n' })
    const w = createSnapshotWorker({ spawnImpl, idleMs: 20 })
    await w.list()
    await new Promise((r) => setTimeout(r, 60))
    expect(made[0].child.killed).toBe(true)
    w.stop()
  })
})

describe.skipIf(process.platform !== 'win32')('the real one (Windows)', () => {
  it("lists this process with its parent, fast once open", async () => {
    try {
      const first = await listProcessNames()
      const me = first.find((p) => p.pid === process.pid)
      expect(me).toMatchObject({ ppid: process.ppid })
      expect(me.name.toLowerCase()).toMatch(/node|electron/)
      const t0 = Date.now()
      const again = await listProcessNames()
      expect(again.some((p) => p.pid === process.pid)).toBe(true)
      expect(Date.now() - t0).toBeLessThan(1500)
    } finally {
      stopProcessSnapshots()
    }
  }, 30000)
})
