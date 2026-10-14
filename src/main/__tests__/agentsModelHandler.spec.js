// The agents:model handler (taken from index.js): a Codex pane on a managed
// account reads that account's Codex home, never a path from the window, and
// never the system's ~/.codex when the account can't be read.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import vm from 'node:vm'
import { join } from 'node:path'

const main = fs.readFileSync(join(__dirname, '..', 'index.js'), 'utf8')
const start = main.indexOf("ipcMain.handle('agents:model',")
const handlerSource = main.slice(start, main.indexOf('\n})\n', start) + 4)

function harness(roots) {
  const reads = []
  const handlers = {}
  vm.runInNewContext(handlerSource, {
    ipcMain: { handle: (k, v) => (handlers[k] = v) },
    remoteHosts: { get: () => null },
    remoteModels: {},
    remoteAgentModel: async () => null,
    accountSessions: { roots },
    agentModelLive: async (q) => (reads.push(q), { model: q.codexDir ? 'gpt-account' : 'gpt-system', effort: 'low', source: 'session' })
  })
  return { call: (q) => handlers['agents:model']({}, q), reads }
}

describe('agents:model handler', () => {
  it("reads a managed Codex account's own home, never a folder sent by the window", async () => {
    const h = harness(async () => ({ codex: 'C:\\accounts\\one\\home' }))
    expect(await h.call({ agentId: 'codex', accountId: 'one', codexDir: 'C:\\elsewhere' })).toMatchObject({ model: 'gpt-account' })
    expect(h.reads[0].codexDir).toBe('C:\\accounts\\one\\home')
  })

  it("an account that can't be read (removed meanwhile): the pane keeps what it showed, the system's ~/.codex is never read", async () => {
    for (const roots of [async () => null, async () => ({}), async () => Promise.reject(new Error('unreadable'))]) {
      const h = harness(roots)
      expect(await h.call({ agentId: 'codex', accountId: 'gone' })).toEqual({ keep: true })
      expect(h.reads).toEqual([])
    }
  })

  it('a pane on the system login reads the system files, as before', async () => {
    const h = harness(async () => {
      throw new Error('not asked')
    })
    expect(await h.call({ agentId: 'codex', codexDir: 'C:\\elsewhere' })).toMatchObject({ model: 'gpt-system' })
    expect(h.reads[0]).not.toHaveProperty('codexDir')
  })
})
