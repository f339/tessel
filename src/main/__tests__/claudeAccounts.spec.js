// @vitest-environment node
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import { join, resolve, sep } from 'path'
import { createClaudeAccounts, SHARED_FOLDERS, accountState, sharedStateKey } from '../claudeAccounts'

// These use real, fsynced files and guarded Windows paths; concurrent suite I/O
// can exceed Vitest's 5-second unit-test default.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const MARKER = '.tessel-managed-claude-auth'
const NOW = Date.parse('2026-09-28T03:00:00Z')
let root, home, userData, service, runner, selectedIdentity
const who = (name = 'managed') => ({
  accountUuid: `${name}-id`,
  emailAddress: `${name}@fixture.invalid`,
  organizationUuid: `${name}-org`,
  organizationName: `Fixture ${name}`
})
const token = (name = 'managed', suffix = 'original', expiresAt = NOW + 100000) => ({
  claudeAiOauth: {
    accessToken: `fixture-access-${name}-${suffix}`,
    refreshToken: `fixture-refresh-${name}-${suffix}`,
    expiresAt,
    subscriptionType: 'max'
  }
})
const raw = (value) => JSON.stringify(value, null, 2) + '\n'
function put(path, value) {
  fs.mkdirSync(join(path, '..'), { recursive: true })
  fs.writeFileSync(path, typeof value === 'string' ? value : raw(value))
}
const read = (path) => JSON.parse(fs.readFileSync(path, 'utf8'))
const systemDir = () => join(home, '.claude')
const credentialPath = () => join(home, '.claude', '.credentials.json')
const configPath = () => join(home, '.claude.json')
const indexPath = () => join(userData, 'claude-accounts', 'accounts.json')
const runtimePath = (name) => join(userData, 'claude-runtime-auth', name)
const authPath = (id) => join(userData, 'claude-accounts', id, 'auth')
const isLink = (path) => {
  try {
    return fs.lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
const same = (a, b) => fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase()
// Every file under a folder, never through a link or junction.
function filesUnder(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) filesUnder(path, out)
    else out.push(path)
  }
  return out
}
function create(extra = {}) {
  return createClaudeAccounts({
    userData,
    home,
    env: {},
    runLogin: runner,
    now: () => NOW,
    ...extra
  })
}
function seedSystem() {
  put(credentialPath(), token('system'))
  put(configPath(), { theme: 'dark', projects: { fixture: true }, oauthAccount: who('system') })
}
async function add(name = 'managed') {
  selectedIdentity = name
  return (await service.add()).account.id
}
// What an older version left after "selecting" an account: its login in the
// system files and a snapshot of the system's own login.
function legacySwitch(id, systemToken = null) {
  const original = fs.readFileSync(credentialPath(), 'utf8')
  const config = read(configPath())
  put(runtimePath('system-default-auth.json'), {
    version: 1,
    binding: { credentialsPath: credentialPath(), configPath: configPath() },
    credentials: original,
    oauth: { present: true, value: config.oauthAccount }
  })
  put(credentialPath(), systemToken || read(join(authPath(id), '.credentials.json')))
  put(configPath(), { ...config, oauthAccount: who('managed') })
  put(indexPath(), { ...read(indexPath()), selectedId: id })
  return original
}
beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'tessel-claude-accounts-'))
  home = join(root, 'home')
  userData = join(root, 'data')
  fs.mkdirSync(home)
  selectedIdentity = 'managed'
  runner = vi.fn(async ({ provider, home: isolated }) => {
    expect(provider).toBe('claude')
    expect(isolated).not.toBe(home)
    expect(isolated.startsWith(userData + sep)).toBe(true)
    put(join(isolated, '.credentials.json'), token(selectedIdentity))
    put(join(isolated, '.claude.json'), { oauthAccount: who(selectedIdentity) })
    return {
      ok: true,
      status: {
        loggedIn: true,
        email: `${selectedIdentity}@fixture.invalid`,
        orgId: `${selectedIdentity}-org`,
        orgName: `Fixture ${selectedIdentity}`
      }
    }
  })
  service = create()
})
afterEach(() => {
  vi.restoreAllMocks()
  const path = resolve(root)
  if (!path.startsWith(resolve(os.tmpdir()) + sep) || !path.includes('tessel-claude-accounts-'))
    throw new Error('Unsafe fixture cleanup')
  fs.rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

describe('Claude account capture and public state', () => {
  it('captures an isolated login without changing system auth or exposing tokens', async () => {
    seedSystem()
    const before = fs.readFileSync(credentialPath(), 'utf8')
    const config = fs.readFileSync(configPath(), 'utf8')
    const id = await add()
    const listing = await service.list()
    expect(listing).toMatchObject({
      provider: 'claude',
      selectedId: null,
      system: { status: 'ready' },
      accounts: [
        { id, status: 'ready', active: false, email: 'managed@fixture.invalid', plan: 'max' }
      ]
    })
    expect(JSON.stringify(listing)).not.toMatch(
      /fixture-access|fixture-refresh|credentials|oauthAccount/
    )
    expect(fs.readFileSync(credentialPath(), 'utf8')).toBe(before)
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(config)
    expect(fs.readFileSync(join(authPath(id), MARKER), 'utf8')).toBe(`${id}\n`)
    // Its own .claude.json right away: its identity, the system's shared settings.
    expect(read(join(authPath(id), '.claude.json'))).toMatchObject({ oauthAccount: who(), theme: 'dark' })
    expect(fs.readdirSync(runtimePath('')).filter((name) => name.startsWith('login-'))).toEqual([])
  })
  it('lists the system sign-in like an added account: email, organization and plan, never a token', async () => {
    seedSystem()
    const listing = await service.list()
    expect(listing.system).toEqual({
      id: null,
      label: 'System default',
      status: 'ready',
      email: 'system@fixture.invalid',
      organization: 'Fixture system',
      plan: 'max'
    })
    expect(JSON.stringify(listing)).not.toMatch(/fixture-access|fixture-refresh|system-id|accessToken/)
    // Signed out: no plan, its email still shown when Claude kept it.
    fs.unlinkSync(credentialPath())
    expect((await service.list()).system).toMatchObject({ status: 'missing', email: 'system@fixture.invalid', plan: null })
  })
  it('rejects missing/empty credentials and sanitizes login failures', async () => {
    runner.mockImplementationOnce(async () => ({
      ok: false,
      error: 'fixture-access-secret raw stderr'
    }))
    await expect(service.add()).rejects.toThrow('Claude login did not complete')
    runner.mockImplementationOnce(async ({ home: isolated }) => {
      put(join(isolated, '.credentials.json'), { claudeAiOauth: { accessToken: '' } })
      return { ok: true, status: { loggedIn: true } }
    })
    await expect(service.add()).rejects.toThrow('missing or invalid')
    expect((await service.list()).accounts).toEqual([])
  })
  it.each(['wrong-email', 'wrong-org', 'logged-out', 'credential-conflict'])(
    'requires consistent identity: %s',
    async (mode) => {
      runner.mockImplementationOnce(async ({ home: isolated }) => {
        const value = token()
        if (mode === 'credential-conflict') value.claudeAiOauth.email = 'other@fixture.invalid'
        put(join(isolated, '.credentials.json'), value)
        put(join(isolated, '.claude.json'), { oauthAccount: who() })
        return {
          ok: true,
          status: {
            loggedIn: mode !== 'logged-out',
            email: mode === 'wrong-email' ? 'other@fixture.invalid' : who().emailAddress,
            orgId: mode === 'wrong-org' ? 'other-org' : who().organizationUuid
          }
        }
      })
      await expect(service.add()).rejects.toThrow('identity could not be verified')
      expect((await service.list()).accounts).toHaveLength(0)
    }
  )
  it('preserves a prior login after failed or wrong-account reauthentication', async () => {
    const id = await add()
    const before = fs.readFileSync(join(authPath(id), '.credentials.json'), 'utf8')
    selectedIdentity = 'other'
    await expect(service.reauthenticate(id)).rejects.toThrow('identity could not be verified')
    expect(fs.readFileSync(join(authPath(id), '.credentials.json'), 'utf8')).toBe(before)
    expect((await service.list()).accounts[0].status).toBe('ready')
  })
  it('a same-account reauthentication replaces only its own login, never the system one', async () => {
    seedSystem()
    const id = await add()
    await service.select(id)
    runner.mockImplementationOnce(async ({ home: isolated }) => {
      put(join(isolated, '.credentials.json'), token('managed', 'reauthenticated'))
      put(join(isolated, '.claude.json'), { oauthAccount: who() })
      return {
        ok: true,
        status: { loggedIn: true, email: who().emailAddress, orgId: who().organizationUuid }
      }
    })
    expect(await service.reauthenticate(id)).toMatchObject({ ok: true, restartRequired: false })
    expect(read(join(authPath(id), '.credentials.json'))).toEqual(token('managed', 'reauthenticated'))
    expect(read(credentialPath())).toEqual(token('system'))
  })
  it('keeps list responsive and waits for cancelled login runner settlement before cleanup', async () => {
    let release, entered
    const started = new Promise((resolve) => {
      entered = resolve
    })
    runner.mockImplementationOnce(
      ({ home: isolated }) =>
        new Promise((resolve) => {
          release = () => resolve({ ok: false })
          entered(isolated)
        })
    )
    const controller = new AbortController()
    const pending = service.add({ signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow('cancelled')
    const isolated = await started
    controller.abort()
    expect((await service.list()).accounts).toEqual([])
    expect(fs.existsSync(isolated)).toBe(true)
    release()
    await rejected
    expect(fs.existsSync(isolated)).toBe(false)
  })
  it.each([false, true])(
    'retains staging when process death is unconfirmed (aborted=%s)',
    async (aborted) => {
      const controller = new AbortController()
      let isolated
      runner.mockImplementationOnce(async ({ home: directory }) => {
        isolated = directory
        put(join(directory, '.credentials.json'), token('incomplete'))
        if (aborted) controller.abort()
        return { ok: false, cleanupSafe: false, error: 'raw fixture-access-secret stderr' }
      })
      await expect(service.add({ signal: controller.signal })).rejects.toThrow(
        'Temporary files were retained because process termination could not be confirmed'
      )
      expect(fs.existsSync(isolated)).toBe(true)
      expect(fs.existsSync(join(isolated, MARKER))).toBe(true)
      expect(read(join(isolated, '.credentials.json'))).toEqual(token('incomplete'))
      expect((await service.list()).accounts).toEqual([])
    }
  )
})

describe('sessions on their own account', () => {
  it('runs a managed account in its own folder, the system login with the normal environment', async () => {
    seedSystem()
    const first = await add('one'),
      second = await add('two')
    expect(await service.launchEnv()).toEqual({ ok: true, env: {}, accountId: null })
    expect(await service.launchEnv(first)).toEqual({ ok: true, env: { CLAUDE_CONFIG_DIR: authPath(first) }, accountId: first })
    // The default changes new sessions only: a saved pane restarts on its own account.
    expect(await service.select(second)).toEqual({ ok: true, selectedId: second, restartRequired: false })
    expect(await service.launchEnv()).toEqual({ ok: true, env: { CLAUDE_CONFIG_DIR: authPath(second) }, accountId: second })
    expect(await service.launchEnv(first)).toMatchObject({ ok: true, accountId: first })
    expect(await service.launchEnv(null)).toEqual({ ok: true, env: {}, accountId: null })
    expect((await service.list()).accounts.map((a) => a.active)).toEqual([false, true])
    // Each login stays in one place.
    expect(read(credentialPath())).toEqual(token('system'))
    expect(read(join(authPath(first), '.credentials.json'))).toEqual(token('one'))
    expect(read(join(authPath(second), '.credentials.json'))).toEqual(token('two'))
  })
  it('never writes the system login or settings, and copies no token across', async () => {
    seedSystem()
    put(join(systemDir(), 'settings.json'), { model: 'opus' })
    put(join(systemDir(), 'CLAUDE.md'), 'Keep the board updated.\n')
    const files = [credentialPath(), configPath(), join(systemDir(), 'settings.json'), join(systemDir(), 'CLAUDE.md')]
    const before = files.map((file) => [fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs])
    const id = await add()
    await service.select(id)
    await service.launchEnv()
    await service.launchEnv(null)
    await service.launchEnv(id)
    expect(files.map((file) => [fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs])).toEqual(before)
    for (const file of filesUnder(authPath(id)))
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(/fixture-(access|refresh)-system/)
    for (const file of filesUnder(home)) expect(fs.readFileSync(file, 'utf8')).not.toMatch(/fixture-(access|refresh)-managed/)
    for (const file of filesUnder(userData))
      if (!file.startsWith(authPath(id) + sep)) expect(fs.readFileSync(file, 'utf8')).not.toMatch(/fixture-(access|refresh)/)
  })
  it('does not rewrite anything on a repeated launch', async () => {
    seedSystem()
    const id = await add()
    await service.launchEnv(id)
    const rename = vi.spyOn(fsp, 'rename')
    const symlink = vi.spyOn(fsp, 'symlink')
    expect(await service.launchEnv(id)).toMatchObject({ ok: true })
    expect(await service.select(null)).toMatchObject({ ok: true })
    expect(rename).not.toHaveBeenCalled()
    expect(symlink).not.toHaveBeenCalled()
  })
  it('refuses a removed or signed-out account without starting it on another', async () => {
    seedSystem()
    const id = await add()
    expect(await service.launchEnv('ffffffff-ffff-4fff-8fff-ffffffffffff')).toMatchObject({
      ok: false,
      error: expect.stringContaining('no longer in Tessel')
    })
    fs.unlinkSync(join(authPath(id), '.credentials.json'))
    expect(await service.launchEnv(id)).toMatchObject({ ok: false, error: expect.stringContaining('sign in again') })
    expect((await service.list()).accounts[0].status).toBe('missing')
    put(join(authPath(id), '.credentials.json'), '{bad')
    await expect(service.launchEnv(id)).rejects.toThrow('unreadable')
    expect(await service.launchEnv(null)).toMatchObject({ ok: true, accountId: null })
  })
  it('a broken system login blocks only system sessions', async () => {
    seedSystem()
    const id = await add()
    const original = fsp.open.bind(fsp)
    vi.spyOn(fsp, 'open').mockImplementation(async (path, ...rest) => {
      if (path === credentialPath() && rest[0] === 'r')
        throw Object.assign(new Error('fixture secret'), { code: 'EACCES' })
      return original(path, ...rest)
    })
    expect((await service.list()).system.status).toBe('unknown')
    await expect(service.launchEnv(null)).rejects.toThrow('unavailable or invalid')
    expect(await service.launchEnv(id)).toMatchObject({ ok: true, accountId: id })
  })
  it('preserves an explicit null OAuth field and permits an unsigned system launch', async () => {
    put(configPath(), { oauthAccount: null, theme: 'keep' })
    expect(await service.launchEnv()).toEqual({ ok: true, env: {}, accountId: null })
    expect(read(configPath())).toEqual({ oauthAccount: null, theme: 'keep' })
  })
  it('permits System default with a valid provider-only credential document', async () => {
    put(credentialPath(), { providerCredential: 'fixture-provider-value' })
    expect((await service.list()).system.status).toBe('missing')
    expect(await service.launchEnv()).toEqual({ ok: true, env: {}, accountId: null })
    expect(read(credentialPath())).toEqual({ providerCredential: 'fixture-provider-value' })
  })
  it('removes an account (its default too) without following its shared folders', async () => {
    seedSystem()
    const id = await add()
    await service.select(id)
    await service.launchEnv()
    put(join(authPath(id), 'projects', 'p', 'kept.jsonl'), '{}\n')
    await expect(service.remove('../home')).rejects.toThrow('Unknown Claude account')
    expect(await service.remove(id)).toEqual({ ok: true, selectedId: null, restartRequired: false })
    expect(fs.existsSync(authPath(id))).toBe(false)
    expect(fs.readFileSync(join(systemDir(), 'projects', 'p', 'kept.jsonl'), 'utf8')).toBe('{}\n')
    expect((await service.list()).accounts).toEqual([])
    expect(read(credentialPath())).toEqual(token('system'))
  })
  it('uses an overridden system config folder, never the default home one', async () => {
    const override = join(root, 'custom-config')
    put(join(override, '.credentials.json'), token('custom'))
    put(join(override, '.claude.json'), { custom: 1, theme: 'custom-theme', oauthAccount: who('custom') })
    put(join(override, 'CLAUDE.md'), 'Custom memory\n')
    service = create({ env: { CLAUDE_CONFIG_DIR: override } })
    const id = await add()
    expect(await service.launchEnv(id)).toEqual({ ok: true, env: { CLAUDE_CONFIG_DIR: authPath(id) }, accountId: id })
    expect(same(join(authPath(id), 'projects'), join(override, 'projects'))).toBe(true)
    // A custom folder's memory is copied whole (no parent-folder double load).
    expect(fs.readFileSync(join(authPath(id), 'CLAUDE.md'), 'utf8')).toBe('Custom memory\n')
    expect(read(join(authPath(id), '.claude.json'))).toMatchObject({ theme: 'custom-theme', oauthAccount: who() })
    expect(read(join(override, '.claude.json'))).toEqual({ custom: 1, theme: 'custom-theme', oauthAccount: who('custom') })
    expect(fs.existsSync(systemDir())).toBe(false)
    expect(await service.launchEnv(null)).toEqual({ ok: true, env: {}, accountId: null })
    expect(await service.sessionEnv(id)).toEqual({ ok: true, env: { CLAUDE_CONFIG_DIR: override }, accountId: id })
  })
  it('reads usage in the account folder, conversations in the shared system folder', async () => {
    seedSystem()
    const first = await add('one'),
      second = await add('two')
    await service.select(first)
    const rename = vi.spyOn(fsp, 'rename')
    expect(await service.usageScope()).toEqual({
      ok: true,
      env: { CLAUDE_CONFIG_DIR: authPath(first) },
      accountId: first,
      expectedIdentity: { account: 'one-id', email: 'one@fixture.invalid', organization: 'one-org' }
    })
    expect(await service.usageScope(second)).toMatchObject({ ok: true, env: { CLAUDE_CONFIG_DIR: authPath(second) } })
    expect(await service.usageScope(null)).toEqual({ ok: true, env: {}, accountId: null, expectedIdentity: null })
    expect(await service.usageScope('ffffffff-ffff-4fff-8fff-ffffffffffff')).toMatchObject({ ok: false })
    expect(JSON.stringify(await service.usageScope(first))).not.toMatch(/fixture-access|fixture-refresh/)
    for (const [argument, id] of [
      [undefined, first],
      [second, second],
      [null, null],
      // Removed since: its conversations are still in the shared folder.
      ['ffffffff-ffff-4fff-8fff-ffffffffffff', 'ffffffff-ffff-4fff-8fff-ffffffffffff']
    ])
      expect(await service.sessionEnv(argument)).toEqual({ ok: true, env: {}, accountId: id })
    expect(await service.sessionEnv('../x')).toMatchObject({ ok: false })
    fs.unlinkSync(join(authPath(second), '.credentials.json'))
    expect(await service.usageScope(second)).toMatchObject({ ok: false })
    expect(rename).not.toHaveBeenCalled()
  })
  it('serializes changes across service instances using the same storage', async () => {
    seedSystem()
    const first = await add('one'),
      second = await add('two')
    const results = await Promise.all([service.select(first), create().select(second), service.launchEnv(first), create().launchEnv(first)])
    expect(results.every((r) => r.ok)).toBe(true)
    expect(read(indexPath()).selectedId).toBe(second)
    expect(isLink(join(authPath(first), 'projects'))).toBe(true)
  })
})

describe('the account folder before a launch', () => {
  it('links the shared folders to the system ones, creating those that are missing', async () => {
    seedSystem()
    put(join(systemDir(), 'skills', 'mine', 'SKILL.md'), 'skill')
    put(join(systemDir(), 'my-tools', 'tool.txt'), 'tool')
    for (const own of ['cache', 'sessions', 'debug', 'statsig', '.hidden']) put(join(systemDir(), own, 'x.txt'), 'private')
    const id = await add()
    await service.launchEnv(id)
    for (const name of [...SHARED_FOLDERS, 'my-tools']) {
      expect(isLink(join(authPath(id), name))).toBe(true)
      expect(fs.statSync(join(systemDir(), name)).isDirectory()).toBe(true)
      expect(same(join(authPath(id), name), join(systemDir(), name))).toBe(true)
    }
    for (const own of ['cache', 'sessions', 'debug', 'statsig', '.hidden']) expect(fs.existsSync(join(authPath(id), own))).toBe(false)
    expect(fs.readFileSync(join(authPath(id), 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('skill')
    // A conversation the account's session writes is the system's.
    put(join(authPath(id), 'projects', 'C--p', 'a.jsonl'), '{"x":1}\n')
    expect(fs.readFileSync(join(systemDir(), 'projects', 'C--p', 'a.jsonl'), 'utf8')).toBe('{"x":1}\n')
  })
  it('replaces a link to another place without touching what it pointed to', async () => {
    seedSystem()
    const id = await add()
    await service.launchEnv(id)
    const elsewhere = join(root, 'elsewhere')
    put(join(elsewhere, 'keep.txt'), 'keep')
    fs.rmdirSync(join(authPath(id), 'skills'))
    fs.symlinkSync(elsewhere, join(authPath(id), 'skills'), 'junction')
    await service.launchEnv(id)
    expect(same(join(authPath(id), 'skills'), join(systemDir(), 'skills'))).toBe(true)
    expect(fs.readFileSync(join(elsewhere, 'keep.txt'), 'utf8')).toBe('keep')
  })
  it('moves what a real folder there held into the system one, never over a file there', async () => {
    seedSystem()
    const id = await add()
    await service.launchEnv(id)
    fs.rmdirSync(join(authPath(id), 'projects'))
    put(join(authPath(id), 'projects', 'C--p', 'own.jsonl'), 'own\n')
    put(join(authPath(id), 'projects', 'C--p', 'both.jsonl'), 'account copy\n')
    put(join(systemDir(), 'projects', 'C--p', 'both.jsonl'), 'system copy\n')
    fs.rmdirSync(join(authPath(id), 'plans'))
    fs.mkdirSync(join(authPath(id), 'plans'))
    fs.rmdirSync(join(authPath(id), 'todos'))
    put(join(authPath(id), 'todos'), 'a file, not a folder')
    await service.launchEnv(id)
    expect(isLink(join(authPath(id), 'projects'))).toBe(true)
    expect(fs.readFileSync(join(systemDir(), 'projects', 'C--p', 'own.jsonl'), 'utf8')).toBe('own\n')
    expect(fs.readFileSync(join(systemDir(), 'projects', 'C--p', 'both.jsonl'), 'utf8')).toBe('system copy\n')
    expect(fs.readFileSync(join(authPath(id), 'projects.merge', 'C--p', 'both.jsonl'), 'utf8')).toBe('account copy\n')
    // An empty real folder is replaced; a file there is left alone.
    expect(isLink(join(authPath(id), 'plans'))).toBe(true)
    expect(fs.readFileSync(join(authPath(id), 'todos'), 'utf8')).toBe('a file, not a folder')
    // The conflict gone: the next launch moves the rest and removes the folder aside.
    fs.unlinkSync(join(systemDir(), 'projects', 'C--p', 'both.jsonl'))
    await service.launchEnv(id)
    expect(fs.readFileSync(join(systemDir(), 'projects', 'C--p', 'both.jsonl'), 'utf8')).toBe('account copy\n')
    expect(fs.existsSync(join(authPath(id), 'projects.merge'))).toBe(false)
  })
  it('copies the system settings at each launch (the system wins), and its memory as an import', async () => {
    seedSystem()
    put(join(systemDir(), 'settings.json'), { model: 'opus', hooks: { Stop: [] } })
    put(join(systemDir(), 'settings.local.json'), { local: true })
    put(join(systemDir(), 'keybindings.json'), [{ key: 'ctrl+k' }])
    put(join(systemDir(), 'CLAUDE.md'), 'Keep the board updated.\n')
    const id = await add()
    await service.launchEnv(id)
    for (const name of ['settings.json', 'settings.local.json', 'keybindings.json'])
      expect(fs.readFileSync(join(authPath(id), name), 'utf8')).toBe(fs.readFileSync(join(systemDir(), name), 'utf8'))
    // ~/.claude/CLAUDE.md is also read as a parent folder's: imported once, not copied.
    expect(fs.readFileSync(join(authPath(id), 'CLAUDE.md'), 'utf8')).toBe('@~/.claude/CLAUDE.md\n')
    put(join(authPath(id), 'settings.json'), { model: 'changed in a session' })
    fs.unlinkSync(join(systemDir(), 'keybindings.json'))
    await service.launchEnv(id)
    expect(read(join(authPath(id), 'settings.json'))).toEqual({ model: 'opus', hooks: { Stop: [] } })
    expect(fs.existsSync(join(authPath(id), 'keybindings.json'))).toBe(false)
  })
  it('gives the account the system user settings, never its login, ids, caches or subscription state', async () => {
    put(credentialPath(), token('system'))
    put(configPath(), {
      oauthAccount: who('system'),
      userID: 'system-user',
      machineID: 'system-machine',
      numStartups: 9,
      firstStartTime: 'then',
      primaryApiKey: 'fixture-api-key',
      customApiKeyResponses: { approved: ['fixture'] },
      cachedGrowthBookFeatures: { a: 1 },
      groveConfigCache: {},
      modelAccessCache: {},
      subscriptionNoticeCount: 2,
      hasAvailableSubscription: true,
      passesEligibilityCache: {},
      hasVisitedPasses: true,
      skillUsage: { s: 1 },
      penguinModeOrgEnabled: true,
      claudeAiMcpEverConnected: true,
      bridgeOauthDeadFailCount: 1,
      claudeCodeFirstTokenDate: 'then',
      theme: 'dark',
      hasCompletedOnboarding: true,
      opusProMigrationComplete: true,
      hasSeenTasksHint: true,
      tipsHistory: { tip: 1 },
      mcpServers: { shared: { command: 'shared' } },
      projects: { 'C:/p': { allowedTools: ['a'] }, 'C:/q': { hasTrustDialogAccepted: false, lastCost: 1 } }
    })
    const id = await add()
    put(join(authPath(id), '.claude.json'), {
      own: 1,
      theme: 'light',
      userID: 'account-user',
      mcpServers: { own: { command: 'own' } },
      projects: { 'C:/q': { hasTrustDialogAccepted: true }, 'C:/own': { x: 1 } },
      oauthAccount: { ...who(), displayName: 'Fresh' }
    })
    await service.launchEnv(id)
    expect(read(join(authPath(id), '.claude.json'))).toEqual({
      own: 1,
      theme: 'dark',
      userID: 'account-user',
      hasCompletedOnboarding: true,
      opusProMigrationComplete: true,
      hasSeenTasksHint: true,
      tipsHistory: { tip: 1 },
      mcpServers: { own: { command: 'own' }, shared: { command: 'shared' } },
      projects: {
        'C:/p': { allowedTools: ['a'] },
        'C:/q': { hasTrustDialogAccepted: true, lastCost: 1 },
        'C:/own': { x: 1 }
      },
      // Claude keeps a fresher profile there: kept while it is this account's.
      oauthAccount: { ...who(), displayName: 'Fresh' }
    })
    put(join(authPath(id), '.claude.json'), { oauthAccount: who('someone-else') })
    await service.launchEnv(id)
    expect(read(join(authPath(id), '.claude.json')).oauthAccount).toEqual(who())
  })
  it('chooses the shared keys strictly', () => {
    for (const key of ['theme', 'mcpServers', 'projects', 'hasCompletedOnboarding', 'opusProMigrationComplete', 'fable5ToFableAliasMigrationTimestamp', 'hasSeenTasksHint', 'editorMode', 'githubRepoPaths'])
      expect(sharedStateKey(key)).toBe(true)
    for (const key of ['oauthAccount', 'userID', 'machineID', 'primaryApiKey', 'customApiKeyResponses', 'cachedUsageUtilization', 'metricsStatusCache', 'groveConfigCache', 'passesUpsellSeenCount', 'hasVisitedPasses', 'subscriptionNoticeCount', 'hasAvailableSubscription', 'orgModelDefaultCache', 'penguinModeOrgEnabled', 'skillUsage', 'numStartups', 'firstStartTime', 'claudeCodeFirstTokenDate', 'bridgeOauthDeadExpiresAt', 'claudeAiMcpEverConnected', 'additionalModelOptionsAnsweredAt'])
      expect(sharedStateKey(key)).toBe(false)
    expect(accountState({ a: 1 }, null, who())).toEqual({ a: 1, oauthAccount: who() })
  })
  it('leaves its settings file alone while Claude holds its lock', async () => {
    seedSystem()
    const id = await add()
    put(join(authPath(id), '.claude.json'), { oauthAccount: who(), own: true })
    fs.mkdirSync(join(authPath(id), '.claude.json.lock'))
    expect(await service.launchEnv(id)).toMatchObject({ ok: true, accountId: id })
    expect(read(join(authPath(id), '.claude.json'))).toEqual({ oauthAccount: who(), own: true })
  })
})

describe('the older account switch, undone once', () => {
  it('puts the system login back, keeps the account refreshed meanwhile and as the default', async () => {
    seedSystem()
    const id = await add()
    const refreshed = token('managed', 'refreshed', NOW + 200000)
    const original = legacySwitch(id, refreshed)
    put(configPath(), { ...read(configPath()), theme: 'changed meanwhile' })
    const later = create()
    // Before the restore, the system row already shows the system's own login.
    expect((await later.list()).system).toMatchObject({ status: 'ready', email: 'system@fixture.invalid' })
    await later.migrate()
    expect(fs.readFileSync(credentialPath(), 'utf8')).toBe(original)
    expect(read(configPath())).toMatchObject({ theme: 'changed meanwhile', oauthAccount: who('system') })
    expect(read(join(authPath(id), '.credentials.json'))).toEqual(refreshed)
    expect(read(indexPath())).toMatchObject({ selectedId: id, perSession: true })
    expect(fs.existsSync(runtimePath('system-default-auth.json'))).toBe(false)
    expect(await later.launchEnv()).toEqual({ ok: true, env: { CLAUDE_CONFIG_DIR: authPath(id) }, accountId: id })
    // Once only: a stray snapshot never restores again over a newer system login.
    put(credentialPath(), token('new-system'))
    put(runtimePath('system-default-auth.json'), { stray: true })
    await later.migrate()
    expect(read(credentialPath())).toEqual(token('new-system'))
    expect(fs.existsSync(runtimePath('system-default-auth.json'))).toBe(false)
  })
  it.each(['other-identity', 'stale-token', 'embedded-conflict'])(
    'restores the system login without capturing unproven credentials: %s',
    async (mode) => {
      seedSystem()
      const id = await add()
      const before = read(join(authPath(id), '.credentials.json'))
      const replacement = token('unproven', 'changed', mode === 'stale-token' ? NOW - 1 : NOW + 200000)
      if (mode === 'embedded-conflict') replacement.claudeAiOauth.accountUuid = 'different-id'
      const original = legacySwitch(id, replacement)
      if (mode === 'other-identity') put(configPath(), { ...read(configPath()), oauthAccount: who('other') })
      await create().launchEnv()
      expect(read(join(authPath(id), '.credentials.json'))).toEqual(before)
      expect(fs.readFileSync(credentialPath(), 'utf8')).toBe(original)
    }
  )
  it('restores the system login when the selected account record is gone', async () => {
    seedSystem()
    const id = await add()
    legacySwitch(id)
    put(indexPath(), { ...read(indexPath()), accounts: [] })
    expect(await create().launchEnv()).toEqual({ ok: true, env: {}, accountId: null })
    expect(read(credentialPath())).toEqual(token('system'))
    expect(read(indexPath()).selectedId).toBeNull()
  })
  it('only deletes the copy of the system login when nothing was switched', async () => {
    seedSystem()
    await add()
    put(runtimePath('system-default-auth.json'), { version: 1, binding: {}, credentials: 'fixture-refresh-copy', oauth: { present: false, value: null } })
    const config = fs.readFileSync(configPath(), 'utf8')
    await create().migrate()
    expect(fs.existsSync(runtimePath('system-default-auth.json'))).toBe(false)
    expect(fs.readFileSync(configPath(), 'utf8')).toBe(config)
    expect(read(credentialPath())).toEqual(token('system'))
  })
  it('rolls the restore back when the metadata commit fails, retaining unrelated settings', async () => {
    seedSystem()
    const id = await add()
    legacySwitch(id)
    const original = fsp.rename.bind(fsp)
    let failed = false
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (to === indexPath() && !failed) {
        failed = true
        put(configPath(), { ...read(configPath()), addedDuringOperation: true })
        throw Object.assign(new Error('fixture-secret'), { code: 'EIO' })
      }
      return original(from, to)
    })
    await expect(create().migrate()).rejects.toThrow('previous login was restored')
    expect(read(credentialPath())).toEqual(token())
    expect(read(configPath())).toMatchObject({ oauthAccount: who(), addedDuringOperation: true })
    expect(read(indexPath()).perSession).toBeUndefined()
    expect(fs.existsSync(runtimePath('transaction.json'))).toBe(false)
    await create().migrate()
    expect(read(credentialPath())).toEqual(token('system'))
    expect(read(configPath())).toMatchObject({ oauthAccount: who('system'), addedDuringOperation: true })
  })
  it('retains a durable intent when rollback fails and recovers before the next launch', async () => {
    seedSystem()
    const id = await add()
    legacySwitch(id)
    const original = fsp.rename.bind(fsp)
    let credentialWrites = 0
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (to === credentialPath()) credentialWrites++
      if (to === indexPath() || (to === credentialPath() && credentialWrites > 1))
        throw Object.assign(new Error('secret'), { code: 'EIO' })
      return original(from, to)
    })
    await expect(create().migrate()).rejects.toThrow('could not be rolled back')
    expect(fs.existsSync(runtimePath('transaction.json'))).toBe(true)
    spy.mockRestore()
    expect(await create().launchEnv()).toMatchObject({ ok: true, accountId: id })
    expect(read(credentialPath())).toEqual(token('system'))
    expect(read(configPath()).oauthAccount).toEqual(who('system'))
    expect(fs.existsSync(runtimePath('transaction.json'))).toBe(false)
  })
  it('refuses invalid snapshots and journal paths instead of writing a supplied target', async () => {
    seedSystem()
    const id = await add()
    legacySwitch(id)
    put(runtimePath('system-default-auth.json'), {
      version: 1,
      binding: { credentialsPath: join(root, 'victim') }
    })
    await expect(create().launchEnv()).rejects.toThrow('snapshot is unavailable or invalid')
    put(runtimePath('transaction.json'), {
      version: 1,
      binding: {},
      changes: [{ kind: 'file', path: join(root, 'victim'), after: 'bad' }]
    })
    await expect(create().launchEnv()).rejects.toThrow('unavailable or invalid')
    expect(fs.existsSync(join(root, 'victim'))).toBe(false)
  })
})

describe('refused storage', () => {
  it('refuses malformed config, registry and account credentials without replacing them', async () => {
    seedSystem()
    const id = await add()
    put(configPath(), '{invalid secret')
    await expect(service.launchEnv(null)).rejects.toThrow('unavailable or invalid')
    expect(fs.readFileSync(configPath(), 'utf8')).toBe('{invalid secret')
    seedSystem()
    put(join(authPath(id), '.credentials.json'), '{bad')
    expect((await service.list()).accounts[0].status).toBe('unknown')
    await expect(service.select(id)).rejects.toThrow('valid login')
    put(indexPath(), '{bad registry')
    await expect(service.select(null)).rejects.toThrow('unavailable or invalid')
  })
  it('refuses an auth directory junction and never deletes its external target', async () => {
    const id = await add()
    const path = authPath(id)
    const target = join(root, 'external-auth')
    fs.renameSync(path, target)
    fs.symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
    expect((await service.list()).accounts[0].status).toBe('unknown')
    await expect(service.select(id)).rejects.toThrow('valid login')
    await expect(service.launchEnv(id)).rejects.toThrow('unreadable')
    await expect(service.remove(id)).rejects.toThrow('cannot be removed safely')
    expect(read(join(target, '.credentials.json'))).toEqual(token())
  })
  it('refuses an ancestor junction or corrupted ownership marker', async () => {
    const id = await add()
    put(join(authPath(id), MARKER), 'not-owned\n')
    await expect(service.remove(id)).rejects.toThrow('cannot be removed safely')
    const linked = join(root, 'linked-data')
    fs.symlinkSync(userData, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(create({ userData: linked }).list()).rejects.toThrow('unavailable or invalid')
  })
})

describe('sign-in folders', () => {
  const link = (target, path) => {
    fs.mkdirSync(join(path, '..'), { recursive: true })
    fs.symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
  }
  it('adds the account when its sign-in folder holds a junction (a browser profile), removes the folder and keeps what the junction points to', async () => {
    seedSystem()
    const outside = join(root, 'outside')
    put(join(outside, 'keep.txt'), 'keep')
    const signIn = runner.getMockImplementation()
    let isolated
    runner.mockImplementationOnce(async (options) => {
      isolated = options.home
      link(outside, join(isolated, 'AppData', 'INetCache', 'Content.IE5'))
      return signIn(options)
    })
    const result = await service.add()
    expect(result.ok).toBe(true)
    expect(fs.existsSync(isolated)).toBe(false)
    expect(fs.readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })
  it('a sign-in folder that cannot be removed does not undo the sign-in', async () => {
    seedSystem()
    const signIn = runner.getMockImplementation()
    let isolated
    runner.mockImplementationOnce(async (options) => {
      isolated = options.home
      // Deeper than the cleanup goes.
      fs.mkdirSync(join(isolated, ...Array(14).fill('d')), { recursive: true })
      return signIn(options)
    })
    const result = await service.add()
    expect(result.ok).toBe(true)
    expect((await service.list()).accounts.map((a) => a.email)).toEqual(['managed@fixture.invalid'])
    expect(fs.existsSync(isolated)).toBe(true)
  })
  it('removes a sign-in folder an earlier sign-in left once it is an hour old, and only one of its own', async () => {
    seedSystem()
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
    const [old, recent, foreign] = ids.map((id) => runtimePath(`login-${id}`))
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    put(join(old, MARKER), `login:${ids[0]}\n`)
    put(join(old, '.credentials.json'), token('old'))
    link(join(root, 'home'), join(old, 'AppData', 'Content.IE5'))
    fs.utimesSync(join(old, MARKER), hoursAgo, hoursAgo)
    put(join(recent, MARKER), `login:${ids[1]}\n`)
    put(join(foreign, MARKER), 'someone else\n')
    fs.utimesSync(join(foreign, MARKER), hoursAgo, hoursAgo)
    await add()
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(recent)).toBe(true)
    expect(fs.existsSync(foreign)).toBe(true)
    expect(read(credentialPath())).toEqual(token('system'))
  })
  it('a cleanup that fails halfway keeps the folder marked (a later sign-in finishes it), and its copy of the login goes at once', async () => {
    seedSystem()
    const signIn = runner.getMockImplementation()
    let isolated
    runner.mockImplementationOnce(async (options) => {
      isolated = options.home
      put(join(isolated, 'AppData', 'Profile', 'cookies.sqlite'), 'held by a browser')
      return signIn(options)
    })
    const real = fsp.unlink.bind(fsp)
    const unlink = vi.spyOn(fsp, 'unlink').mockImplementation(async (path) => {
      if (String(path).endsWith('cookies.sqlite')) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return real(path)
    })
    expect((await service.add()).ok).toBe(true)
    expect(fs.existsSync(join(isolated, MARKER))).toBe(true)
    expect(fs.existsSync(join(isolated, '.credentials.json'))).toBe(false)
    // The browser let go; an hour on, the next sign-in removes the folder.
    unlink.mockRestore()
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    fs.utimesSync(join(isolated, MARKER), hoursAgo, hoursAgo)
    await add('other')
    expect(fs.existsSync(isolated)).toBe(false)
  })
  it('keeps the folder of a sign-in whose end was never confirmed until its process is gone, whatever its age', async () => {
    seedSystem()
    const alive = new Set([4242])
    service = create({ pidAlive: (pid) => alive.has(pid) })
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const folders = []
    for (const pid of [4242, null]) {
      runner.mockImplementationOnce(async ({ home: isolated }) => {
        folders.push(isolated)
        return { ok: false, cleanupSafe: false, pid }
      })
      await expect(service.add()).rejects.toThrow('could not be confirmed')
    }
    for (const folder of folders) fs.utimesSync(join(folder, MARKER), hoursAgo, hoursAgo)
    // Its process still runs, or is unknown: kept.
    await add()
    expect(folders.map((f) => fs.existsSync(f))).toEqual([true, true])
    // Seen gone: removed at the next sign-in; the unknown one stays.
    alive.clear()
    await add('other')
    expect(folders.map((f) => fs.existsSync(f))).toEqual([false, true])
  })
  it('writes its guard before the sign-in starts: if it cannot, nothing starts and its folder goes', async () => {
    seedSystem()
    const real = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('.tessel-login-pid')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return real(from, to)
    })
    await expect(service.add()).rejects.toThrow()
    expect(runner).not.toHaveBeenCalled()
    expect(fs.readdirSync(runtimePath('')).filter((n) => n.startsWith('login-'))).toEqual([])
  })
  it("keeps the folder while the sign-in's process runs, from the moment it starts (a later write that fails changes nothing)", async () => {
    seedSystem()
    const alive = new Set([4242])
    service = create({ pidAlive: (pid) => alive.has(pid) })
    let isolated
    const real = fsp.rename.bind(fsp)
    runner.mockImplementationOnce(async ({ home: directory, onSpawn }) => {
      isolated = directory
      await onSpawn(4242)
      // Every write of the guard from now on fails.
      vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
        if (String(to).endsWith('.tessel-login-pid')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
        return real(from, to)
      })
      return { ok: false, cleanupSafe: false, pid: 4242 }
    })
    await expect(service.add()).rejects.toThrow('could not be confirmed')
    vi.mocked(fsp.rename).mockRestore()
    expect(fs.readFileSync(join(isolated, '.tessel-login-pid'), 'utf8').trim()).toBe('4242')
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    fs.utimesSync(join(isolated, MARKER), hoursAgo, hoursAgo)
    await add()
    expect(fs.existsSync(isolated)).toBe(true)
    alive.clear()
    await add('other')
    expect(fs.existsSync(isolated)).toBe(false)
  })
})
