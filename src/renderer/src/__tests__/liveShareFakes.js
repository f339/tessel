// A fake window.shellApi.liveShare (src/preload: liveShare) for the Live
// Share window specs, and the status shapes of the contract (HostStatus,
// Invite, Guest, Person, Trusted).
import { vi } from 'vitest'

export const OFF_HOST = { state: 'off', projectIds: [], invites: [], guests: [], offline: [], trusted: [], presence: [], progress: null, error: null }
export const OFF_GUEST = { state: 'off', host: null, session: null, panes: [], projects: [], reason: null, rights: null, code: null, agents: null }
export const NO_RIGHTS = { type: false, open: false, close: false }

export function fakeApi() {
  const push = {}
  const offs = []
  const on = (name) => (cb) => {
    push[name] = cb
    const off = vi.fn()
    offs.push(off)
    return off
  }
  const ok = (extra = {}) => vi.fn().mockResolvedValue({ ok: true, ...extra })
  const api = {
    state: vi.fn().mockResolvedValue({ host: OFF_HOST, guest: OFF_GUEST, defaultName: 'ada' }),
    start: ok(),
    stop: ok(),
    share: ok(),
    approve: ok(),
    access: ok(),
    createInvite: ok({ invite: invite({ id: 'iv-0000000new' }) }),
    updateInvite: ok({ applied: 0 }),
    revokeInvite: ok({ removed: 0 }),
    rotateInvite: ok(),
    duplicateInvite: ok({ invite: invite({ id: 'iv-00000000dup' }) }),
    trust: ok(),
    untrust: ok(),
    renameTrusted: ok(),
    removeGuest: ok(),
    join: ok(),
    leave: ok(),
    open: ok({ asked: false }),
    onHost: on('host'),
    onGuest: on('guest'),
    onAsk: on('ask'),
    onPresence: on('presence'),
    onInviteBlocked: on('inviteBlocked')
  }
  return { api, push, offs }
}

export const invite = (over = {}) => ({
  id: 'iv-aaaaaaaaaa',
  label: 'Simpa',
  root: false,
  lifetime: 'hour',
  createdAt: Date.now(),
  expiresAt: Date.now() + 3600000,
  maxUses: 0,
  uses: 0,
  projects: ['ws-1'],
  later: false,
  rights: { ...NO_RIGHTS },
  state: 'live',
  joined: 0,
  code: 'TS1.code-a',
  ...over
})

export const guest = (over = {}) => ({
  id: 'g1',
  name: 'Bob',
  state: 'joined',
  since: 1,
  code: null,
  rights: { ...NO_RIGHTS },
  projects: ['ws-1'],
  invite: { id: 'iv-aaaaaaaaaa', label: 'Simpa' },
  trusted: false,
  trustable: true,
  ...over
})

export const trustedOne = (over = {}) => ({
  id: 't-' + 'a'.repeat(32),
  name: 'Tess',
  projects: ['ws-1'],
  rights: { ...NO_RIGHTS },
  since: Date.now() - 86400000,
  lastSeen: null,
  online: false,
  ...over
})

export const sharing = (over = {}) => ({ ...OFF_HOST, state: 'sharing', projectIds: ['ws-1', 'ws-2'], ...over })
