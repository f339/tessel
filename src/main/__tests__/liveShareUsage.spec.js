// @vitest-environment node
// Live Share usage (liveShare/shareUsage.js): a guest with "See my usage"
// gets the host's plans, % used and reset times, made from readings the
// host already has (never an extra provider call), with no account id,
// label, email, organisation, credits, history or error text, pushed only
// when it changed and at most once every 30 s.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createShareUsage,
  usageFromResult,
  usageFromEntry,
  usageFromLocal,
  plainName,
  USAGE_PUSH_MS,
  LOCAL_USAGE_TTL_MS,
  USAGE_STATUSES
} from '../liveShare/shareUsage'
import { registerProviderUsage } from '../providerUsageIpc'
import { createUsagePoller } from '../usagePoller'

const EPOCH = 1_900_000_000_000
const SECRETS = [
  'fixture@example.invalid',
  'Fixture.Person@Corp.Example',
  'acct_7f3a9c2e1b',
  'org-5d1e88aa',
  'Work laptop account',
  'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWx0123456789',
  'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  'resettoken9f8e7d6c5b4a',
  'C:\\Users\\fixture\\.claude',
  'Sign in again as fixture@example.invalid',
  '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
]
// The secrets that could land where a name is allowed (a plan, a window's
// label) by mistake: shaped like an address, a key, a path or an id.
const SHAPED = SECRETS.filter((s) => !['acct_7f3a9c2e1b', 'org-5d1e88aa', 'Work laptop account', 'resettoken9f8e7d6c5b4a'].includes(s)).concat('deadbeefdeadbeefdeadbeefdeadbeef')

// The results the host's window gets, as the readers build them.
function claudeLive() {
  return {
    ok: true,
    provider: 'claude',
    accountId: 'acct_7f3a9c2e1b',
    source: 'live',
    observedAt: EPOCH,
    plan: 'Max 20x',
    windows: [
      { label: '5-hour', usedPct: 42.123, resetsAt: EPOCH + 3_600_000, lockedReason: 'Sign in again as fixture@example.invalid' },
      { label: 'Weekly', usedPct: 87, resetsAt: EPOCH + 86_400_000 },
      { label: 'Sonnet weekly', usedPct: 56, resetsAt: null }
    ],
    breakdown: { asOf: EPOCH, rows: [{ label: 'Work laptop account', pct: 40 }] },
    extraUsage: { currency: 'USD', decimals: 2, used: 1234, limit: 5000, pct: 24.68, limitReached: false }
  }
}
function codexLive() {
  return {
    ok: true,
    provider: 'codex',
    accountId: 'org-5d1e88aa',
    source: 'live',
    observedAt: EPOCH,
    plan: 'pro',
    windows: [
      { label: '5-hour', usedPct: 10, resetsAt: EPOCH + 1000 },
      { label: 'Weekly', usedPct: 20, resetsAt: EPOCH + 2000 }
    ],
    resetCredits: { availableCount: 2, nextExpiresAt: EPOCH + 5000, eligible: true },
    resetToken: 'resettoken9f8e7d6c5b4a',
    resetCreditsError: 'Reset credit availability could not be refreshed.'
  }
}
function keptAfterFailure() {
  return { ...codexLive(), stale: true, kept: true, error: 'Sign in again as fixture@example.invalid', code: 'auth' }
}
function failure(code, provider = 'claude') {
  return { ok: false, provider, accountId: 'acct_7f3a9c2e1b', code, error: `Could not read for fixture@example.invalid (${code})`, retryAfterMs: 60_000, plan: 'Pro' }
}
function extraLive(provider = 'gemini') {
  return {
    ok: true,
    provider,
    accountId: null,
    source: 'live',
    observedAt: EPOCH,
    windows: [{ label: '2.5-pro', usedPct: 30, resetsAt: '2030-03-01T00:00:00Z' }]
  }
}

