// @vitest-environment node
// Live Share phase 2c: the share's hidden files never named in the free text
// guests read (liveShare/shareHiddenText.js), with the history and activity
// copies that use it: .git and .tessel (but its notes) always, secret names
// with the share's setting, what git ignores (one check for all the words,
// charged to the guest's budget: over it, busy); a word naming a visible
// file stays, and so does a sentence's dot after a hidden one.
import { describe, it, expect, vi } from 'vitest'
import { hideHiddenNames, pathWords, hideWords } from '../liveShare/shareHiddenText'
import { createShareHistory } from '../liveShare/shareHistory'
import { guestActivity, mapActivityTexts } from '../liveShare/shareActivity'
import { cleanRoots } from '../liveShare/shareChat'

const ON = { hideIgnored: true }
const OFF = { hideIgnored: false }

// A scope whose git ignores dist/ and *.log (shareScope.js hiddenOf's shape).
function fakeScope({ refuse = false } = {}) {
  const asked = []
  return {
    asked,
    hiddenOf: vi.fn(async (_info, rels, settings, { charge } = {}) => {
      asked.push(rels)
      const { hiddenByName } = await import('../liveShare/shareScope')
      const out = new Set(rels.filter((r) => hiddenByName(r, settings)))
      if (settings.hideIgnored === false) return out
      if (charge && (refuse || charge() === false)) throw Object.assign(new Error('busy'), { code: 'busy' })
      for (const r of rels) if (/^dist(\/|$)|\.log$/.test(r)) out.add(r)
      return out
    })
  }
}

describe('Live Share: hidden files out of the guests\u2019 texts', () => {
  it('finds the path-like words of a text, from the project folder', () => {
    const words = pathWords(['Edited src\\app.js and ./README.md, then read .env. Also see id_rsa, plain words, 1.5 and ../up/x'], ON)
    expect(words).toEqual(expect.arrayContaining(['src/app.js', 'README.md', '.env', 'id_rsa', '1.5']))
    expect(words).not.toContain('plain')
    expect(words.some((w) => w.includes('..'))).toBe(false)
  })

  it('hides .git, .tessel (not its notes), secrets and what git ignores; keeps the rest and the punctuation', async () => {
    const scope = fakeScope()
    const charge = vi.fn(() => true)
    const texts = [
      'I read .env and .tessel/team/abc123token/inbox.json, then .git/config.',
      'Notes are in .tessel/notes.md; the build is in dist/out.js and logs in app.log.',
      'Edited src/app.js and src\\util.js; keys in deploy/prod.pem!'
    ]
    const out = await hideHiddenNames(texts, { scope, info: { real: 'C:\\site' }, settings: ON, charge })
    expect(out[0]).toBe('I read … and …, then ….')
    expect(out[1]).toBe('Notes are in .tessel/notes.md; the build is in … and logs in ….')
    expect(out[2]).toBe('Edited src/app.js and src\\util.js; keys in …!')
    // One check for every word of every text, charged once to the guest.
    expect(scope.hiddenOf).toHaveBeenCalledTimes(1)
    expect(charge).toHaveBeenCalledTimes(1)
    // The setting off: secrets and ignored files named, .git and .tessel never.
    const off = await hideHiddenNames(texts, { scope: fakeScope(), info: { real: 'C:\\site' }, settings: OFF })
    expect(off[0]).toBe('I read .env and …, then ….')
    expect(off[1]).toContain('dist/out.js')
    expect(off[2]).toContain('deploy/prod.pem')
  })

  it('over the guest\u2019s git budget: busy; without a project folder: by name only', async () => {
    await expect(hideHiddenNames(['see dist/out.js'], { scope: fakeScope({ refuse: true }), info: { real: 'C:\\site' }, settings: ON, charge: () => false })).rejects.toMatchObject({ code: 'busy' })
    expect(await hideHiddenNames(['see .env and dist/out.js'], { settings: ON })).toEqual(['see … and dist/out.js'])
    expect(hideWords('a .git b', (rel) => rel === '.git')).toBe('a … b')
    expect(await hideHiddenNames(['nothing here'], { settings: ON })).toEqual(['nothing here'])
  })

  it('the history copies: titles, details and terminal texts', async () => {
    const ROOT = 'C:\\Users\\ada\\site'
    const scope = fakeScope()
    const maskHidden = (texts) => hideHiddenNames(texts, { scope, info: { real: ROOT }, settings: ON })
    const where = { root: ROOT, roots: cleanRoots([ROOT]), rawRoots: [ROOT], maskHidden }
    const h = createShareHistory({
      listSessions: async () => [{ agent: 'claude', id: 's-1', title: `Fix ${ROOT}\\.env loading`, updated: 2 }],
      sessionDetails: async () => ({ ok: true, firstPrompt: 'Read .tessel/team/tok123/inbox.json', turns: [{ role: 'assistant', text: 'dist/out.js is stale', at: 1 }] }),
      readTerminal: async (q) => ({ ok: true, panes: { [q.panes[0].ask]: { key: 'k', items: [{ role: 'agent', t: 1, text: 'cat .git/HEAD' }] } } }),
      key: Buffer.alloc(32, 3)
    })
    const list = await h.list('ws-1', {}, where)
    expect(list.data.sessions[0].title).toBe('Fix … loading')
    const details = await h.details('ws-1', { ref: list.data.sessions[0].ref }, where)
    expect(details.data.firstPrompt).toBe('Read …')
    expect(details.data.turns[0].text).toBe('… is stale')
    const term = await h.terminal('ws-1', {}, { ...where, panes: [{ id: 'pane-1', agentId: 'claude', sessionId: 'x', terminal: true }] })
    expect(term.data.panes['pane-1'].items[0].text).toBe('cat …')
  })

  it('the activity copy: every text slot', async () => {
    const data = guestActivity([{ t: 1, type: 'message', text: 'see .env', title: 'dist/a.js', agent: { title: 'ok' }, sender: { name: 'Ada', cardTitle: '.git/x' } }], [{ id: 't1', name: 'app.log team' }], 'ws-1', [])
    const texts = mapActivityTexts(data, (t) => t)
    const masked = await hideHiddenNames(texts, { scope: fakeScope(), info: { real: 'C:\\site' }, settings: ON })
    mapActivityTexts(data, (_t, i) => masked[i])
    expect(data.events[0]).toMatchObject({ text: 'see …', title: '…', agent: { title: 'ok' }, sender: { name: 'Ada', cardTitle: '…' } })
    expect(data.teams[0].name).toBe('… team')
  })
})
