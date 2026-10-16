import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { settings } from '../settings'
import { setMessages } from '../i18n'
import UsageMenu from '../components/UsageMenu.vue'
import fr from '../i18n/locales/fr/usage.json'

// A Claude reading as the main process returns it (values invented).
describe('Claude usage flyout details', () => {
  const epoch = Date.parse('2026-09-28T18:00:00Z')
  let wrapper, previousApi, reading
  const claudeReading = () => ({
    ok: true,
    provider: 'claude',
    accountId: null,
    observedAt: epoch,
    windows: [
      { label: '5-hour', usedPct: 41, resetsAt: epoch + 3600000 },
      {
        label: 'Weekly',
        usedPct: 63,
        resetsAt: epoch + 86400000,
        lockedReason: 'Weekly limit reached. <b>Upgrade</b>'
      },
      { label: 'Opus weekly', usedPct: 71, resetsAt: epoch + 86400000 },
      { label: 'Haiku 4.5 weekly', usedPct: 12, resetsAt: epoch + 86400000 }
    ],
    breakdown: {
      asOf: epoch - 1800000,
      rows: [
        { label: 'Claude Code', pct: 48.5 },
        { label: 'Chat', pct: 20 },
        { label: 'Bad', pct: 'x' }
      ]
    },
    extraUsage: {
      currency: 'USD',
      decimals: 2,
      used: 1234,
      limit: 5000,
      pct: 24.68,
      limitReached: true
    }
  })
  beforeEach(() => {
    settings.hiddenUsageProviders = []
    settings.usagePercentageDisplay = 'used'
    vi.useFakeTimers()
    vi.setSystemTime(epoch)
    vi.stubGlobal('innerWidth', 1100)
    previousApi = window.shellApi
    reading = claudeReading()
    window.shellApi = {
      listAgents: vi.fn(async () => [{ id: 'claude', available: true }]),
      getUsage: vi.fn(async () => ({ agents: [{ id: 'claude', windows: [] }] })),
      providerUsage: { read: vi.fn(async () => reading) }
    }
  })
  afterEach(() => {
    wrapper?.unmount()
    window.shellApi = previousApi
    setMessages('en', {})
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  async function openClaude() {
    wrapper = mount(UsageMenu, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="usage-row-claude"]').trigger('click')
    await flushPromises()
    return wrapper.get('[data-test="usage-provider-flyout"]')
  }

  it('names every per-model weekly window, and shows a lock reason as text', async () => {
    const flyout = await openClaude()
    const labels = flyout.findAll('.usage-flyout-window .usage-line').map((n) => n.text())
    expect(labels).toEqual(['5-hour', 'Weekly', 'Opus weekly', 'Haiku 4.5 weekly'])
    const locked = flyout.findAll('[data-test="usage-locked"]')
    expect(locked).toHaveLength(1)
    expect(locked[0].text()).toBe('Locked: Weekly limit reached. <b>Upgrade</b>')
    expect(locked[0].find('b').exists()).toBe(false)
  })

  it('shows the week by category with bars and the as-of time', async () => {
    const flyout = await openClaude()
    const section = flyout.get('[data-test="usage-breakdown"]')
    expect(section.text()).toContain("Share of this week's usage")
    expect(section.text()).toContain('as of')
    const rows = section.findAll('[data-test="usage-breakdown-row"]')
    expect(rows.map((r) => r.text())).toEqual(['Claude Code49%', 'Chat20%'])
    expect(rows[0].get('.usage-fill').attributes('style')).toContain('width: 48.5%')
  })

  it('shows paid extra usage in money with its bar and the limit warning', async () => {
    const flyout = await openClaude()
    const section = flyout.get('[data-test="usage-extra"]')
    expect(section.text()).toContain('Extra usage')
    expect(section.get('[data-test="usage-extra-amount"]').text()).toBe('$12.34 of $50.00 this month')
    expect(section.get('[role="meter"]').attributes('aria-valuenow')).toBe('25')
    expect(section.get('[data-test="usage-extra-limit"]').text()).toBe('Monthly spend limit reached.')
  })

  it('shows nothing extra when the reading has no breakdown, extra usage or lock', async () => {
    reading = { ...claudeReading(), windows: [{ label: '5-hour', usedPct: 10 }] }
    delete reading.breakdown
    delete reading.extraUsage
    const flyout = await openClaude()
    expect(flyout.find('[data-test="usage-breakdown"]').exists()).toBe(false)
    expect(flyout.find('[data-test="usage-extra"]').exists()).toBe(false)
    expect(flyout.find('[data-test="usage-locked"]').exists()).toBe(false)
  })

  it('a usage read refused with no usage limits: said neutrally, never an error or Sign in again; "no subscription" only when its checked plan says so', async () => {
    reading = { ok: false, provider: 'claude', accountId: null, code: 'no-usage-limits', error: 'Anthropic gives no usage limits for this Claude account.' }
    let flyout = await openClaude()
    let row = wrapper.get('[data-test="usage-row-claude"]')
    expect(row.find('.usage-plan').exists()).toBe(false)
    expect(row.get('.usage-no-data').text()).toBe('No usage limits')
    expect(flyout.find('[role="alert"]').exists()).toBe(false)
    expect(flyout.find('[data-test="usage-provider-sign-in"]').exists()).toBe(false)
    expect(flyout.get('[data-test="usage-no-limits"]').text()).toBe('Anthropic shows no usage limits for this Claude account.')
    expect(flyout.text()).not.toMatch(/subscription/i)
    wrapper.unmount()
    // The profile check says it has none: then it is said.
    window.shellApi.accounts = {
      list: vi.fn(async () => ({
        ok: true,
        providers: [{ provider: 'claude', selectedId: null, system: { id: null, status: 'ready', plan: 'max', subscription: { organization_type: 'claude_free', subscription_status: 'canceled', has_claude_max: false, checkedAt: epoch } }, accounts: [] }]
      }))
    }
    flyout = await openClaude()
    row = wrapper.get('[data-test="usage-row-claude"]')
    expect(row.get('.usage-plan').text()).toContain('No subscription')
    expect(flyout.get('[data-test="usage-no-limits"]').text()).toContain('no subscription')
  })

  it('the plan Anthropic reports for the selected account wins over its login file’s', async () => {
    reading = { ...claudeReading(), plan: 'Max 20x' }
    window.shellApi.accounts = {
      list: vi.fn(async () => ({
        ok: true,
        providers: [{ provider: 'claude', selectedId: null, system: { id: null, status: 'ready', plan: 'max', subscription: { organization_type: 'claude_free', subscription_status: 'canceled', has_claude_max: false, checkedAt: epoch } }, accounts: [] }]
      }))
    }
    await openClaude()
    expect(wrapper.get('[data-test="usage-row-claude"]').get('.usage-plan').text()).toContain('No subscription')
  })

  it("shows Claude's plan beside its name, like Codex's, also when its usage could not be read", async () => {
    reading = { ...claudeReading(), plan: 'Max 20x' }
    await openClaude()
    expect(wrapper.get('[data-test="usage-row-claude"]').get('.usage-plan').text()).toContain('Max 20x')
    wrapper.unmount()
    reading = { ok: false, provider: 'claude', accountId: null, code: 'network', error: 'offline', plan: 'Pro' }
    wrapper = mount(UsageMenu, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="usage-row-claude"]').get('.usage-plan').text()).toContain('Pro')
  })

  it('speaks French', async () => {
    setMessages('fr', fr)
    reading.extraUsage = { ...reading.extraUsage, limitReached: false }
    const flyout = await openClaude()
    const labels = flyout.findAll('.usage-flyout-window .usage-line').map((n) => n.text())
    expect(labels).toEqual(['5 heures', 'Hebdomadaire', 'Opus hebdomadaire', 'Haiku 4.5 hebdomadaire'])
    expect(flyout.text()).toContain('Répartition de votre usage cette semaine')
    expect(flyout.text()).toContain('Bloqué : Weekly limit reached.')
    const amount = flyout.get('[data-test="usage-extra-amount"]').text().replace(/\s/g, ' ')
    expect(amount).toBe('12,34 $ US sur 50,00 $ US ce mois-ci')
    expect(flyout.find('[data-test="usage-extra-limit"]').exists()).toBe(false)
  })
})