const KEYS = ['id', 'plan', 'windows', 'status', 'updatedAt']
const WINDOW_KEYS = ['label', 'usedPct', 'resetsAt']
function expectShape(item) {
  expect(Object.keys(item).sort()).toEqual([...KEYS].sort())
  expect(USAGE_STATUSES.concat('unavailable')).toContain(item.status)
  for (const w of item.windows) expect(Object.keys(w).sort()).toEqual([...WINDOW_KEYS].sort())
}

// A small deterministic random source, so a failing case is reproducible.
function random(seed) {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Live Share usage: the allowlist', () => {
  it('keeps only id, plan, windows (label, % used, reset), status and time', () => {
    expect(usageFromResult(claudeLive(), EPOCH + 5)).toEqual({
      id: 'claude',
      plan: 'Max 20x',
      windows: [
        { label: '5-hour', usedPct: 42.12, resetsAt: EPOCH + 3_600_000 },
        { label: 'Weekly', usedPct: 87, resetsAt: EPOCH + 86_400_000 },
        { label: 'Sonnet weekly', usedPct: 56, resetsAt: null }
      ],
      status: 'ok',
      updatedAt: EPOCH
    })
    const codex = usageFromResult(codexLive(), EPOCH)
    expectShape(codex)
    expect(JSON.stringify(codex)).not.toMatch(/reset(Token|Credits)|org-|resettoken/)
  })

  it('maps codes to fixed statuses and never keeps error text', () => {
    expect(usageFromResult(keptAfterFailure(), EPOCH)).toMatchObject({ id: 'codex', status: 'stale', windows: [{ label: '5-hour' }, { label: 'Weekly' }] })
    for (const [code, status] of [
      ['auth', 'signin'],
      ['expired', 'signin'],
      ['identity', 'signin'],
      ['unsupported', 'unsupported'],
      ['network', 'error'],
      ['rate-limited', 'error'],
      ['timeout', 'error'],
      ['unavailable', 'unavailable']
    ]) {
      const item = usageFromResult(failure(code), EPOCH + 9)
      expect(item).toEqual({ id: 'claude', plan: 'Pro', windows: [], status, updatedAt: EPOCH + 9 })
    }
    // Another account's read (the selection changed meanwhile): never shown.
    expect(usageFromResult(failure('stale'), EPOCH)).toBe(null)
    expect(usageFromResult({ ok: true, provider: 'someone-else', windows: [] })).toBe(null)
    expect(usageFromResult(null)).toBe(null)
  })

  it('drops labels and plans that are not plain names', () => {
    for (const bad of ['fixture@example.invalid', 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWx0123456789', 'deadbeefdeadbeefdeadbeefdeadbeef', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'x'.repeat(80), '<b>Weekly</b>', 'C:\\Users\\fixture','see https://example.com/?code=abc'])
      expect(plainName(bad, 70)).toBe(null)
    // Invisible and direction characters go (a name cannot disguise itself).
    expect(plainName('Week\u202ely\u0000', 70)).toBe('Week ly')
    for (const good of ['5-hour', 'Weekly', 'Sonnet weekly', 'Claude and GPT 5-hour', '2.5-flash-lite-preview-06-17', 'Max 20x', 'pro_20x', '1440 min', 'Monthly', 'claude-sonnet-4-5-20250929-thinking'])
      expect(plainName(good, 70)).toBe(good)
    const item = usageFromResult({ ...extraLive(), plan: 'fixture@example.invalid', windows: [{ label: 'fixture@example.invalid', usedPct: 5 }, { label: '', usedPct: 6 }, { label: 'Weekly', usedPct: Infinity }, { label: 'Weekly', usedPct: 150 }] }, EPOCH)
    expect(item.plan).toBe(null)
    expect(item.windows).toEqual([
      { label: '', usedPct: 6, resetsAt: null },
      { label: 'Weekly', usedPct: 100, resetsAt: null }
    ])
  })

  it('fuzz: no email, account id, label or secret survives any result shape', () => {
    const next = random(20261016)
    const pick = (list) => list[Math.floor(next() * list.length)]
    const shapes = [claudeLive, codexLive, keptAfterFailure, () => failure(pick(['auth', 'network', 'unsupported', 'expired'])), () => extraLive(pick(['gemini', 'kimi', 'cursor', 'antigravity', 'zcode', 'minimax', 'grok', 'opencode-go']))]
    const secretFields = ['email', 'emailAddress', 'accountLabel', 'organization', 'organizationUuid', 'account', 'accountUuid', 'accountId', 'credits', 'history', 'entries', 'error', 'message', 'resetToken', 'name', 'user', 'home', 'path', 'lockedReason']
    // Puts secrets in random fields, at the top, in windows and in nested
    // objects; now and then a window's label too (a shaped one).
    const salt = (value) => {
      if (Array.isArray(value)) return value.map((v) => salt(v))
      if (!value || typeof value !== 'object') return value
      const out = { ...value }
      for (const [k, v] of Object.entries(out)) out[k] = salt(v)
      const count = Math.floor(next() * 4)
      for (let i = 0; i < count; i++) out[pick(secretFields)] = next() < 0.2 ? { nested: pick(SECRETS), list: [pick(SECRETS)] } : pick(SECRETS)
      if ('label' in out && next() < 0.1) out.label = pick(SHAPED)
      return out
    }
    let windowsSeen = 0
    for (let i = 0; i < 600; i++) {
      const result = salt(pick(shapes)())
      // Some windows with a secret as their label, some plans too.
      if (Array.isArray(result.windows) && next() < 0.3) result.windows.push({ label: pick(SHAPED), usedPct: 1 })
      if (next() < 0.3) result.plan = pick(SHAPED)
      const item = usageFromResult(result, EPOCH)
      if (!item) continue
      expectShape(item)
      windowsSeen += item.windows.length
      const text = JSON.stringify(item)
      for (const secret of SECRETS) expect(text).not.toContain(JSON.stringify(secret).slice(1, -1))
      expect(text).not.toMatch(/@|acct_|org-|sk-ant|ghp_|resettoken|Users/)
    }
    expect(windowsSeen).toBeGreaterThan(500)
  })

  it('reads the refresh cache: a failure keeps a recent reading as stale, an old one as an error', () => {
    const entry = { accountId: 'acct_7f3a9c2e1b', status: 'ok', snapshot: claudeLive(), updatedAt: EPOCH, attemptAt: EPOCH, streak: 0 }
    expect(usageFromEntry('claude', entry, EPOCH)).toMatchObject({ status: 'ok', plan: 'Max 20x' })
    const failed = { ...entry, status: 'error', attemptAt: EPOCH + 60_000, streak: 1 }
    expect(usageFromEntry('claude', failed, EPOCH + 60_000)).toMatchObject({ status: 'stale', windows: [{ label: '5-hour' }, { label: 'Weekly' }, { label: 'Sonnet weekly' }] })
    expect(usageFromEntry('claude', failed, EPOCH + 31 * 60_000)).toEqual({ id: 'claude', plan: 'Max 20x', windows: [], status: 'error', updatedAt: EPOCH + 60_000 })
    expect(usageFromEntry('claude', { ...entry, status: 'unavailable', snapshot: null }, EPOCH).status).toBe('unavailable')
    expect(usageFromEntry('claude', { status: 'error', snapshot: null, attemptAt: EPOCH }, EPOCH)).toMatchObject({ status: 'error', windows: [] })
    expect(usageFromEntry('nobody', entry, EPOCH)).toBe(null)
    expectShape(usageFromEntry('claude', entry, EPOCH))
  })

  it('reads the local Codex readings under the provider names, nothing else', () => {
    const local = {
      agents: [
        { id: 'claude', accountId: 'acct_7f3a9c2e1b', windows: [], source: 'unavailable', observedAt: null, stale: false, error: 'No verified local quota observation for fixture@example.invalid' },
        {
          id: 'codex',
          accountId: 'org-5d1e88aa',
          windows: [
            { label: '5h', usedPct: 12, resetsAt: '2030-01-01T05:00:00.000Z', stale: false },
            { label: 'week', usedPct: 40, resetsAt: '2030-01-07T00:00:00.000Z', stale: true }
          ],
          observedAt: '2030-01-01T00:00:00.000Z',
          source: 'codex-session',
          stale: true
        }
      ]
    }
    const map = usageFromLocal(local, EPOCH)
    expect([...map.keys()]).toEqual(['codex'])
    expect(map.get('codex')).toEqual({
      id: 'codex',
      plan: null,
      windows: [
        { label: '5-hour', usedPct: 12, resetsAt: Date.parse('2030-01-01T05:00:00.000Z') },
        { label: 'Weekly', usedPct: 40, resetsAt: Date.parse('2030-01-07T00:00:00.000Z') }
      ],
      status: 'stale',
      updatedAt: Date.parse('2030-01-01T00:00:00.000Z')
    })
  })
})

// The host's usage service as index.js registers it, with fakes for the
// accounts and the provider reads (the reads are counted).
function hostUsage() {
  const results = []
  const sent = []
  let cacheReader = null
  let ingest = null
  const service = {
    read: vi.fn(async ({ provider, accountId }) => ({ ...claudeLive(), provider, accountId, observedAt: Date.now() })),
    invalidate: vi.fn()
  }
  const accounts = {
    list: vi.fn(async () => ({
      ok: true,
      providers: ['claude', 'codex'].map((provider) => ({ provider, selectedId: null, system: { status: 'ready', label: 'Work laptop account', email: 'fixture@example.invalid' }, accounts: [] }))
    })),
    usageScope: vi.fn(async (_provider, accountId) => ({ ok: true, accountId, env: {} })),
    select: vi.fn(async () => ({ ok: true }))
  }
  const handlers = new Map()
  registerProviderUsage({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    accounts,
    service,
    send: (channel, payload) => sent.push([channel, payload]),
    onLiveIngest: (fn) => (ingest = fn),
    onResult: (result) => results.push(result),
    onCache: (fn) => (cacheReader = fn)
  })
  return { service, accounts, handlers, sent, results, cache: () => cacheReader(), ingest: (event) => ingest(event) }
}

describe('Live Share usage: from the host\'s own readings', () => {
  it('onResult gets everything pushed on providerUsage:update; the snapshot reads the cache, never a provider', async () => {
    const host = hostUsage()
    const feed = createShareUsage({ cache: host.cache })
    expect(await feed.snapshot()).toEqual({ providers: [] })
    // A chat's live reading: pushed to the window, and to Live Share.
    await host.ingest({ provider: 'claude', env: {}, since: Date.now(), rateLimit: { fiveHour: { utilization: 0.25, resetsAt: 2_000_000_000 } } })
    expect(host.sent).toHaveLength(1)
    expect(host.sent[0][0]).toBe('providerUsage:update')
    expect(host.results).toEqual([host.sent[0][1]])
    feed.onResult(host.results[0])
    const snap = await feed.snapshot()
    expect(snap.providers).toEqual([{ id: 'claude', plan: null, windows: [{ label: '5-hour', usedPct: 25, resetsAt: 2_000_000_000_000 }], status: 'ok', updatedAt: expect.any(Number) }])
    expect(host.service.read).not.toHaveBeenCalled()
    // A refresh by hand (not pushed): the cache has it, still no read for Live Share.
    await host.handlers.get('providerUsage:read')(null, { provider: 'codex', accountId: null })
    expect(host.service.read).toHaveBeenCalledTimes(1)
    const after = await feed.snapshot()
    expect(after.providers.map((p) => p.id)).toEqual(['claude', 'codex'])
    expect(after.providers[1]).toMatchObject({ id: 'codex', plan: 'Max 20x', status: 'ok' })
    for (let i = 0; i < 5; i++) await feed.snapshot()
    expect(host.service.read).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(after)).not.toMatch(/@|acct_|Work laptop|accountId/)
  })

  it('leaves out what the Usage menu hides, and an account switch forgets the old reading', async () => {
    const host = hostUsage()
    const feed = createShareUsage({ cache: host.cache })
    await host.handlers.get('providerUsage:read')(null, { provider: 'claude', accountId: null })
    await host.handlers.get('providerUsage:read')(null, { provider: 'codex', accountId: null })
    expect((await feed.snapshot()).providers.map((p) => p.id)).toEqual(['claude', 'codex'])
    await host.handlers.get('providerUsage:autoRefresh')(null, { hidden: ['codex', 'not-a-provider'], intervalMs: 0 })
    expect(host.cache().hidden).toEqual(['codex'])
    expect((await feed.snapshot()).providers.map((p) => p.id)).toEqual(['claude'])
    feed.onResult({ ...claudeLive(), accountId: null })
    await host.handlers.get('accounts:select')(null, { provider: 'claude', id: 'other' })
    expect((await feed.snapshot()).providers).toEqual([])
  })

  it('a pushed failure keeps its code (sign in again) until a newer reading is cached', async () => {
    let now = EPOCH
    const poller = createUsagePoller({ read: async () => ({ ...failure('auth'), accountId: null }), targets: async () => [], send: () => {}, clock: () => now })
    const cache = () => ({ hidden: [], entries: { claude: poller.entry('claude') } })
    const feed = createShareUsage({ cache, clock: () => now })
    const shown = await poller.read({ provider: 'claude', accountId: null })
    feed.onResult(shown)
    expect((await feed.snapshot()).providers).toEqual([{ id: 'claude', plan: 'Pro', windows: [], status: 'signin', updatedAt: EPOCH }])
    now += 1000
    // Without the pushed result the cache alone says only "error".
    expect(usageFromEntry('claude', poller.entry('claude'), now).status).toBe('error')
  })

  it('local readings fill in for a provider the refresh has nothing for, read at most once a minute', async () => {
    let now = EPOCH
    const localUsage = vi.fn(async () => ({ agents: [{ id: 'codex', windows: [{ label: '5h', usedPct: 33, resetsAt: null, stale: false }], observedAt: new Date(EPOCH).toISOString(), stale: false }] }))
    const feed = createShareUsage({ cache: () => ({ hidden: [], entries: {} }), localUsage, clock: () => now })
    const [a, b] = await Promise.all([feed.snapshot(), feed.snapshot()])
    expect(a).toEqual(b)
    expect(a.providers).toEqual([{ id: 'codex', plan: null, windows: [{ label: '5-hour', usedPct: 33, resetsAt: null }], status: 'ok', updatedAt: EPOCH }])
    now += LOCAL_USAGE_TTL_MS - 1
    await feed.snapshot()
    expect(localUsage).toHaveBeenCalledTimes(1)
    now += 2
    await feed.snapshot()
    expect(localUsage).toHaveBeenCalledTimes(2)
    // A failing local read is not retried at once either.
    localUsage.mockRejectedValue(new Error('C:\\Users\\fixture\\.codex unreadable'))
    now += LOCAL_USAGE_TTL_MS
    expect((await feed.snapshot()).providers).toEqual([])
    await feed.snapshot()
    expect(localUsage).toHaveBeenCalledTimes(3)
  })
})

