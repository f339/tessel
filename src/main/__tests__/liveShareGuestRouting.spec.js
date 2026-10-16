// Live Share phase 2, guest side: the window's calls for files go to the
// host's project through the session for an lshare:// path (guestFs.js), to
// a remote host for an ssh:// one, and to this computer otherwise; what would
// act on this computer is refused for a shared path (liveShare/
// guestRouting.js, and index.js using it for every such handler).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { lshareArg, remoteArg, pickFs, localOnlyFor } from '../liveShare/guestRouting'
import { LOCAL_ONLY_ACTIONS, createGuestFs } from '../liveShare/guestFs'

const FS = { local: 'local', remote: 'remote', lshare: 'lshare' }

describe('which code answers a call for files', () => {
  it('picks the guest\u2019s session for any shared path, the remote host for an ssh one, this computer otherwise', () => {
    expect(pickFs('lshare://ws-1\\src\\a.js', FS)).toBe('lshare')
    expect(pickFs({ root: 'lshare://ws-1' }, FS)).toBe('lshare')
    expect(pickFs({ root: 'C:\\x', dir: 'lshare://ws-1\\src' }, FS)).toBe('lshare')
    expect(pickFs({ file: 'lshare://ws-1\\a' }, FS)).toBe('lshare')
    expect(pickFs({ cwd: 'lshare://ws-1' }, FS)).toBe('lshare')
    // A shared path wins over a remote one in the same call (never a local
    // or remote handler for it).
    expect(pickFs({ root: 'ssh://h1/srv', path: 'lshare://ws-1\\a' }, FS)).toBe('lshare')
    expect(pickFs({ root: 'ssh://h1/srv' }, FS)).toBe('remote')
    expect(pickFs('ssh://h1/srv/a', FS)).toBe('remote')
    expect(pickFs({ root: 'C:\\x' }, FS)).toBe('local')
    expect(pickFs(null, FS)).toBe('local')
    expect(lshareArg({ root: 5 })).toBe(false)
    expect(remoteArg({ root: 'ssh://h1/srv', file: 'lshare://ws-1\\a' })).toBe(false)
  })

  it('refuses what acts on this computer for a shared path only', () => {
    for (const action of LOCAL_ONLY_ACTIONS) {
      expect(localOnlyFor(action, 'lshare://ws-1\\a.pdf')).toBe(true)
      expect(localOnlyFor(action, { root: 'lshare://ws-1' })).toBe(true)
      expect(localOnlyFor(action, 'C:\\a.pdf')).toBe(false)
    }
    expect(localOnlyFor('explorer:list', 'lshare://ws-1')).toBe(false)
  })

  it('answers "not here" for those calls, and "the host did not answer" without a session', async () => {
    const offline = createGuestFs({ request: () => Promise.reject(new Error('offline')) })
    expect(offline.localOnly()).toMatchObject({ ok: false, code: 'local-only' })
    expect(await offline.listDir({ root: 'lshare://ws-1' })).toMatchObject({ ok: false, code: 'offline', transient: true })
    for (const op of ['scmPush', 'scmPull', 'scmFetch', 'scmSync']) expect(await offline.scm[op]({ root: 'lshare://ws-1' })).toMatchObject({ ok: false, code: 'local-only' })
  })

  it('index.js sends every file call of a shared project to the session and refuses the local-only ones', () => {
    const src = readFileSync(join(__dirname, '..', 'index.js'), 'utf8')
    expect(src).toMatch(/const explorerFor = \(q\) => pickFs\(q, \{ local: explorer, remote: remoteFs, lshare: guestFs\(\) \}\)/)
    expect(src).toMatch(/const scmFor = \(q\) => pickFs\(q, \{ local: scm, remote: remoteFs\.scm, lshare: guestFs\(\)\.scm \}\)/)
    for (const handler of ['editor:read', 'editor:stat', 'editor:head']) expect(src).toMatch(new RegExp(`ipcMain\\.handle\\('${handler}', safe\\(\\(file\\) => pickFs\\(file,`))
    for (const [handler, check] of [
      ['editor:write', "if (lshareArg(q && q.file)) return guestFs().writeForEdit"],
      ['notes:load', 'if (lshareArg(opts)) return guestFs().loadNotes'],
      ['notes:save', 'if (lshareArg(opts)) return guestFs().saveNotes'],
      ['files:list', 'lshareArg(root) ? guestFs().listProjectFiles(root)'],
      ['files:view', 'if (lshareArg(file)) return guestFs().readForView(file)'],
      ['explorer:trash', 'lshareArg(q) ? guestFs().trash(q)']
    ]) {
      const at = src.indexOf(`ipcMain.handle('${handler}'`)
      expect(at, handler).toBeGreaterThan(-1)
      expect(src.slice(at, at + 400), handler).toContain(check)
    }
    for (const action of ['explorer:reveal', 'files:open', 'files:openPdf', 'scm:generate']) expect(src, action).toContain(`localOnlyFor('${action}'`)
    // A terminal never starts in a shared project's folder.
    const create = src.slice(src.indexOf("ipcMain.handle('pty:create'"), src.indexOf("ipcMain.handle('pty:create'") + 1500)
    expect(create).toContain('isLsharePath(cwd) || isLsharePath(projectDir) || isLsharePath(opts.remotePath)')
    // The watches follow the host's project through the session.
    const watch = src.slice(src.indexOf("ipcMain.handle('explorer:watch'"), src.indexOf("ipcMain.handle('explorer:watch'") + 700)
    expect(watch).toContain('liveShare.guestWatchRoot(root)')
    expect(src).toContain('liveShare.guestWatchFiles(shared)')
  })
})
