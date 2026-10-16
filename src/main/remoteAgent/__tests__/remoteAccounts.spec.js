// @vitest-environment node
// Accounts of the agents on an SSH host: remoteAccounts.sh (part of the
// remote session's prelude) on a POSIX sh playing the host, its answer read
// by parseAccounts, the account folders Tessel makes there, and the service
// main runs (cache, confirmation, launch prefix). No token may ever come out.
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createRemoteSession, sessionArgs, FUNCTIONS, prelude } from '../../remoteShell'
import { spawnSync } from 'child_process'
import {
  parseAccounts,
  parsePaneProcess,
  parseDiag,
  folderIdOf,
  chatsOnLogin,
  shellQuote,
  createRemoteAccounts,
  publicDetection,
  folderPrefix,
  copyPolicy,
  entryState,
  ACCOUNT_FUNCTIONS,
  ACCOUNTS_SHELL
} from '../remoteAccounts'
import { gitSh, fakeSshLaunch, posixPath } from '../../__tests__/fixtures/fakeSsh'

const SECRETS = [
  'sk-ant-oat01-SECRETACCESS',
  'sk-ant-ort01-SECRETREFRESH',
  'sk-ant-api03-SECRETAPIKEY',
  'SECRET-CODEX-ACCESS',
  'SECRET-CODEX-REFRESH',
  'SECRETSIGNATURE',
  'sk-proj-SECRETOPENAI',
  'SECRET-GEMINI-ACCESS',
  'SECRET-GEMINI-REFRESH',
  'SECRET-MCP-ENV',
  'SECRET-GROK-KEY',
  'SECRET-KIMI',
  'SECRET-OPENCODE'
]
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
const idToken = (claims) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.SECRETSIGNATURE`

function write(home, rel, value) {
  const file = join(home, ...rel.split('/'))
  fs.mkdirSync(join(file, '..'), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

// A host's home with every agent signed in, secrets in all the fields that
// are not kept, and two folders Tessel made (one signed in, one new).
function seedHome(home) {
  write(home, '.claude.json', {
    numStartups: 12,
    primaryApiKey: 'sk-ant-api03-SECRETAPIKEY',
    oauthAccount: {
      accountUuid: '1f0c6d1e-1111-4111-8111-111111111111',
      emailAddress: 'Coreine13@gmail.com',
      organizationUuid: '2f0c6d1e-2222-4222-8222-222222222222',
      displayName: 'Coreine',
      organizationName: "coreine13@gmail.com's Organization",
      billingType: 'stripe_subscription'
    },
    mcpServers: { other: { command: 'x', env: { TOKEN: 'SECRET-MCP-ENV' } } },
    projects: { '/home/u/p': { allowedTools: [] } }
  })
  write(home, '.claude/.credentials.json', {
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-SECRETACCESS',
      refreshToken: 'sk-ant-ort01-SECRETREFRESH',
      expiresAt: 1760000000000,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
      rateLimitTier: 'default_claude_pro'
    }
  })
  write(home, '.codex/auth.json', {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken({ email: 'dev@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: '3f0c6d1e-3333-4333-8333-333333333333', workspace_name: 'Team X' } }),
      access_token: 'SECRET-CODEX-ACCESS',
      refresh_token: 'SECRET-CODEX-REFRESH',
      account_id: '3f0c6d1e-3333-4333-8333-333333333333'
    },
    last_refresh: '2026-10-01T00:00:00Z'
  })
  write(home, '.gemini/google_accounts.json', { active: 'g@example.com', old: [] })
  write(home, '.gemini/oauth_creds.json', { access_token: 'SECRET-GEMINI-ACCESS', refresh_token: 'SECRET-GEMINI-REFRESH' })
  write(home, '.copilot/config.json', { last_logged_in_user: { host: 'https://github.com', login: 'octocat' }, logged_in_users: [{ host: 'https://github.com', login: 'octocat' }] })
  write(home, '.grok/auth.json', { 'https://auth.x.ai': { key: 'SECRET-GROK-KEY', email: 'grok@example.com' } })
  write(home, '.kimi-code/credentials/kimi-code.json', { access_token: 'SECRET-KIMI' })
  write(home, '.local/share/opencode/auth.json', { anthropic: { type: 'oauth', refresh: 'SECRET-OPENCODE', access: 'SECRET-OPENCODE' } })
  // A Claude account folder Tessel made, signed in to another account.
  write(home, '.tessel-server/accounts/claude/abc123/.tessel-account', 'tessel-account claude abc123\n')
  write(home, '.tessel-server/accounts/claude/abc123/.claude.json', { oauthAccount: { accountUuid: '9f0c6d1e-9999-4999-8999-999999999999', emailAddress: 'work@corp.example', organizationName: 'Corp' } })
  write(home, '.tessel-server/accounts/claude/abc123/.credentials.json', { claudeAiOauth: { accessToken: 'sk-ant-oat01-SECRETACCESS', refreshToken: 'sk-ant-ort01-SECRETREFRESH', subscriptionType: 'max' } })
  // A folder someone else made there (no marker): never Tessel's.
  write(home, '.tessel-server/accounts/claude/zzz999/.claude.json', { oauthAccount: { emailAddress: 'nope@example.com' } })
  // A new Codex folder, nobody signed in yet.
  write(home, '.tessel-server/accounts/codex/def456/.tessel-account', 'tessel-account codex def456\n')
}

describe('parseAccounts', () => {
  it('keeps known keys of the right shape, per record', () => {
    const out = parseAccounts(
      [
        '@h Linux /home/u',
        '@a claude default - 1700000000 /home/u/.claude',
        'v email Coreine13@Gmail.com',
        'v org coreine13@gmail.com\'s Organization',
        'v plan pro',
        'v cred file',
        'v accessToken sk-ant-oat01-SECRET',
        'v plan max',
        '@a codex tessel def456 - /home/u/.tessel-server/accounts/codex/def456',
        '@a opencode default - - /home/u/.local/share/opencode',
        'v provider anthropic oauth',
        'v provider bad name oauth'
      ].join('\n')
    )
    expect(out.os).toBe('Linux')
    expect(out.home).toBe('/home/u')
    expect(out.entries).toEqual([
      { agent: 'claude', scope: 'default', id: null, dir: '/home/u/.claude', mtimeMs: 1700000000000, email: 'coreine13@gmail.com', org: "coreine13@gmail.com's Organization", plan: 'pro', cred: 'file' },
      { agent: 'codex', scope: 'tessel', id: 'def456', dir: '/home/u/.tessel-server/accounts/codex/def456', mtimeMs: null },
      { agent: 'opencode', scope: 'default', id: null, dir: '/home/u/.local/share/opencode', mtimeMs: null, providers: [{ name: 'anthropic', type: 'oauth' }] }
    ])
  })

  it('refuses unknown agents and scopes, relative folders, a tessel id that is not one, and bad values', () => {
    const out = parseAccounts(
      [
        '@a evil default - - /x',
        '@a claude root - - /x',
        '@a claude default - - relative/dir',
        '@a claude tessel ../x - /x',
        '@a gemini tessel abc - /x',
        '@a claude default abc - /x',
        '@a claude default - - /ok',
        'v email not-an-email',
        'v plan <script>',
        'v org \u0001',
        'v method token',
        'v cred keychain'
      ].join('\n')
    )
    expect(out.entries).toEqual([{ agent: 'claude', scope: 'default', id: null, dir: '/ok', mtimeMs: null }])
  })

  it('a missing or empty answer, or a malformed one, is no account and never throws', () => {
    expect(parseAccounts('')).toEqual({ os: null, home: null, entries: [], loginEnv: undefined, envOverrides: { claude: [], codex: [] } })
    expect(parseAccounts(null)).toEqual({ os: null, home: null, entries: [], loginEnv: undefined, envOverrides: { claude: [], codex: [] } })
    expect(parseAccounts('garbage\n@a\nv email x@y.z\n@h').entries).toEqual([])
  })

  it('reads the login shell’s folders and exports, a folder that lost its marker, and settings overrides', () => {
    const out = parseAccounts(
      [
        '@e claude /opt/claude-alt',
        '@e codex -',
        '@o claude key',
        '@o claude token',
        '@o claude secret-value',
        '@o codex key',
        '@a claude orphan zzz999 - /home/u/.tessel-server/accounts/claude/zzz999',
        'v email b@example.com',
        'v cred file',
        'v override helper',
        'v override key',
        'v override sk-ant-x',
        '@a gemini orphan abc - /x'
      ].join('\n')
    )
    expect(out.loginEnv).toEqual({ claude: '/opt/claude-alt', codex: null })
    expect(out.envOverrides).toEqual({ claude: ['key', 'token'], codex: ['key'] })
    expect(out.entries).toEqual([{ agent: 'claude', scope: 'orphan', id: 'zzz999', dir: '/home/u/.tessel-server/accounts/claude/zzz999', mtimeMs: null, email: 'b@example.com', cred: 'file', override: ['helper', 'key'] }])
    expect(parseAccounts('@h Linux /h').loginEnv).toBeUndefined()
  })

  it('names: invisible and direction characters removed; an id is a UUID; nothing that looks like a key or token, in any field', () => {
    const rlo = String.fromCharCode(0x202e)
    const c1 = String.fromCharCode(0x9b)
    const zw = String.fromCharCode(0x200b)
    const out = parseAccounts(
      [
        '@a claude tessel abc123 1 /home/u/.tessel-server/accounts/claude/abc123',
        `v email moc.elpmaxe${rlo}@evil.example`,
        `v org Acme${c1}31m${zw} Corp`,
        'v name \u0000\u001b[2Jx',
        'v __proto__ x',
        'v constructor x',
        'v email second@x.com',
        '@a codex default - 1 /home/u/.codex',
        'v account sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrst',
        'v plan sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXY',
        'v org ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        'v email sk-ant-x@evil.example',
        'v mode something',
        'v site javascript:alert(1)',
        'v login gho_secret'
      ].join('\n')
    )
    const [a, b] = out.entries
    expect(a.email).toBe('moc.elpmaxe@evil.example')
    expect(a.org).toBe('Acme31m Corp')
    expect(a.name).toBe('[2Jx')
    expect(Object.keys(a)).not.toContain('__proto__')
    expect(Object.getPrototypeOf(a)).toBe(Object.prototype)
    expect(b).toEqual({ agent: 'codex', scope: 'default', id: null, dir: '/home/u/.codex', mtimeMs: 1000 })
    const shown = JSON.stringify(publicDetection({ ok: true, hostId: 'h', at: 1, ...out }))
    for (const bad of ['sk-proj', 'sk-ant', 'ghp_', 'gho_', rlo, c1, zw, '\u001b']) expect(shown).not.toContain(bad)
  })

  it('decodes JSON escapes in names', () => {
    const out = parseAccounts('@a claude default - - /h\nv org Caf\\u00e9 Team')
    expect(out.entries[0].org).toBe('Café Team')
  })

  // A property over many random answers: whatever a host prints, a value
  // under a key that is not kept never comes out.
  it('never lets a value under another key through (property)', () => {
    const keys = ['accessToken', 'refreshToken', 'token', 'key', 'id_token', 'apiKey', 'password', 'secret', 'Authorization', 'email ', 'v', '']
    let seed = 7
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let round = 0; round < 300; round++) {
      const secret = `SECRET${round}x${rnd(1e6)}`
      const lines = ['@a claude default - - /home/u/.claude']
      for (let i = 0; i < 12; i++) {
        const pick = rnd(6)
        if (pick === 0) lines.push(`v ${keys[rnd(keys.length)]} ${secret}`)
        else if (pick === 1) lines.push(`${secret}`)
        else if (pick === 2) lines.push(`@a ${secret} default - - /x`)
        else if (pick === 3) lines.push(`v email ${secret}`)
        else if (pick === 4) lines.push(`v plan ${secret}!`)
        else lines.push(`v provider ${secret} ${secret}`)
      }
      const shown = JSON.stringify(publicDetection({ ok: true, hostId: 'h', at: 1, ...parseAccounts(lines.join('\n')) }))
      expect(shown).not.toContain(secret)
    }
  })
})

describe('entryState, folderPrefix, copyPolicy', () => {
  it('names the state of a sign-in', () => {
    expect(entryState({ cred: 'file', email: 'a@b.co' })).toBe('signed-in')
    expect(entryState({ method: 'apikey' })).toBe('signed-in')
    expect(entryState({ email: 'a@b.co' })).toBe('profile')
    expect(entryState({})).toBe('empty')
    expect(entryState({ login: 'octocat' })).toBe('signed-in')
  })
  it('a launch prefix only for a folder Tessel made, of that agent and id', () => {
    expect(folderPrefix('claude', '/home/u/.tessel-server/accounts/claude/abc123', 'abc123')).toBe("CLAUDE_CONFIG_DIR='/home/u/.tessel-server/accounts/claude/abc123' ")
    expect(folderPrefix('codex', '/home/u/.tessel-server/accounts/codex/def456', 'def456')).toBe("CODEX_HOME='/home/u/.tessel-server/accounts/codex/def456' ")
    expect(folderPrefix('claude', '/home/u/.claude', 'abc123')).toBeNull()
    expect(folderPrefix('claude', "/home/o'x/.tessel-server/accounts/claude/abc123", 'abc123')).toBe("CLAUDE_CONFIG_DIR='/home/o'\\''x/.tessel-server/accounts/claude/abc123' ")
    expect(folderPrefix('claude', '/home/u/.tessel-server/accounts/codex/abc123', 'abc123')).toBeNull()
    expect(folderPrefix('gemini', '/home/u/.tessel-server/accounts/gemini/abc123', 'abc123')).toBeNull()
    expect(folderPrefix('claude', 'relative/.tessel-server/accounts/claude/abc123', 'abc123')).toBeNull()
    // Never a backslash or a ! (fish and csh read them inside quotes), a control or direction character.
    expect(folderPrefix('claude', '/home/a\\b/.tessel-server/accounts/claude/abc123', 'abc123')).toBeNull()
    expect(folderPrefix('claude', '/home/hey!/.tessel-server/accounts/claude/abc123', 'abc123')).toBeNull()
    expect(folderPrefix('claude', `/home/u${String.fromCharCode(0x9b)}/.tessel-server/accounts/claude/abc123`, 'abc123')).toBeNull()
    expect(folderPrefix('claude', `/home/u${String.fromCharCode(0x202e)}x/.tessel-server/accounts/claude/abc123`, 'abc123')).toBeNull()
    expect(folderPrefix('claude', '/home/josé dupont/.tessel-server/accounts/claude/abc123', 'abc123')).toBe("CLAUDE_CONFIG_DIR='/home/josé dupont/.tessel-server/accounts/claude/abc123' ")
  })
  it.skipIf(!gitSh())('a home with a quote, parentheses, $ or #: quoted so the shell gets the folder exactly', () => {
    for (const home of ["/home/o'brien", '/home/u (work) #1', '/home/u$(id)`id`', "/srv/it's'here"]) {
      const dir = `${home}/.tessel-server/accounts/claude/abc123`
      const prefix = folderPrefix('claude', dir, 'abc123')
      expect(prefix).toBe(`CLAUDE_CONFIG_DIR=${shellQuote(dir)} `)
      const r = spawnSync(gitSh(), ['-c', `${prefix}sh -c 'printf %s "$CLAUDE_CONFIG_DIR"'`], { encoding: 'utf8' })
      expect(r.stdout).toBe(dir)
    }
  })

  it('the chats main stops before a login is removed: only those it sees on that host, agent and account', () => {
    const chats = [
      { paneId: 'pane-a', agent: 'claude', hostId: 'ssh-1', hostAccount: 'abc123' },
      { paneId: 'pane-b', agent: 'claude', hostId: 'ssh-1', hostAccount: null },
      { paneId: 'pane-c', agent: 'claude', hostId: 'ssh-2', hostAccount: 'abc123' },
      { paneId: 'pane-d', agent: 'codex', hostId: 'ssh-1', hostAccount: 'abc123' },
      { paneId: 'pane-e', agent: 'claude', hostId: null, hostAccount: null }
    ]
    const ids = ['pane-a', 'pane-b', 'pane-c', 'pane-d', 'pane-e']
    expect(chatsOnLogin(chats, ids, { hostId: 'ssh-1', agent: 'claude', account: 'abc123' })).toEqual(['pane-a'])
    expect(chatsOnLogin(chats, ids, { hostId: 'ssh-1', agent: 'claude', account: null })).toEqual(['pane-b'])
    expect(chatsOnLogin(chats, ['pane-c'], { hostId: 'ssh-1', agent: 'claude', account: 'abc123' })).toEqual([])
  })

  it('copying a sign-in to a host is refused for every agent, with the reason', () => {
    for (const agent of ['claude', 'codex', 'gemini']) {
      const p = copyPolicy(agent)
      expect(p.allowed).toBe(false)
      expect(p.reason).toMatch(/single-use token/)
    }
  })
  it('the prelude defines every account function it allows', () => {
    for (const fn of ACCOUNT_FUNCTIONS) {
      expect(FUNCTIONS.has(fn)).toBe(true)
      expect(ACCOUNTS_SHELL).toContain(`${fn}() {`)
    }
    expect(prelude('0'.repeat(32))).toContain('__t_accts() {')
    expect(ACCOUNTS_SHELL).not.toContain('\r')
  })
})

describe('createRemoteAccounts', () => {
  const answer = (lines) => ({ rc: 0, out: Buffer.from(lines.join('\n') + '\n') })
  function make({ run, confirm = async () => true, afterChange = vi.fn(), now = () => 1000 } = {}) {
    const calls = []
    const service = createRemoteAccounts({
      run: async (hostId, fn, args, opts) => {
        calls.push({ hostId, fn, args, opts })
        return run ? run(fn, args) : answer(['@h Linux /home/u'])
      },
      label: (h) => `Host ${h}`,
      confirm,
      afterChange,
      now,
      newId: () => 'a1b2c3'
    })
    return { service, calls, afterChange }
  }

  it('detects once per time window, shares a read in flight, and refreshes on demand', async () => {
    let clock = 1000
    const { service, calls } = make({ now: () => clock, run: () => answer(['@h Linux /home/u', '@a claude default - - /home/u/.claude', 'v email a@b.co', 'v cred file']) })
    const [a, b] = await Promise.all([service.detect('ssh-1'), service.detect('ssh-1')])
    expect(a).toBe(b)
    expect(a.entries[0]).toMatchObject({ agent: 'claude', email: 'a@b.co' })
    await service.detect('ssh-1')
    expect(calls.filter((c) => c.fn === '__t_accts')).toHaveLength(1)
    expect(calls[0].args).toEqual(['login'])
    clock += 60_000
    await service.detect('ssh-1')
    await service.detect('ssh-1', { fresh: true })
    expect(calls.filter((c) => c.fn === '__t_accts')).toHaveLength(3)
  })

  it('asks the login shell once per connection, then passes what it said; again only on a refresh you ask for, or after the host was found disconnected', async () => {
    let connected = true
    const { service, calls } = make({
      run: (fn, args) =>
        !connected
          ? { notConnected: true, error: 'not connected' }
          : args[0] === 'login'
            ? answer(['@h Linux /home/u', '@e claude /opt/claude-alt', '@e codex -', '@o claude key', '@a claude env - - /opt/claude-alt', 'v email alt@example.com'])
            : answer(['@h Linux /home/u', '@a claude env - - /opt/claude-alt', 'v email alt@example.com'])
    })
    const first = await service.detect('ssh-1')
    expect(first.envOverrides).toEqual({ claude: ['key'], codex: [] })
    await service.detect('ssh-1', { fresh: true })
    await service.detect('ssh-1', { fresh: true })
    const asked = () => calls.filter((c) => c.fn === '__t_accts').map((c) => c.args)
    expect(asked()).toEqual([['login'], ['dirs', '/opt/claude-alt', '-'], ['dirs', '/opt/claude-alt', '-']])
    // What the login shell exports stays known between its runs.
    expect((await service.detect('ssh-1', { fresh: true })).envOverrides).toEqual({ claude: ['key'], codex: [] })
    await service.detect('ssh-1', { relogin: true })
    expect(asked().at(-1)).toEqual(['login'])
    connected = false
    expect(await service.detect('ssh-1', { fresh: true })).toMatchObject({ ok: false, notConnected: true })
    connected = true
    await service.detect('ssh-1', { fresh: true })
    expect(asked().at(-1)).toEqual(['login'])
  })

  it('new folders and launches are rate-limited per host; a host with too many folders says so', async () => {
    let clock = 0
    const { service } = make({ now: () => clock, run: (fn, args) => (fn === '__t_acctmk' ? { rc: 0, out: Buffer.from(`/home/u/.tessel-server/accounts/${args[0]}/${args[1]}\n`) } : answer([])) })
    for (let i = 0; i < 6; i++) expect((await service.create('ssh-1', 'claude')).ok).toBe(true)
    expect(await service.create('ssh-1', 'claude')).toMatchObject({ ok: false, error: expect.stringContaining('Too many new accounts') })
    expect((await service.create('ssh-2', 'claude')).ok).toBe(true)
    clock += 11 * 60_000
    expect((await service.create('ssh-1', 'claude')).ok).toBe(true)
    for (let i = 0; i < 30; i++) expect((await service.launchEnv('ssh-1', 'claude', 'abc123')).ok).toBe(true)
    expect(await service.launchEnv('ssh-1', 'claude', 'abc123')).toMatchObject({ ok: false })
    const full = make({ run: () => ({ rc: 97, out: Buffer.from('') }) }).service
    expect(await full.create('ssh-1', 'codex')).toMatchObject({ ok: false, error: expect.stringContaining('too many account folders') })
  })

  it('a host that is not connected, or fails, says so (never throws), per host', async () => {
    const { service } = make({ run: (fn) => (fn === '__t_accts' ? { notConnected: true, error: 'not connected' } : null) })
    expect(await service.detect('ssh-1')).toMatchObject({ ok: false, notConnected: true })
    const broken = make({ run: () => { throw new Error('boom') } }).service
    expect(await broken.detect('ssh-2')).toMatchObject({ ok: false })
    const bad = make({ run: () => ({ rc: 97, out: Buffer.from('') }) }).service
    expect(await bad.detect('ssh-3')).toMatchObject({ ok: false, error: expect.stringContaining('Host ssh-3') })
    expect(await bad.detect('../x')).toMatchObject({ ok: false })
  })

  it('makes a new folder, then runs the install again (team tools in it)', async () => {
    const { service, calls, afterChange } = make({ run: (fn, args) => (fn === '__t_acctmk' ? { rc: 0, out: Buffer.from(`/home/u/.tessel-server/accounts/${args[0]}/${args[1]}\n`) } : answer([])) })
    const res = await service.create('ssh-1', 'claude')
    expect(res).toEqual({ ok: true, id: 'a1b2c3', dir: '/home/u/.tessel-server/accounts/claude/a1b2c3' })
    expect(calls.find((c) => c.fn === '__t_acctmk').args).toEqual(['claude', 'a1b2c3', 'new'])
    expect(afterChange).toHaveBeenCalledWith('ssh-1')
    expect(await service.create('ssh-1', 'gemini')).toMatchObject({ ok: false })
  })

  it('a folder answer that is not the one asked for is refused', async () => {
    const { service } = make({ run: () => ({ rc: 0, out: Buffer.from('/home/u/.claude\n') }) })
    expect(await service.create('ssh-1', 'claude')).toMatchObject({ ok: false })
    expect(await service.launchEnv('ssh-1', 'claude', 'a1b2c3')).toMatchObject({ ok: false })
  })

  it('the launch env of a folder: repaired first (never made), its prefix', async () => {
    const { service, calls } = make({ run: (fn, args) => ({ rc: 0, out: Buffer.from(`/home/u/.tessel-server/accounts/${args[0]}/${args[1]}\n`) }) })
    expect(await service.launchEnv('ssh-1', 'codex', 'def456')).toEqual({ ok: true, prefix: "CODEX_HOME='/home/u/.tessel-server/accounts/codex/def456' ", dir: '/home/u/.tessel-server/accounts/codex/def456', name: 'CODEX_HOME' })
    expect(calls[0].args).toEqual(['codex', 'def456'])
    const gone = make({ run: () => ({ rc: 91, out: Buffer.from('') }) }).service
    expect(await gone.launchEnv('ssh-1', 'claude', 'abc123')).toMatchObject({ ok: false, missing: true })
    expect(await service.launchEnv('ssh-1', 'claude', '../../x')).toMatchObject({ ok: false })
  })

  it('the host’s default account (signedIn): only a folder signed in there, checked as it starts', async () => {
    const { service, calls } = make({ run: (fn, args) => ({ rc: 0, out: Buffer.from(`/home/u/.tessel-server/accounts/${args[0]}/${args[1]}\n`) }) })
    expect((await service.launchEnv('ssh-1', 'claude', 'abc123', { signedIn: true })).ok).toBe(true)
    expect(calls[0].args).toEqual(['claude', 'abc123', 'signed'])
    // Anything but a plain true: an ordinary launch (a sign-in pane starts on an empty folder).
    await service.launchEnv('ssh-1', 'claude', 'abc123', { signedIn: 'yes' })
    expect(calls[1].args).toEqual(['claude', 'abc123'])
    const out = make({ run: () => ({ rc: 92, out: Buffer.from('') }) }).service
    expect(await out.launchEnv('ssh-1', 'claude', 'abc123', { signedIn: true })).toMatchObject({ ok: false, signedOut: true, error: expect.stringContaining('signed out') })
  })

  it('a home whose name the command cannot carry: said clearly; a folder just made there is taken away again', async () => {
    const calls = []
    const service = createRemoteAccounts({
      run: async (hostId, fn, args) => {
        calls.push(`${fn} ${args.join(' ')}`)
        return { rc: 0, out: Buffer.from(`/home/hey!/.tessel-server/accounts/${args[0]}/${args[1]}\n`) }
      },
      label: () => 'box',
      newId: () => 'a1b2c3'
    })
    expect(await service.launchEnv('ssh-1', 'claude', 'abc123')).toMatchObject({ ok: false, error: expect.stringContaining('Account folders cannot be used on box') })
    expect(await service.create('ssh-1', 'claude')).toMatchObject({ ok: false, error: expect.stringContaining('home folder') })
    expect(calls).toContain('__t_acctrm claude a1b2c3')
  })

  it('removing a folder: nothing happens without your yes', async () => {
    const confirm = vi.fn(async () => false)
    const { service, calls } = make({ confirm })
    expect(await service.remove('ssh-1', 'claude', 'abc123')).toEqual({ ok: false, cancelled: true })
    expect(confirm).toHaveBeenCalledWith({ kind: 'remove', host: 'Host ssh-1', agent: 'claude', email: null, panes: 0 })
    expect(calls.some((c) => c.fn === '__t_acctrm')).toBe(false)
    const thrower = make({ confirm: async () => { throw new Error('no window') } })
    expect(await thrower.service.remove('ssh-1', 'claude', 'abc123')).toMatchObject({ cancelled: true })
    expect(thrower.calls).toHaveLength(0)
  })

  it('removing a folder after yes: names the account, refuses a folder Tessel did not make', async () => {
    const confirm = vi.fn(async () => true)
    let rc = 0
    const { service, calls, afterChange } = make({
      confirm,
      run: (fn) => (fn === '__t_accts' ? answer(['@a claude tessel abc123 - /home/u/.tessel-server/accounts/claude/abc123', 'v email work@corp.example']) : { rc, out: Buffer.from('') })
    })
    await service.detect('ssh-1')
    expect(await service.remove('ssh-1', 'claude', 'abc123')).toEqual({ ok: true })
    expect(confirm.mock.calls[0][0]).toMatchObject({ email: 'work@corp.example' })
    expect(calls.find((c) => c.fn === '__t_acctrm').args).toEqual(['claude', 'abc123'])
    expect(afterChange).toHaveBeenCalled()
    rc = 98
    expect(await service.remove('ssh-1', 'claude', 'abc123')).toMatchObject({ ok: false, error: expect.stringContaining('not made by Tessel') })
  })

  it('the panes still on the login are stopped after your yes and before the host is touched; not stopped: nothing removed', async () => {
    const order = []
    let stopOk = true
    const service = createRemoteAccounts({
      run: async (hostId, fn, args) => {
        order.push(`run ${fn} ${args.join(' ')}`)
        return { rc: 0, out: Buffer.from('') }
      },
      confirm: async (q) => {
        order.push(`confirm ${q.kind} ${q.panes}`)
        return true
      },
      stopPanes: async (hostId, ids, login) => {
        order.push(`stop ${ids.join(',')} ${login.agent}/${login.account}`)
        return { ok: stopOk }
      }
    })
    expect(await service.remove('ssh-1', 'claude', 'abc123', { panes: ['pane-a', 'pane-b', 'bad id', 'pane-a'] })).toEqual({ ok: true })
    expect(order).toEqual(['confirm remove 2', 'stop pane-a,pane-b claude/abc123', 'run __t_acctrm claude abc123'])
    order.length = 0
    stopOk = false
    expect(await service.signOut('ssh-1', 'codex', { panes: ['pane-c'] })).toMatchObject({ ok: false, error: expect.stringContaining('did not stop') })
    expect(order).toEqual(['confirm signOut 1', 'stop pane-c codex/null'])
    order.length = 0
    stopOk = true
    // A folder that lost its marker: removed as such (its own dialog).
    expect(await service.remove('ssh-1', 'claude', 'zzz999', { orphan: true })).toEqual({ ok: true })
    expect(order).toEqual(['confirm removeOrphan 0', 'run __t_acctrm claude zzz999 orphan'])
  })

  it('on a Mac, signing Claude Code out says its Keychain login stays', async () => {
    const asked = []
    const service = createRemoteAccounts({
      run: async (hostId, fn) => (fn === '__t_accts' ? { rc: 0, out: Buffer.from('@h Darwin /Users/u\n') } : { rc: 0, out: Buffer.from('') }),
      confirm: async (q) => (asked.push(q), true)
    })
    await service.detect('ssh-mac')
    expect(await service.signOut('ssh-mac', 'claude')).toEqual({ ok: true, keychain: true })
    expect(asked[0]).toMatchObject({ kind: 'signOut', keychain: true })
    expect(await service.signOut('ssh-mac', 'codex')).toEqual({ ok: true })
  })

  it('signing out of the agent’s own login: only after yes', async () => {
    const no = make({ confirm: async () => false })
    expect(await no.service.signOut('ssh-1', 'claude')).toMatchObject({ cancelled: true })
    expect(no.calls).toHaveLength(0)
    const yes = make({ confirm: async () => true, run: () => ({ rc: 0, out: Buffer.from('') }) })
    expect(await yes.service.signOut('ssh-1', 'codex')).toEqual({ ok: true })
    expect(yes.calls[0]).toMatchObject({ fn: '__t_acctout', args: ['codex'] })
    expect(await yes.service.signOut('ssh-1', 'gemini')).toMatchObject({ ok: false })
  })
})

describe.skipIf(!gitSh())('remoteAccounts.sh on a POSIX sh (fake ssh)', () => {
  let dir
  let session
  afterEach(() => {
    if (session) session.close('done')
    session = null
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    dir = null
  })
  async function open(home, extraEnv = {}) {
    const launch = fakeSshLaunch({ home })
    session = createRemoteSession({
      file: launch.file,
      args: sessionArgs(launch.args),
      env: { SystemRoot: process.env.SystemRoot || '', PATH: process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin', SHELL: '/usr/bin/false', ...extraEnv },
      spawnImpl: launch.spawnImpl
    })
    await session.start()
    return session
  }

  it('reads each agent’s account, Tessel’s folders, and never a token', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-accts-'))
    seedHome(dir)
    const s = await open(dir)
    const res = await s.run('__t_accts', ['login'], { cap: 256 * 1024, timeoutMs: 30000 })
    expect(res.rc).toBe(0)
    const raw = res.out.toString('utf8')
    // Nothing secret even leaves the host.
    for (const secret of SECRETS) expect(raw).not.toContain(secret)
    const parsed = parseAccounts(raw)
    const home = posixPath(dir)
    expect(parsed.home).toBe(home)
    const by = (agent, scope = 'default') => parsed.entries.find((e) => e.agent === agent && e.scope === scope)
    expect(by('claude')).toMatchObject({ email: 'coreine13@gmail.com', org: "coreine13@gmail.com's Organization", orgId: '2f0c6d1e-2222-4222-8222-222222222222', account: '1f0c6d1e-1111-4111-8111-111111111111', name: 'Coreine', plan: 'pro', tier: 'default_claude_pro', cred: 'file', method: 'apikey', dir: `${home}/.claude` })
    expect(by('codex')).toMatchObject({ email: 'dev@example.com', plan: 'plus', org: 'Team X', account: '3f0c6d1e-3333-4333-8333-333333333333', cred: 'file', dir: `${home}/.codex` })
    expect(by('codex').method).toBeUndefined()
    expect(by('gemini')).toMatchObject({ email: 'g@example.com', cred: 'file' })
    expect(by('copilot')).toMatchObject({ login: 'octocat', site: 'https://github.com' })
    expect(by('grok')).toMatchObject({ email: 'grok@example.com', cred: 'file' })
    expect(by('kimi')).toMatchObject({ cred: 'file' })
    expect(by('opencode').providers).toEqual([{ name: 'anthropic', type: 'oauth' }])
    expect(by('claude', 'tessel')).toMatchObject({ id: 'abc123', email: 'work@corp.example', org: 'Corp', plan: 'max', cred: 'file' })
    expect(by('codex', 'tessel')).toMatchObject({ id: 'def456' })
    expect(entryState(by('codex', 'tessel'))).toBe('empty')
    // Not Tessel's (no marker): not listed.
    expect(parsed.entries.some((e) => e.email === 'nope@example.com')).toBe(false)
    const shown = JSON.stringify(publicDetection({ ok: true, hostId: 'h', at: 1, ...parsed }))
    for (const secret of SECRETS) expect(shown).not.toContain(secret)
  }, 60000)

  it('the login shell’s CLAUDE_CONFIG_DIR is read too; a login shell that hangs is given up (no timeout command needed)', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-accts-'))
    const home = posixPath(dir)
    write(dir, 'alt/.claude.json', { oauthAccount: { emailAddress: 'alt@example.com' } })
    // A login shell whose profile sets CLAUDE_CONFIG_DIR (called as `envsh -lc '<cmd>'`).
    write(dir, 'envsh', `#!/bin/sh\nCLAUDE_CONFIG_DIR='${home}/alt' CODEX_HOME= exec /bin/sh -c "$2"\n`)
    fs.chmodSync(join(dir, 'envsh'), 0o755)
    let s = await open(dir, { SHELL: `${home}/envsh` })
    let res = await s.run('__t_accts', ['login'], { cap: 64 * 1024, timeoutMs: 30000 })
    expect(parseAccounts(res.out.toString('utf8')).entries).toMatchObject([{ agent: 'claude', scope: 'env', dir: `${home}/alt`, email: 'alt@example.com' }])
    session.close('done')
    write(dir, 'hangsh', '#!/bin/sh\necho half a line\nsleep 40\n')
    fs.chmodSync(join(dir, 'hangsh'), 0o755)
    write(dir, '.claude.json', { oauthAccount: { emailAddress: 'me@example.com' } })
    s = await open(dir, { SHELL: `${home}/hangsh` })
    const t0 = Date.now()
    res = await s.run('__t_accts', ['login'], { cap: 64 * 1024, timeoutMs: 30000 })
    expect(Date.now() - t0).toBeLessThan(20000)
    expect(res.rc).toBe(0)
    expect(parseAccounts(res.out.toString('utf8')).entries.map((e) => e.email)).toContain('me@example.com')
  }, 60000)

  it('missing and malformed files: no account, no error', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-accts-'))
    const s = await open(dir)
    let res = await s.run('__t_accts', ['login'], { cap: 64 * 1024, timeoutMs: 30000 })
    expect(res.rc).toBe(0)
    expect(parseAccounts(res.out.toString('utf8')).entries).toEqual([])
    write(dir, '.claude.json', '{ not json "accessToken": "sk-ant-oat01-SECRETACCESS"')
    write(dir, '.codex/auth.json', '{"tokens": {"id_token": "not-a-jwt", "refresh_token": ""}}')
    res = await s.run('__t_accts', [], { cap: 64 * 1024, timeoutMs: 30000 })
    expect(res.rc).toBe(0)
    const raw = res.out.toString('utf8')
    expect(raw).not.toContain('SECRET')
    const parsed = parseAccounts(raw)
    expect(parsed.entries.map((e) => [e.agent, e.scope, entryState(e)])).toEqual([
      ['claude', 'default', 'empty'],
      ['codex', 'default', 'empty']
    ])
  }, 60000)

  it('makes an account folder with its marker, repairs it, never adopts a folder it did not make, and removes only its own', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-accts-'))
    write(dir, '.claude/settings.json', { hooks: {} })
    write(dir, '.codex/config.toml', 'model = "x"\n')
    const s = await open(dir)
    const home = posixPath(dir)
    // Repair only: a folder that is not there is not made.
    let res = await s.run('__t_acctmk', ['claude', 'abc123'], { cap: 8192, timeoutMs: 30000 })
    expect(res.rc).toBe(91)
    expect(fs.existsSync(join(dir, '.tessel-server', 'accounts', 'claude', 'abc123'))).toBe(false)
    res = await s.run('__t_acctmk', ['claude', 'abc123', 'new'], { cap: 8192, timeoutMs: 30000 })
    expect(res.rc).toBe(0)
    expect(res.out.toString('utf8').trim()).toBe(`${home}/.tessel-server/accounts/claude/abc123`)
    const folder = join(dir, '.tessel-server', 'accounts', 'claude', 'abc123')
    expect(fs.readFileSync(join(folder, '.tessel-account'), 'utf8')).toBe('tessel-account claude abc123\n')
    // Its conversations are the default folder's (linked; a copy on a sh without links).
    expect(fs.existsSync(join(folder, 'projects'))).toBe(true)
    expect(fs.existsSync(join(folder, 'settings.json'))).toBe(true)
    expect(fs.existsSync(join(folder, '.credentials.json'))).toBe(false)
    expect((await s.run('__t_acctmk', ['claude', 'abc123'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(0)
    // Bad agents and ids never reach a path.
    expect((await s.run('__t_acctmk', ['gemini', 'abc123', 'new'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(90)
    expect((await s.run('__t_acctmk', ['claude', '../x', 'new'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(90)
    // A folder there without Tessel's marker: never adopted, never removed.
    write(dir, '.tessel-server/accounts/claude/zzz999/keep.txt', 'mine')
    expect((await s.run('__t_acctmk', ['claude', 'zzz999', 'new'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(98)
    expect((await s.run('__t_acctrm', ['claude', 'zzz999'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(98)
    expect(fs.readFileSync(join(dir, '.tessel-server', 'accounts', 'claude', 'zzz999', 'keep.txt'), 'utf8')).toBe('mine')
    // Its own: removed, the default folder untouched.
    expect((await s.run('__t_acctrm', ['claude', 'abc123'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(0)
    expect(fs.existsSync(folder)).toBe(false)
    expect(fs.existsSync(join(dir, '.claude', 'settings.json'))).toBe(true)
    expect(fs.existsSync(join(dir, '.claude', 'projects'))).toBe(true)
    expect((await s.run('__t_acctrm', ['claude', 'abc123'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(91)
  }, 60000)

  it('a Codex folder keeps its conversations when removed (moved to the default folder), and its rollouts are found', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-accts-'))
    const s = await open(dir)
    expect((await s.run('__t_acctmk', ['codex', 'def456', 'new'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(0)
    const id = '0199a213-81c0-7800-8aa1-bbab2a035a53'
    write(dir, `.tessel-server/accounts/codex/def456/sessions/2026/10/16/rollout-2026-10-16T10-00-00-${id}.jsonl`, '{"type":"session_meta"}\n')
    // The model reader finds a rollout in an account folder (remoteShell.js __t_tfile).
    const found = await s.run('__t_tread', ['codex', id, '-', '4096'], { cap: 8192, timeoutMs: 30000 })
    expect(found.rc).toBe(0)
    expect(found.out.toString('utf8')).toContain('session_meta')
    expect((await s.run('__t_acctrm', ['codex', 'def456'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(0)
    expect(fs.existsSync(join(dir, '.codex', 'sessions', '2026', '10', '16', `rollout-2026-10-16T10-00-00-${id}.jsonl`))).toBe(true)
  }, 60000)

  it('signing out removes the agent’s credentials file only', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-accts-'))
    seedHome(dir)
    const s = await open(dir)
    expect((await s.run('__t_acctout', ['claude'], { cap: 4096, timeoutMs: 30000 })).rc).toBe(0)
    expect(fs.existsSync(join(dir, '.claude', '.credentials.json'))).toBe(false)
    expect(fs.existsSync(join(dir, '.claude.json'))).toBe(true)
    expect((await s.run('__t_acctout', ['claude'], { cap: 4096, timeoutMs: 30000 })).rc).toBe(91)
    expect((await s.run('__t_acctout', ['gemini'], { cap: 4096, timeoutMs: 30000 })).rc).toBe(90)
  }, 60000)

  it('the login shell runs once: later checks pass its folders back and never run the profile; its exports are reported by presence only', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-accts-'))
    const home = posixPath(dir)
    write(dir, 'alt/.claude.json', { oauthAccount: { emailAddress: 'alt@example.com' } })
    write(dir, 'profsh', `#!/bin/sh\necho run >>"$HOME/runs"\nANTHROPIC_API_KEY=sk-ant-SECRETKEY CLAUDE_CONFIG_DIR='${home}/alt' exec /bin/sh -c "$2"\n`)
    fs.chmodSync(join(dir, 'profsh'), 0o755)
    const s = await open(dir, { SHELL: `${home}/profsh` })
    const first = await s.run('__t_accts', ['login'], { cap: 64 * 1024, timeoutMs: 30000 })
    const raw = first.out.toString('utf8')
    expect(raw).not.toContain('SECRETKEY')
    const parsed = parseAccounts(raw)
    expect(parsed.loginEnv).toEqual({ claude: `${home}/alt`, codex: null })
    expect(parsed.envOverrides.claude).toEqual(['key'])
    for (let i = 0; i < 2; i++) {
      const again = await s.run('__t_accts', ['dirs', `${home}/alt`, '-'], { cap: 64 * 1024, timeoutMs: 30000 })
      expect(parseAccounts(again.out.toString('utf8')).entries.find((e) => e.scope === 'env')).toMatchObject({ email: 'alt@example.com' })
    }
    expect(fs.readFileSync(join(dir, 'runs'), 'utf8').trim().split('\n')).toHaveLength(1)
  }, 60000)

  it('a profile step that hangs is ended with its shell (nothing left running after the time limit)', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-accts-'))
    const home = posixPath(dir)
    write(dir, 'slowsh', '#!/bin/sh\n( sleep 9; echo orphan >>"$HOME/slow-alive" )\nexec /bin/sh -c "$2"\n')
    fs.chmodSync(join(dir, 'slowsh'), 0o755)
    const s = await open(dir, { SHELL: `${home}/slowsh` })
    const t0 = Date.now()
    const res = await s.run('__t_accts', ['login'], { cap: 64 * 1024, timeoutMs: 30000 })
    expect(res.rc).toBe(0)
    expect(Date.now() - t0).toBeLessThan(15000)
    await new Promise((r) => setTimeout(r, 10000))
    expect(fs.existsSync(join(dir, 'slow-alive'))).toBe(false)
  }, 60000)

  it('removal: the sign-in goes first and the folder is moved aside; one an agent wrote again shows as left over, and only that way it is removed', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-accts-'))
    const s = await open(dir)
    const D = join(dir, '.tessel-server', 'accounts', 'claude', 'abc123')
    expect((await s.run('__t_acctmk', ['claude', 'abc123', 'new'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(0)
    write(dir, '.tessel-server/accounts/claude/abc123/.credentials.json', { claudeAiOauth: { accessToken: 'sk-ant-oat-FAKE', refreshToken: 'sk-ant-ort-FAKE', subscriptionType: 'max' } })
    write(dir, '.tessel-server/accounts/claude/abc123/.claude.json', { oauthAccount: { emailAddress: 'b@example.com' } })
    // A removal cut short before: its leftover goes with the next one.
    write(dir, '.tessel-server/accounts/.trash-claude-old-1/.tessel-account', 'tessel-account claude old\n')
    expect((await s.run('__t_acctrm', ['claude', 'abc123'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(0)
    expect(fs.existsSync(D)).toBe(false)
    expect(fs.readdirSync(join(dir, '.tessel-server', 'accounts')).filter((n) => n.startsWith('.trash'))).toEqual([])
    // The still-running agent writes again (a token refresh).
    write(dir, '.tessel-server/accounts/claude/abc123/.credentials.json', { claudeAiOauth: { accessToken: 'sk-ant-oat-FAKE2', refreshToken: 'sk-ant-ort-FAKE2' } })
    write(dir, '.tessel-server/accounts/claude/abc123/.claude.json', { oauthAccount: { emailAddress: 'b@example.com' } })
    const listed = await s.run('__t_accts', [], { cap: 64 * 1024, timeoutMs: 30000 })
    expect(listed.out.toString('utf8')).not.toContain('FAKE2')
    expect(parseAccounts(listed.out.toString('utf8')).entries.find((e) => e.scope === 'orphan')).toMatchObject({ agent: 'claude', id: 'abc123', email: 'b@example.com', cred: 'file' })
    // Not as a folder of Tessel's (no marker), nor launched.
    expect((await s.run('__t_acctrm', ['claude', 'abc123'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(98)
    expect((await s.run('__t_acctmk', ['claude', 'abc123'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(91)
    expect((await s.run('__t_acctrm', ['claude', 'abc123', 'orphan'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(0)
    expect(fs.existsSync(D)).toBe(false)
    // A folder there with no sign-in and no marker is no left-over: never removed.
    write(dir, '.tessel-server/accounts/claude/mine01/notes.txt', 'mine')
    expect((await s.run('__t_acctrm', ['claude', 'mine01', 'orphan'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(98)
    expect(fs.existsSync(join(dir, '.tessel-server', 'accounts', 'claude', 'mine01', 'notes.txt'))).toBe(true)
  }, 60000)

  it('a removed folder leaves its conversations and prompt history to the agent’s own folder', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-accts-'))
    const s = await open(dir)
    expect((await s.run('__t_acctmk', ['codex', 'def456', 'new'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(0)
    write(dir, '.tessel-server/accounts/codex/def456/archived_sessions/rollout-a.jsonl', '{"type":"session_meta"}\n')
    write(dir, '.tessel-server/accounts/codex/def456/history.jsonl', '{"text":"account prompt"}\n')
    write(dir, '.tessel-server/accounts/codex/def456/auth.json', { tokens: { refresh_token: 'SECRET-R' } })
    write(dir, '.codex/history.jsonl', '{"text":"own prompt"}\n')
    expect((await s.run('__t_acctrm', ['codex', 'def456'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(0)
    expect(fs.existsSync(join(dir, '.codex', 'archived_sessions', 'rollout-a.jsonl'))).toBe(true)
    expect(fs.readFileSync(join(dir, '.codex', 'history.jsonl'), 'utf8')).toBe('{"text":"own prompt"}\n{"text":"account prompt"}\n')
    expect(fs.existsSync(join(dir, '.codex', 'auth.json'))).toBe(false)
    expect((await s.run('__t_acctmk', ['claude', 'abc123', 'new'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(0)
    write(dir, '.tessel-server/accounts/claude/abc123/history.jsonl', '{"display":"claude prompt"}\n')
    expect((await s.run('__t_acctrm', ['claude', 'abc123'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(0)
    expect(fs.readFileSync(join(dir, '.claude', 'history.jsonl'), 'utf8')).toContain('claude prompt')
  }, 60000)

  it('settings that override the sign-in are reported by presence only', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-accts-'))
    write(dir, '.claude.json', { oauthAccount: { emailAddress: 'me@example.com' } })
    write(dir, '.claude/settings.json', { apiKeyHelper: '/usr/local/bin/get-key', env: { ANTHROPIC_API_KEY: 'sk-ant-api03-SECRETKEY', ANTHROPIC_BASE_URL: 'https://gw.example' } })
    const s = await open(dir)
    const res = await s.run('__t_accts', [], { cap: 64 * 1024, timeoutMs: 30000 })
    const raw = res.out.toString('utf8')
    expect(raw).not.toContain('SECRETKEY')
    expect(raw).not.toContain('get-key')
    expect(parseAccounts(raw).entries.find((e) => e.agent === 'claude').override).toEqual(['helper', 'key', 'gateway'])
  }, 60000)

  it('only folders it lists count toward its limit; at most 30 folders are made per agent', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-accts-'))
    for (let i = 0; i < 55; i++) fs.mkdirSync(join(dir, '.tessel-server', 'accounts', 'claude', `junk${i}`), { recursive: true })
    write(dir, '.tessel-server/accounts/claude/zzzz99/.tessel-account', 'tessel-account claude zzzz99\n')
    const s = await open(dir)
    const res = await s.run('__t_accts', [], { cap: 64 * 1024, timeoutMs: 30000 })
    expect(parseAccounts(res.out.toString('utf8')).entries.filter((e) => e.scope === 'tessel').map((e) => e.id)).toEqual(['zzzz99'])
    expect((await s.run('__t_acctmk', ['claude', 'one000', 'new'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(97)
    expect(fs.existsSync(join(dir, '.tessel-server', 'accounts', 'claude', 'one000'))).toBe(false)
  }, 60000)

  it('an unmarked folder holding only an API key is a left-over sign-in; removal deletes .claude.json first; a check or a launch cleans removal leftovers', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-accts-'))
    write(dir, '.tessel-server/accounts/claude/def456/.claude.json', { primaryApiKey: 'sk-ant-api03-FAKEKEY', oauthAccount: { emailAddress: 'c@example.com' } })
    const s = await open(dir)
    let res = await s.run('__t_accts', [], { cap: 64 * 1024, timeoutMs: 30000 })
    expect(res.out.toString('utf8')).not.toContain('FAKEKEY')
    expect(parseAccounts(res.out.toString('utf8')).entries.find((e) => e.id === 'def456')).toMatchObject({ scope: 'orphan', method: 'apikey', email: 'c@example.com' })
    expect((await s.run('__t_acctrm', ['claude', 'def456', 'orphan'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(0)
    expect(fs.existsSync(join(dir, '.tessel-server', 'accounts', 'claude', 'def456'))).toBe(false)
    // A removal cut short after its move: the leftover goes at the next check...
    write(dir, '.tessel-server/accounts/.trash-claude-aaa111-1/.claude.json', { primaryApiKey: 'sk-ant-api03-FAKEKEY' })
    res = await s.run('__t_accts', [], { cap: 64 * 1024, timeoutMs: 30000 })
    expect(res.out.toString('utf8')).not.toContain('aaa111')
    expect(fs.existsSync(join(dir, '.tessel-server', 'accounts', '.trash-claude-aaa111-1'))).toBe(false)
    // ...or at the next launch on a folder.
    write(dir, '.tessel-server/accounts/.trash-codex-bbb222-1/auth.json', { OPENAI_API_KEY: 'sk-proj-FAKE' })
    expect((await s.run('__t_acctmk', ['claude', 'ccc333', 'new'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(0)
    expect(fs.existsSync(join(dir, '.tessel-server', 'accounts', '.trash-codex-bbb222-1'))).toBe(false)
    // A folder Tessel made: its .claude.json (profile, API key) goes with its sign-in.
    write(dir, '.tessel-server/accounts/claude/ccc333/.claude.json', { primaryApiKey: 'sk-ant-api03-FAKEKEY' })
    write(dir, '.claude/.credentials.json', { claudeAiOauth: { refreshToken: 'sk-ant-ort-OWN' } })
    expect((await s.run('__t_acctrm', ['claude', 'ccc333'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(0)
    expect(fs.existsSync(join(dir, '.claude', '.credentials.json'))).toBe(true)
  }, 60000)

  it('the watchdog freezes the whole tree and ends it parent first: a parent cannot start a fallback when its child ends', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-accts-'))
    const home = posixPath(dir)
    write(dir, 'fallsh', `#!/bin/sh\nsh -c 'sleep 20 || { (sleep 3; echo late >>"$HOME/late") </dev/null >/dev/null 2>&1 & }'\nexec /bin/sh -c "$2"\n`)
    fs.chmodSync(join(dir, 'fallsh'), 0o755)
    const s = await open(dir, { SHELL: `${home}/fallsh` })
    const res = await s.run('__t_accts', ['login'], { cap: 64 * 1024, timeoutMs: 30000 })
    expect(res.rc).toBe(0)
    await new Promise((r) => setTimeout(r, 5000))
    expect(fs.existsSync(join(dir, 'late'))).toBe(false)
  }, 60000)
})

// The user's report (1.16.0): a Claude pane on its account folder showed
// "not signed in yet", then only "Max". Claude Code 2.1 keeps oauthAccount in
// <CLAUDE_CONFIG_DIR>/.claude.json with a nested ccOnboardingFlags object,
// which the flat-object pattern never matched; right after a /login its
// subscriptionType is null until its profile is fetched.
describe.skipIf(!gitSh())('a folder after a fresh /login, as Claude Code 2.1 leaves it (fake ssh)', () => {
  let dir
  let session
  afterEach(() => {
    if (session) session.close('done')
    session = null
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    dir = null
  })
  async function open(home, extraEnv = {}) {
    const launch = fakeSshLaunch({ home })
    session = createRemoteSession({
      file: launch.file,
      args: sessionArgs(launch.args),
      env: { SystemRoot: process.env.SystemRoot || '', PATH: process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin', SHELL: '/usr/bin/false', ...extraEnv },
      spawnImpl: launch.spawnImpl
    })
    await session.start()
    return session
  }
  const folder = (id = 'bd93c7f5566d') => `.tessel-server/accounts/claude/${id}`
  function seedFolder(home, { plan = 'max', profile = true } = {}) {
    write(home, `${folder()}/.tessel-account`, 'tessel-account claude bd93c7f5566d\n')
    write(home, `${folder()}/.credentials.json`, { claudeAiOauth: { accessToken: 'sk-ant-oat01-SECRETA', refreshToken: 'sk-ant-ort01-SECRETR', expiresAt: 1790000000000, scopes: ['user:inference', 'user:profile'], subscriptionType: plan, rateLimitTier: plan ? 'default_claude_max_20x' : null } })
    write(home, `${folder()}/.claude.json`, {
      numStartups: 1,
      installMethod: 'native',
      mcpServers: { 'tessel-team': { type: 'stdio', command: '/usr/bin/node', args: ['/home/u/.tessel-server/bin/tessel-shim.cjs', 'mcp'] } },
      oauthAccount: profile
        ? {
            accountUuid: '1f0c6d1e-1111-4111-8111-111111111111',
            emailAddress: 'coreine13@gmail.com',
            organizationUuid: '2f0c6d1e-2222-4222-8222-222222222222',
            displayName: 'Coreine',
            hasExtraUsageEnabled: false,
            billingType: 'stripe_subscription',
            accountCreatedAt: '2025-01-01T00:00:00Z',
            subscriptionCreatedAt: '2025-02-01T00:00:00Z',
            ccOnboardingFlags: { seen: true, nested: { note: 'a "}{" in a string' } },
            claudeCodeTrialEndsAt: null,
            seatTier: null,
            planDisplayName: 'Claude Max',
            profileFetchedAt: 1790000000000,
            organizationRole: 'admin',
            organizationName: "coreine13@gmail.com's Organization"
          }
        : { accountUuid: '1f0c6d1e-1111-4111-8111-111111111111', emailAddress: 'coreine13@gmail.com', organizationUuid: '2f0c6d1e-2222-4222-8222-222222222222' },
      projects: { '/home/u/app': { allowedTools: [], hasTrustDialogAccepted: true } }
    })
    for (const n of ['projects', 'todos']) fs.mkdirSync(join(home, folder(), n), { recursive: true })
  }

  it('reads the account (email, organization, plan) from a nested oauthAccount; never a token', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-login-'))
    seedFolder(dir)
    const s = await open(dir)
    const res = await s.run('__t_accts', [], { cap: 64 * 1024, timeoutMs: 30000 })
    const raw = res.out.toString('utf8')
    expect(raw).not.toContain('SECRET')
    expect(parseAccounts(raw).entries.find((e) => e.id === 'bd93c7f5566d')).toMatchObject({
      scope: 'tessel',
      email: 'coreine13@gmail.com',
      org: "coreine13@gmail.com's Organization",
      orgId: '2f0c6d1e-2222-4222-8222-222222222222',
      account: '1f0c6d1e-1111-4111-8111-111111111111',
      name: 'Coreine',
      planName: 'Claude Max',
      plan: 'max',
      cred: 'file'
    })
  }, 60000)

  it('right after the /login (subscriptionType still null): signed in, the account named by its email', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-login-'))
    seedFolder(dir, { plan: null, profile: false })
    const s = await open(dir)
    const e = parseAccounts((await s.run('__t_accts', [], { cap: 64 * 1024, timeoutMs: 30000 })).out.toString('utf8')).entries.find((x) => x.id === 'bd93c7f5566d')
    expect(e).toMatchObject({ email: 'coreine13@gmail.com', cred: 'file' })
    expect(e.plan).toBeUndefined()
    expect(entryState(e)).toBe('signed-in')
  }, 60000)

  it('Claude Code’s older config name in the folder (.config.json, not empty) is the one it reads: read there too', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-login-'))
    seedFolder(dir)
    write(dir, `${folder()}/.config.json`, { oauthAccount: { emailAddress: 'legacy@example.com', ccOnboardingFlags: {} } })
    const s = await open(dir)
    const e = parseAccounts((await s.run('__t_accts', [], { cap: 64 * 1024, timeoutMs: 30000 })).out.toString('utf8')).entries.find((x) => x.id === 'bd93c7f5566d')
    expect(e.email).toBe('legacy@example.com')
  }, 60000)

  it('signed: a folder signed in starts; an empty one (92) or a missing one (91) does not', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-login-'))
    seedFolder(dir)
    write(dir, `${folder('e1')}/.tessel-account`, 'tessel-account claude e1\n')
    const s = await open(dir)
    const ok = await s.run('__t_acctmk', ['claude', 'bd93c7f5566d', 'signed'], { cap: 4096, timeoutMs: 30000 })
    expect(ok.rc).toBe(0)
    expect(ok.out.toString('utf8')).toContain('/.tessel-server/accounts/claude/bd93c7f5566d')
    expect((await s.run('__t_acctmk', ['claude', 'e1', 'signed'], { cap: 4096, timeoutMs: 30000 })).rc).toBe(92)
    // Without signed (a sign-in pane): the empty folder is fine.
    expect((await s.run('__t_acctmk', ['claude', 'e1'], { cap: 4096, timeoutMs: 30000 })).rc).toBe(0)
    expect((await s.run('__t_acctmk', ['claude', 'nope1', 'signed'], { cap: 4096, timeoutMs: 30000 })).rc).toBe(91)
  }, 60000)

  it('a folder whose sign-in file is a link (made outside Tessel): flagged, and no agent started on it', async (t) => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-login-'))
    seedFolder(dir)
    write(dir, '.claude/.credentials.json', { claudeAiOauth: { accessToken: 'sk-ant-oat01-SECRETH', refreshToken: 'sk-ant-ort01-SECRETH', subscriptionType: 'pro' } })
    fs.rmSync(join(dir, folder(), '.credentials.json'))
    try {
      fs.symlinkSync(join(dir, '.claude', '.credentials.json'), join(dir, folder(), '.credentials.json'), 'file')
    } catch {
      t.skip() // no symlinks for this user on this PC
    }
    const s = await open(dir)
    const raw = (await s.run('__t_accts', [], { cap: 64 * 1024, timeoutMs: 30000 })).out.toString('utf8')
    if (!/^v linked yes$/m.test(raw)) t.skip() // the test shell does not see Windows links as links
    expect(raw).not.toContain('SECRET')
    expect(parseAccounts(raw).entries.find((e) => e.id === 'bd93c7f5566d')).toMatchObject({ linked: true })
    expect((await s.run('__t_acctmk', ['claude', 'bd93c7f5566d'], { cap: 4096, timeoutMs: 30000 })).rc).toBe(98)
    expect(parseDiag((await s.run('__t_acctdiag', ['claude', 'bd93c7f5566d', '-'], { cap: 16 * 1024, timeoutMs: 30000 })).out.toString('utf8'))).toMatchObject({ 'folder.credentialsLink': 'yes', 'folder.configLink': 'no' })
  }, 60000)

  it('Copy account details: yes / no only, never an email or a token', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-login-'))
    seedFolder(dir)
    const s = await open(dir)
    const res = await s.run('__t_acctdiag', ['claude', 'bd93c7f5566d', 'pane-none1'], { cap: 16 * 1024, timeoutMs: 30000 })
    const raw = res.out.toString('utf8')
    expect(raw).not.toContain('coreine13')
    expect(raw).not.toContain('SECRET')
    expect(parseDiag(raw)).toMatchObject({ 'folder.exists': 'yes', 'folder.marker': 'yes', 'folder.credentials': 'yes', 'folder.credentialsLink': 'no', 'folder.config': 'yes', 'folder.oauthAccount': 'yes', 'folder.email': 'yes', 'folder.plan': 'yes', 'home.credentials': 'no', 'process.found': 'none' })
    expect((await s.run('__t_acctdiag', ['claude', '../x', '-'], { cap: 4096, timeoutMs: 30000 })).rc).toBe(90)
  }, 60000)

  it('the folder a pane’s agent really runs on: its process’s CLAUDE_CONFIG_DIR (or none), found by the pane id it carries', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-login-'))
    const home = posixPath(dir)
    write(dir, 'bin/claude', '#!/bin/sh\nsleep 25\n')
    fs.chmodSync(join(dir, 'bin', 'claude'), 0o755)
    const { spawn } = await import('child_process')
    const sh = gitSh()
    const env = { ...process.env, TESSEL_PANE_ID: 'pane-acct1', CLAUDE_CONFIG_DIR: `${home}/.tessel-server/accounts/claude/bd93c7f5566d` }
    const off = { ...process.env, TESSEL_PANE_ID: 'pane-acct2' }
    delete off.CLAUDE_CONFIG_DIR
    const a = spawn(sh, [`${home}/bin/claude`], { env, stdio: 'ignore' })
    const b = spawn(sh, [`${home}/bin/claude`], { env: off, stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 800))
      const s = await open(dir)
      const on = parsePaneProcess((await s.run('__t_acctpane', ['pane-acct1', 'claude'], { cap: 8192, timeoutMs: 30000 })).out.toString('utf8'))
      expect(on).toEqual({ found: 'yes', dir: `${home}/.tessel-server/accounts/claude/bd93c7f5566d` })
      expect(folderIdOf('claude', on.dir)).toBe('bd93c7f5566d')
      const plain = parsePaneProcess((await s.run('__t_acctpane', ['pane-acct2', 'claude'], { cap: 8192, timeoutMs: 30000 })).out.toString('utf8'))
      expect(plain).toEqual({ found: 'yes', dir: null })
      expect(parsePaneProcess((await s.run('__t_acctpane', ['pane-gone9', 'claude'], { cap: 8192, timeoutMs: 30000 })).out.toString('utf8'))).toEqual({ found: 'none', dir: null })
      expect((await s.run('__t_acctpane', ['bad id', 'claude'], { cap: 8192, timeoutMs: 30000 })).rc).toBe(90)
    } finally {
      a.kill()
      b.kill()
    }
  }, 60000)
})

describe('the pane’s real folder and the details, in main', () => {
  it('parses the host’s answers: a folder of Tessel’s, none, unknown; details are known keys with yes / no only', () => {
    expect(parsePaneProcess('@p 123 /home/u/.tessel-server/accounts/claude/abc123\n')).toEqual({ found: 'yes', dir: '/home/u/.tessel-server/accounts/claude/abc123' })
    expect(parsePaneProcess('@p 123 -')).toEqual({ found: 'yes', dir: null })
    expect(parsePaneProcess('@p none')).toEqual({ found: 'none', dir: null })
    expect(parsePaneProcess('garbage')).toEqual({ found: 'unknown', dir: null })
    expect(folderIdOf('claude', '/opt/claude')).toBeNull()
    expect(folderIdOf('codex', '/home/u/.tessel-server/accounts/claude/abc123')).toBeNull()
    expect(parseDiag('d folder.email yes\nd folder.email no\nd evil.key yes\nd process.found sk-ant-x\nd os Linux\nd home.email maybe')).toEqual({ 'folder.email': 'yes', os: 'Linux' })
  })

  it('paneFolder and diagnose ask the host with checked arguments', async () => {
    const calls = []
    const service = createRemoteAccounts({
      run: async (hostId, fn, args) => {
        calls.push(`${fn} ${args.join(' ')}`)
        return fn === '__t_acctpane' ? { rc: 0, out: Buffer.from('@p 42 /home/u/.tessel-server/accounts/claude/abc123\n') } : { rc: 0, out: Buffer.from('d folder.email no\n') }
      }
    })
    expect(await service.paneFolder('ssh-1', 'claude', 'pane-a1')).toEqual({ ok: true, found: 'yes', dir: '/home/u/.tessel-server/accounts/claude/abc123', folderId: 'abc123' })
    expect(await service.diagnose('ssh-1', 'claude', 'abc123', 'pane-a1')).toEqual({ ok: true, flags: { 'folder.email': 'no' } })
    expect(await service.diagnose('ssh-1', 'claude', '../x', 'bad id')).toMatchObject({ ok: true })
    expect(calls).toEqual(['__t_acctpane pane-a1 claude', '__t_acctdiag claude abc123 pane-a1', '__t_acctdiag claude - -'])
    expect(await service.paneFolder('ssh-1', 'claude', 'bad id')).toMatchObject({ ok: false })
  })
})