describe('Live Share usage: pushes', () => {
  function feedWith(entries) {
    vi.useFakeTimers({ now: EPOCH })
    const feed = createShareUsage({ cache: () => ({ hidden: [], entries }), clock: () => Date.now() })
    const got = []
    const off = feed.subscribe((payload) => got.push(payload))
    return { feed, got, off }
  }
  const entry = (result) => ({ accountId: result.accountId ?? null, status: 'ok', snapshot: result, updatedAt: Date.now(), attemptAt: Date.now() })

  it('sends the first copy, then at most one push per 30 s with the latest content', async () => {
    const entries = { claude: entry(claudeLive()) }
    const { feed, got } = feedWith(entries)
    await vi.advanceTimersByTimeAsync(0)
    expect(got).toHaveLength(1)
    expect(got[0].providers[0].windows[0].usedPct).toBe(42.12)
    // Three new readings within 30 s: one push, with the last.
    for (const pct of [50, 60, 70]) {
      const result = { ...claudeLive(), windows: [{ label: '5-hour', usedPct: pct, resetsAt: null }], observedAt: Date.now() }
      entries.claude = entry(result)
      feed.onResult(result)
      await vi.advanceTimersByTimeAsync(5000)
    }
    expect(got).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(USAGE_PUSH_MS - 15000)
    expect(got).toHaveLength(2)
    expect(got[1].providers[0].windows).toEqual([{ label: '5-hour', usedPct: 70, resetsAt: null }])
    // Later: a change goes out at once (the last push is old enough).
    await vi.advanceTimersByTimeAsync(USAGE_PUSH_MS)
    const result = { ...claudeLive(), windows: [{ label: '5-hour', usedPct: 80, resetsAt: null }], observedAt: Date.now() }
    entries.claude = entry(result)
    feed.onResult(result)
    await vi.advanceTimersByTimeAsync(10)
    expect(got).toHaveLength(3)
    expect(got[2].providers[0].windows[0].usedPct).toBe(80)
    feed.stop()
  })

  it('pushes nothing when the content is the same (a new reading of the same numbers)', async () => {
    const entries = { claude: entry(claudeLive()) }
    const { feed, got } = feedWith(entries)
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(USAGE_PUSH_MS)
      const same = { ...claudeLive(), observedAt: EPOCH + 60_000 }
      entries.claude = entry(same)
      feed.onResult(same)
    }
    await vi.advanceTimersByTimeAsync(USAGE_PUSH_MS * 2)
    expect(got).toHaveLength(1)
    // Its age moved by five minutes: pushed once more, for "updated N min ago".
    const later = { ...claudeLive(), observedAt: EPOCH + 6 * 60_000 }
    entries.claude = entry(later)
    feed.onResult(later)
    await vi.advanceTimersByTimeAsync(USAGE_PUSH_MS)
    expect(got).toHaveLength(2)
    feed.stop()
  })

  it('a change only the cache has (a refresh by hand) is found by the periodic check', async () => {
    const entries = { claude: entry(claudeLive()) }
    const { feed, got } = feedWith(entries)
    await vi.advanceTimersByTimeAsync(0)
    entries.codex = entry(codexLive())
    await vi.advanceTimersByTimeAsync(61_000)
    expect(got).toHaveLength(2)
    expect(got[1].providers.map((p) => p.id)).toEqual(['claude', 'codex'])
    feed.stop()
  })

  it('stops its timers when the last listener leaves; a listener throwing does not stop the others', async () => {
    const entries = { claude: entry(claudeLive()) }
    const { feed, got, off } = feedWith(entries)
    const other = vi.fn(() => {
      throw new Error('socket closed')
    })
    const offOther = feed.subscribe(other)
    await vi.advanceTimersByTimeAsync(0)
    expect(other).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(USAGE_PUSH_MS)
    const result = { ...claudeLive(), windows: [{ label: 'Weekly', usedPct: 1, resetsAt: null }] }
    entries.claude = entry(result)
    feed.onResult(result)
    await vi.advanceTimersByTimeAsync(0)
    expect(got).toHaveLength(2)
    expect(other).toHaveBeenCalledTimes(2)
    off()
    offOther()
    expect(vi.getTimerCount()).toBe(0)
    feed.onResult({ ...claudeLive(), windows: [] })
    expect(vi.getTimerCount()).toBe(0)
  })
})
