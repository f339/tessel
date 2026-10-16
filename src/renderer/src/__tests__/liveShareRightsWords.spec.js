// Live Share rights in the window (src/renderer/src/liveShareRights.js): every
// right of the shared catalog has its words, the boxes follow the catalog's
// order, and a right without words is never shown. Also the access views'
// helpers (liveShareAccess.js).
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { RIGHT_IDS } from '../../../shared/liveShareRights'
import { hasRightWords, rightWords, shownRights, rightsShort } from '../liveShareRights'
import { initials, inviteName, inviteUses, inviteExpiry, grantDiff, accessPeople, accessError } from '../liveShareAccess'
import RightsChecks from '../components/liveshare/RightsChecks.vue'

describe('rights: words for the catalog', () => {
  it('every right of the catalog has a label, a short label and a hint', () => {
    for (const id of RIGHT_IDS) {
      expect(hasRightWords(id)).toBe(true)
      const w = rightWords(id)
      expect(w.label.length).toBeGreaterThan(3)
      expect(w.short.length).toBeGreaterThan(1)
      expect(w.hint.length).toBeGreaterThan(3)
    }
    expect(shownRights().map((r) => r.id)).toEqual([...RIGHT_IDS])
  })

  it('the open right says what it means', () => {
    expect(rightWords('open').label).toBe('Can open terminals and agents on your computer (they can run commands)')
  })

  it('a right without words is never shown; unknown ids are not words', () => {
    expect(rightWords('made-up')).toBe(null)
    expect(hasRightWords('__proto__')).toBe(false)
    const w = mount(RightsChecks, { props: { rights: { type: true, made: true } } })
    expect(w.findAll('input').length).toBe(RIGHT_IDS.length)
    expect(w.findAll('input').map((x) => x.element.checked)).toEqual(RIGHT_IDS.map((id) => id === 'type'))
  })

  it('a box asks for the change and shows what the subject has until it comes back', async () => {
    const w = mount(RightsChecks, { props: { rights: { type: false }, testKey: 'x' } })
    const box = w.find('[data-test="ls-right-type-x"] input')
    box.element.checked = true
    await box.trigger('change')
    expect(w.emitted('toggle')).toEqual([['type', true]])
    expect(box.element.checked).toBe(false)
  })

  it('a short summary', () => {
    expect(rightsShort({ type: true, open: true })).toBe('Type, Open')
    expect(rightsShort({})).toBe('Watch only')
  })
})

describe('access views: helpers', () => {
  it('initials', () => {
    expect(initials('Simpa')).toBe('SI')
    expect(initials('Jean Claude')).toBe('JC')
    expect(initials('  ')).toBe('?')
    expect(initials('élodie')).toBe('ÉL')
  })

  it('an invitation’s name, uses and expiry', () => {
    expect(inviteName({ label: ' Team ' })).toBe('Team')
    expect(inviteName({ label: '', root: true })).toBe('First invite code')
    expect(inviteName({ label: '' })).toBe('Invitation')
    expect(inviteUses({ uses: 3, maxUses: 10 })).toBe('3 of 10 uses')
    expect(inviteUses({ uses: 0, maxUses: 0 })).toBe('0 uses, no limit')
    expect(inviteExpiry({ expiresAt: null }).text).toBe('No expiry')
    expect(inviteExpiry({ expiresAt: 1000 }, 2000)).toMatchObject({ text: 'Expired', expired: true })
  })

  it('what a change takes away and adds', () => {
    expect(grantDiff({ projects: ['a', 'b'], rights: { type: true, open: false } }, { projects: ['b', 'c'], rights: { type: false, open: true } })).toEqual({
      removedProjects: ['a'],
      addedProjects: ['c'],
      removedRights: ['type'],
      addedRights: ['open']
    })
  })

  it('everyone with access, a trusted person offline once', () => {
    const rows = accessPeople({
      guests: [{ id: 'g1', name: 'Bob', state: 'joined', projects: ['a'] }, { id: 'g2', name: 'Eve', state: 'waiting' }],
      offline: [{ id: 'k-1', name: 'Al', projects: [] }, { id: 'k-2', name: 'Ty', projects: ['a'], trusted: true }],
      trusted: [{ id: 't-1', name: 'Ty', projects: ['a'], online: false }, { id: 't-2', name: 'Bob', online: true }]
    })
    expect(rows.map((r) => [r.id, r.kind])).toEqual([
      ['g1', 'guest'],
      ['k-1', 'offline'],
      ['t-1', 'trusted']
    ])
  })

  it('refusals in words', () => {
    expect(accessError({ ok: false, reason: 'not-sharing' })).toBe('Start sharing first.')
    expect(accessError({ ok: false, reason: 'auto-allow' })).toMatch(/needs your yes/)
    expect(accessError(null, 'Fallback.')).toBe('Fallback.')
    expect(accessError({ ok: false, reason: 'trust-full' })).toBe('Trusted list is full (50): remove someone first.')
  })
})
