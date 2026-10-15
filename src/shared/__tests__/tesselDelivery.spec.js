// What Tessel itself types into an agent's terminal (src/shared/tesselDelivery.js):
// the heads App.vue builds, and how they are recognised in the agent's file.
import { describe, it, expect } from 'vitest'
import { isTesselDelivery, leadHead, reviewRequest, teammateHead } from '../tesselDelivery'

describe('tesselDelivery', () => {
  it('builds the heads App.vue types', () => {
    expect(leadHead('Ada')).toBe('[From your lead Ada]')
    expect(teammateHead('Bob', 'Core')).toBe('[From Bob, team "Core"]')
    expect(teammateHead('Bob', 'Core', { id: 'm1', replyTo: 'm0' })).toBe(
      '[From Bob, team "Core", message m1, reply to m0]'
    )
    expect(reviewRequest('Bob', ' in C:\p', ' (branch b)')).toMatch(
      /^Please review the changes Bob made in C:\p \(branch b\)\. Run git status/
    )
  })

  it('knows them, and nothing you would type', () => {
    for (const text of [
      '[Tessel] You have 2 new team messages: read them with team_inbox.',
      '[Tessel task] Build it',
      '[Tessel worker brief]\nYou are working inside Tessel.',
      `${leadHead('Ada')} Ship it.`,
      `${teammateHead('Bob', 'Core')} Done?`,
      `  ${teammateHead('Bob', 'Core', { id: 'm1' })} Done?`,
      reviewRequest('another agent')
    ])
      expect(isTesselDelivery(text)).toBe(true)
    for (const text of [
      'Please review the changes I made',
      '[From the docs] a quote',
      '[Image #1] look',
      'Tessel is great',
      '[Tesselation] art'
    ])
      expect(isTesselDelivery(text)).toBe(false)
  })
})
