// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { apiKeyFor, createSignIns, createCountAuths, claudeSettingsEnvs, managedSettingsFiles } from '../contextCost/auth'

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

describe("Claude's settings: a gateway named in any of them keeps the key unused", () => {
  it('reads the env of the config folders, the project’s .claude/settings*.json and the managed settings', async () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'tessel-ctxauth-'))
    try {
      const account = join(root, 'account')
      const project = join(root, 'app')
      const managed = join(root, 'managed-settings.json')
      fs.mkdirSync(account, { recursive: true })
      fs.mkdirSync(join(project, '.claude'), { recursive: true })
      fs.writeFileSync(join(account, 'settings.json'), JSON.stringify({ env: { A: '1' } }))
      fs.writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gw.shared' } }))
      fs.writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gw.local' } }))
      fs.writeFileSync(managed, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gw.managed' } }))
      const envs = await claudeSettingsEnvs({ configDirs: [account, null], cwd: project, managed: [managed, join(root, 'none.json')] })
      expect(envs).toEqual([{ A: '1' }, { ANTHROPIC_BASE_URL: 'https://gw.managed' }, { ANTHROPIC_BASE_URL: 'https://gw.shared' }, { ANTHROPIC_BASE_URL: 'https://gw.local' }])
      // A project file behind a link to the network is not read.
      const read = vi.fn(() => null)
      await claudeSettingsEnvs({ configDirs: [], cwd: project, managed: [], read, safe: async () => false })
      expect(read).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('knows where the managed settings are on each system', () => {
    expect(managedSettingsFiles('win32', { ProgramFiles: 'D:\\Apps', ProgramData: 'D:\\Data' })).toEqual(['D:\\Apps\\ClaudeCode\\managed-settings.json', 'D:\\Data\\ClaudeCode\\managed-settings.json'])
    expect(managedSettingsFiles('darwin', {})).toEqual(['/Library/Application Support/ClaudeCode/managed-settings.json'])
    expect(managedSettingsFiles('linux', {})).toEqual(['/etc/claude-code/managed-settings.json'])
  })

  it('asks for the settings of the call’s project before every count, and uses no key when they cannot be read', async () => {
    const env = () => ({ ANTHROPIC_API_KEY: KEY })
    const seen = []
    const auths = createCountAuths({
      env,
      claudeSettingsEnv: async (opts) => {
        seen.push(opts.cwd)
        await new Promise((r) => setTimeout(r, 5)) // the account's folder, read first
        return opts.cwd === '/gw' ? [{ ANTHROPIC_BASE_URL: 'https://gw' }] : []
      },
      claudeLogin: vi.fn()
    })
    expect(await auths.anthropic({ cwd: '/plain' })).toEqual({ ok: true, kind: 'apiKey', headers: { 'x-api-key': KEY } })
    expect(await auths.anthropic({ cwd: '/gw' })).toEqual({ ok: false, code: 'noKey' })
    expect(seen).toEqual(['/plain', '/gw'])
    const broken = createCountAuths({ env, claudeSettingsEnv: async () => Promise.reject(new Error('unreadable')), claudeLogin: vi.fn() })
    expect(await broken.anthropic({})).toEqual({ ok: false, code: 'noKey' })
  })
})
