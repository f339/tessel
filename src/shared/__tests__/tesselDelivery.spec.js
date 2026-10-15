// What Tessel itself gives an agent (src/shared/tesselDelivery.js): the heads
// App.vue and the chat build, and how they are recognised in the agent's file.
import { describe, it, expect } from 'vitest'
import {
  TEAM_TURN_HEAD,
  channelHead,
  isTesselDelivery,
  leadHead,
  reviewRequest,
  teammateHead
} from '../tesselDelivery'

describe('tesselDelivery', () => {
  it('builds exactly the heads App.vue types', () => {
    expect(leadHead('Ada')).toBe('[From your lead Ada]')
    expect(teammateHead('Bob', 'Core')).toBe('[From Bob, team "Core"]')
    expect(channelHead('Bob', 'Core', 'm1', 'm0')).toBe(
      '[From Bob, team "Core", message m1, reply to m0]'
    )
    expect(channelHead('Bob', 'Core', 'm2')).toBe('[From Bob, team "Core", message m2]')
    expect(channelHead('Bob', 'Core', 'm3', undefined)).toBe('[From Bob, team "Core", message m3]')
    expect(reviewRequest('Bob', ' in C:\\p', ' (branch b)')).toBe(
      'Please review the changes Bob made in C:\\p (branch b). Run git status and git diff there to see them. Point out bugs, risky changes and missing tests, with file and line references. Do not modify any files; only report.'
    )
  })

  it('knows them, names with "]" or a quote included, and nothing you would type', () => {
    for (const text of [
      '[Tessel] You have 2 new team messages: read them with team_inbox.',
      '[Tessel task] Build it',
      '[Tessel worker brief]\nYou are working inside Tessel.',
      '[Tessel → you, message n-123456789012345678901234567890] Team renamed',
      `${leadHead('Ada')} Ship it.`,
      `${leadHead('A]da')} Ship it.`,
      `${teammateHead('Bob', 'Core')} Done?`,
      `${teammateHead('B]ob', 'Co"re')} Done?`,
      `  ${channelHead('Bob', 'Co"re', 'm1', 'm0')} Done?`,
      reviewRequest('another agent'),
      `${TEAM_TURN_HEAD}\n\n[from Bob] hi`
    ])
      expect(isTesselDelivery(text)).toBe(true)
    for (const text of [
      'Please review the changes I made',
      '[From the docs] a quote',
      "[From your lead's notes] a quote",
      '[Image #1] look',
      'Tessel is great',
      '[Tesselation] art',
      'Team messages for you are where?'
    ])
      expect(isTesselDelivery(text)).toBe(false)
  })
})
