// A Claude account's subscription as Anthropic last reported it (main's
// claudePlanCheck.js on this PC, the host's own check on an SSH host or a
// WSL distro; shared/claudeSubscription.js), in the interface's words. It
// wins over the plan Claude Code wrote into its login file at sign-in,
// which a canceled subscription never changes.
import { t, intlLocale } from './i18n'
import { timeAgo } from './sessionHistory'
import { subscriptionState } from '../../shared/claudeSubscription'

function dateText(ms) {
  try {
    return new Date(ms).toLocaleDateString(intlLocale(), { dateStyle: 'medium' })
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}

export function checkedText(at, now = Date.now()) {
  if (!Number.isFinite(at) || at <= 0) return ''
  return now - at < 60_000 ? t('accounts.plan.checkedNow', 'checked just now') : t('accounts.plan.checked', 'checked {{when}}', { when: timeAgo(at, now) })
}

// -> null, or { plan, warn, trialEndsAt, checkedAt, attention, warnText,
// trialText, checked, tag, short, title }
// tag: what an account's tag shows (the plan; for a free account, "No
// subscription"); short: a header's word (the warning, else the plan);
// title: the whole of it, with when it was checked.
export function planInfo(sub, now = Date.now()) {
  const s = subscriptionState(sub, now)
  if (!s) return null
  const warnText =
    s.warn === 'none'
      ? t('accounts.plan.none', 'No subscription')
      : s.warn === 'canceled'
        ? t('accounts.plan.canceled', 'Subscription canceled')
        : s.warn === 'payment'
          ? t('accounts.plan.payment', 'Payment issue')
          : ''
  const trialText = s.trialEndsAt ? t('accounts.plan.trial', 'Trial until {{date}}', { date: dateText(s.trialEndsAt) }) : ''
  const checked = checkedText(s.checkedAt, now)
  const tag = s.warn === 'none' ? warnText : s.plan || ''
  const short = warnText || s.plan || ''
  const title = [s.plan, warnText, trialText, checked].filter(Boolean).join(' · ')
  return { ...s, warnText, trialText, checked, tag, short, title }
}

// The words under a pane whose account needs attention (its header's tag,
// its hover card): why, and what can be done.
export function paneWarnText(info) {
  if (!info || !info.attention) return ''
  return info.warn === 'payment'
    ? t('accounts.plan.paneWarnPayment', 'This pane runs on a Claude account with a payment issue. To move it: Settings > AI provider accounts > Where you’re signed in > Switch panes…')
    : t('accounts.plan.paneWarnNone', 'This pane runs on a Claude account with no subscription. To move it: Settings > AI provider accounts > Where you’re signed in > Switch panes…')
}
