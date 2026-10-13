// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createLocalHistory } from '../localHistory'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-history-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("Local History (VS Code's, for Tessel's editor)", () => {
  it('keeps each save, newest first; the same text twice is kept once', () => {
    let t = 1000
    const h = createLocalHistory({ dir, now: () => t++ })
    expect(h.add({ path: 'C:\\p\\a.ts', text: 'one' }).ok).toBe(true)
    expect(h.add({ path: 'C:\\p\\a.ts', text: 'one' }).skipped).toBe('same')
    h.add({ path: 'C:\\p\\a.ts', text: 'two' })
    const { entries } = h.list({ path: 'c:\\P\\A.ts' }) // any case
    expect(entries).toHaveLength(2)
    expect(h.read({ path: 'C:\\p\\a.ts', id: entries[0].id }).text).toBe('two')
    expect(h.read({ path: 'C:\\p\\a.ts', id: entries[1].id }).text).toBe('one')
    expect(entries[0].timestamp).toBeGreaterThan(entries[1].timestamp)
  })

  it('at most 50 versions a file (the oldest go), none over 256 KB, no path tricks', () => {
    const h = createLocalHistory({ dir, maxEntries: 3 })
    for (let i = 0; i < 5; i++) h.add({ path: '/srv/x.js', text: 'v' + i })
    const { entries } = h.list({ path: '/srv/x.js' })
    expect(entries.map((e) => h.read({ path: '/srv/x.js', id: e.id }).text)).toEqual(['v4', 'v3', 'v2'])
    expect(createLocalHistory({ dir, maxBytes: 4 }).add({ path: '/srv/y.js', text: 'too long' }).skipped).toBe('tooLarge')
    expect(h.read({ path: '/srv/x.js', id: '../../etc/passwd' }).ok).toBe(false)
    expect(h.add({ path: '', text: 'x' }).ok).toBe(false)
  })
})
