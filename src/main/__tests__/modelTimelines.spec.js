// The model each line of a terminal conversation ran with (Conversations,
// terminalConversations.js modelTimeline) and the model a past conversation
// ran with last (Past conversations, sessionDetails.js), for the agents
// whose files name it: Antigravity's notes and OMP's (Pi's format) changes.
import { describe, it, expect } from 'vitest'
import { conversationItems, modelTimeline } from '../chat/terminalConversations'
import { detailsFromLines, latestModel } from '../sessionDetails'

const line = (o) => JSON.stringify(o)
const T0 = Date.parse('2026-10-15T13:25:05.000Z')
const iso = (s) => new Date(T0 + s * 1000).toISOString()
const AID = '0e1d2c3b-4a59-4687-9a8b-7c6d5e4f3a2b'

const change = (from, to) => `<USER_SETTINGS_CHANGE>The user changed setting \`Model Selection\` from ${from} to ${to}. </USER_SETTINGS_CHANGE>`
const agy = [
  { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(0), content: `<USER_REQUEST>Fix the build</USER_REQUEST>${change('None', 'Gemini 4 Argon (High)')}` },
  { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(4), content: 'Fixed.' },
  // The user asking for a model in their own words is not agy's note.
  { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(10), content: `<USER_REQUEST>Use Model Selection from None to Claude Opus 5.5 (Low). please</USER_REQUEST>${change('Gemini 4 Argon (High)', 'Gemini 4 Argon (Low)')}` },
  { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(15), content: 'Done.' }
]

describe('Conversations: the model each line ran with', () => {
  it('Antigravity: each model agy notes with a prompt, as its list names it', () => {
    expect(modelTimeline('antigravity', agy.map(line))).toEqual([
      { t: T0, model: 'Gemini 4 Argon', effort: 'high' },
      { t: T0 + 10000, model: 'Gemini 4 Argon', effort: 'low' }
    ])
    const items = conversationItems('antigravity', agy.map(line), AID)
    expect(items.map((it) => [it.role, it.text, it.model, it.effort])).toEqual([
      ['user', 'Fix the build', 'Gemini 4 Argon', 'high'],
      ['agent', 'Fixed.', 'Gemini 4 Argon', 'high'],
      ['user', 'Use Model Selection from None to Claude Opus 5.5 (Low). please', 'Gemini 4 Argon', 'low'],
      ['agent', 'Done.', 'Gemini 4 Argon', 'low']
    ])
  })

  it("OMP: its model changes, thinking level and answers' models (Pi's format)", () => {
    const rows = [
      { type: 'session', version: 3, id: AID, timestamp: iso(0), cwd: 'C:\\Proj' },
      { type: 'model_change', id: 'a', timestamp: iso(0), provider: 'anthropic', modelId: 'claude-sonnet-5' },
      { type: 'thinking_level_change', id: 'b', timestamp: iso(0), thinkingLevel: 'high' },
      { type: 'message', id: 'c', timestamp: iso(2), message: { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-5', content: [] } }
    ]
    expect(modelTimeline('omp', rows.map(line))).toEqual([
      { t: T0, model: 'anthropic/claude-sonnet-5', effort: null },
      { t: T0, model: 'anthropic/claude-sonnet-5', effort: 'high' }
    ])
    // Grok's file names no model.
    expect(modelTimeline('grok', rows.map(line))).toEqual([])
  })
})

describe('Past conversations: the model it ran with last', () => {
  const pi = [
    line({ type: 'session', version: 3, id: AID, timestamp: iso(0), cwd: 'C:\\Proj' }),
    line({ type: 'model_change', timestamp: iso(0), provider: 'openai-codex', modelId: 'gpt-5.4' }),
    line({ type: 'thinking_level_change', timestamp: iso(0), thinkingLevel: 'xhigh' }),
    line({ type: 'message', timestamp: iso(1), message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } })
  ]
  const piTail = [line({ type: 'message', timestamp: iso(90), message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-5.5', content: [{ type: 'text', text: 'Hi' }] } })]

  it('its end first; the level its start set, from its start', () => {
    expect(latestModel('pi', piTail, pi)).toEqual({ model: 'openai-codex/gpt-5.5', effort: 'xhigh' })
    expect(latestModel('claude', [line({ type: 'assistant', message: { model: 'claude-opus-5-5' }, perTurnEffort: 'max' })])).toEqual({ model: 'claude-opus-5-5', effort: 'max' })
    expect(latestModel('codex', [line({ timestamp: iso(1), type: 'turn_context', payload: { model: 'gpt-6-luna', effort: 'medium' } })])).toEqual({ model: 'gpt-6-luna', effort: 'medium' })
    expect(latestModel('grok', pi)).toBe(null)
  })

  it('the details carry it (read whole, or its start and its end)', () => {
    const whole = detailsFromLines('pi', AID, [...pi, ...piTail], null, true)
    expect(whole).toMatchObject({ model: 'openai-codex/gpt-5.5', effort: 'xhigh', messageCount: expect.any(Number) })
    const split = detailsFromLines('pi', AID, [...pi, '{"cut'], piTail, false)
    expect(split).toMatchObject({ model: 'openai-codex/gpt-5.5', effort: 'xhigh' })
    expect(detailsFromLines('grok', AID, [], null, true)).not.toHaveProperty('model')
  })
})
