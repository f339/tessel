// Numbers, money, dates and durations of the usage statistics, in the
// interface's language.
import { t, intlLocale } from '../../i18n'

const na = () => t('stats.format.na', 'n/a')
const number = (value, digits) =>
  new Intl.NumberFormat(intlLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)

// The unit is chosen after rounding to one decimal: 999,990,000 is 1.0B and
// 999,960 is 1.0M, never "1,000.0M" or "1,000.0k".
const UNITS = [1e3, 1e6, 1e9]
export function tokenUnit(value) {
  let i = UNITS.findLastIndex((unit) => value >= unit)
  if (i >= 0 && i < UNITS.length - 1 && Number((value / UNITS[i]).toFixed(1)) >= 1000) i++
  return i
}
export function tokens(value) {
  if (!Number.isFinite(value)) return na()
  const i = tokenUnit(value)
  if (i < 0) return value.toLocaleString(intlLocale())
  const n = number(value / UNITS[i], 1)
  if (i === 2) return t('stats.format.billions', '{{n}}B', { n })
  if (i === 1) return t('stats.format.millions', '{{n}}M', { n })
  return t('stats.format.thousands', '{{n}}k', { n })
}
// A cost under a cent keeps four decimals ($0.0042); nothing is $0.00.
export const money = (value) => {
  if (!Number.isFinite(value)) return na()
  const digits = value > 0 && value < 0.01 ? 4 : 2
  return new Intl.NumberFormat(intlLocale(), {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value)
}
export const percent = (value) =>
  Number.isFinite(value) ? new Intl.NumberFormat(intlLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(value) : na()
export function time(value) {
  const date = new Date(value)
  return value && Number.isFinite(date.getTime())
    ? date.toLocaleString(intlLocale(), {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : t('stats.format.unknown', 'Unknown')
}
export function duration(value) {
  if (!Number.isFinite(value)) return na()
  const minutes = Math.floor(Math.max(0, value) / 60000)
  if (minutes >= 1440)
    return t('stats.format.days', '{{d}}d {{h}}h', { d: Math.floor(minutes / 1440), h: Math.floor(minutes / 60) % 24 })
  if (minutes >= 60) return t('stats.format.hours', '{{h}}h {{m}}m', { h: Math.floor(minutes / 60), m: minutes % 60 })
  return t('stats.format.minutes', '{{m}}m', { m: minutes })
}
