import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '1.0.0' } }))
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn() } }))

const { htmlToText, createUpdater } = await import('../updater.js')

describe('htmlToText', () => {
  it('turns GitHub release-note HTML into plain text', () => {
    const html =
      '<h2>Contenu</h2>\n<ul>\n<li>Mises à jour &amp; reprise</li>\n<li>Onglets</li>\n</ul><p>Voir <a href="x">ici</a></p>'
    expect(htmlToText(html)).toBe('Contenu\n\n• Mises à jour & reprise\n\n• Onglets\n\nVoir ici')
  })
})

describe('createUpdater', () => {
  it('stays off in a dev build', async () => {
    const u = createUpdater({ log: {}, send: vi.fn(), beforeInstall: vi.fn() })
    expect(u.status.state).toBe('disabled')
    expect((await u.check()).state).toBe('disabled')
    expect(await u.install()).toBe(false)
  })
})

describe('createUpdater: when it last checked', () => {
  it('stamps checkedAt on each answer and keeps it from one status to the next', async () => {
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.on.mockClear()
    process.env.TESSEL_UPDATE_TEST = '1'
    try {
      const send = vi.fn()
      const u = createUpdater({ log: { info() {}, warn() {}, error() {} }, send, beforeInstall: vi.fn() })
      const on = (name) => autoUpdater.on.mock.calls.find((c) => c[0] === name)[1]
      expect(u.status.checkedAt).toBeUndefined()
      on('update-not-available')()
      const at = u.status.checkedAt
      expect(at).toBeGreaterThan(0)
      on('checking-for-update')()
      expect(u.status).toMatchObject({ state: 'checking', checkedAt: at })
      on('error')(new Error('offline'))
      expect(u.status.state).toBe('error')
      expect(u.status.checkedAt).toBeGreaterThanOrEqual(at)
      expect(send).toHaveBeenLastCalledWith('update:status', expect.objectContaining({ checkedAt: u.status.checkedAt }))
    } finally {
      delete process.env.TESSEL_UPDATE_TEST
    }
  })
})
