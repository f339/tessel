// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { apiKeyFor, createSignIns, createCountAuths } from '../contextCost/auth'

const KEY = 'sk-ant-api03-REAL-KEY-123456'

describe('API keys: never a gateway key to the official host', () => {
  it('uses the key only when no base URL of that provider is set', () => {
    expect(apiKeyFor('anthropic', ['ANTHROPIC_API_KEY'], { ANTHROPIC_API_KEY: KEY })).toBe(KEY)
    expect(apiKeyFor('anthropic', ['ANTHROPIC_API_KEY'], { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'https://gateway.corp/v1' })).toBe(null)
    // The base URL in Claude's settings env counts too.
    expect(apiKeyFor('anthropic', ['ANTHROPIC_API_KEY'], { ANTHROPIC_API_KEY: KEY }, [{ ANTHROPIC_BASE_URL: 'https://gw' }])).toBe(null)
    expect(apiKeyFor('openai', ['OPENAI_API_KEY'], { OPENAI_API_KEY: 'sk-proj-abcdefgh', OPENAI_BASE_URL: 'http://localhost:4000' })).toBe(null)
    expect(apiKeyFor('google', ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], { GOOGLE_API_KEY: 'AIza-12345678' })).toBe('AIza-12345678')
    expect(apiKeyFor('xai', ['XAI_API_KEY'], { XAI_API_KEY: 'short' })).toBe(null) // not a key
    expect(apiKeyFor('xai', ['XAI_API_KEY'], {})).toBe(null)
  })
})

describe('sign-ins: only when switched on, dropped once switched off', () => {
  it('carries each call’s switches, and allowed() turns false after a switch-off', () => {
    const signIns = createSignIns()
    const first = signIns.take({ claudeSignIn: true })
    expect(first.claudeSignIn).toBe(true)
    expect(first.allowed('claude')).toBe(true)
    expect(first.allowed('gemini')).toBe(false)
    const off = signIns.take({ claudeSignIn: false })
    expect(off.claudeSignIn).toBe(false)
    expect(first.allowed('claude')).toBe(false) // the earlier call's counts stop
    const again = signIns.take({ claudeSignIn: true })
    expect(again.allowed('claude')).toBe(true)
    expect(first.allowed('claude')).toBe(false) // still the old epoch
  })

  it('gives the Claude and Gemini logins only with their switch, keys first', async () => {
    const claudeLogin = vi.fn(async () => ({ ok: true, headers: { Authorization: 'Bearer oat' } }))
    const geminiLogin = vi.fn(async () => ({ headers: { Authorization: 'Bearer ya29' } }))
    let env = {}
    const auths = createCountAuths({ env: () => env, claudeLogin, geminiLogin })
    expect(await auths.anthropic({ claudeSignIn: false })).toEqual({ ok: false, code: 'noKey' })
    expect(await auths.google({ geminiSignIn: false })).toEqual({ ok: false, code: 'noKey' })
    expect(claudeLogin).not.toHaveBeenCalled()
    expect(geminiLogin).not.toHaveBeenCalled()
    expect(await auths.anthropic({ claudeSignIn: true })).toEqual({ ok: true, kind: 'oauth', headers: { Authorization: 'Bearer oat' } })
    expect(await auths.google({ geminiSignIn: true })).toEqual({ ok: true, kind: 'oauth', headers: { Authorization: 'Bearer ya29' } })
    env = { ANTHROPIC_API_KEY: KEY }
    expect(await auths.anthropic({ claudeSignIn: true })).toEqual({ ok: true, kind: 'apiKey', headers: { 'x-api-key': KEY } })
    // A gateway's key: not used, and without the switch no sign-in either.
    env = { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'https://gw' }
    expect(await auths.anthropic({ claudeSignIn: false })).toEqual({ ok: false, code: 'noKey' })
  })
})
