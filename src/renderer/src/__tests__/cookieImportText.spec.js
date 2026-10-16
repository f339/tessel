// The words of a cookie import's result, in English and French
// (browser/cookieImportText.js). French groups thousands with a no-break
// space: nbsp() turns it into a plain one to compare.
import { afterEach, describe, expect, it } from 'vitest'
import { setMessages } from '../i18n'
import fr from '../i18n/locales/fr/browser.json'
import { headlineText, skippedText, toastText, lastImportText, skipBreakdown } from '../browser/cookieImportText'

const AT = Date.UTC(2026, 9, 3, 12)
const AGAIN = {
  imported: 2180,
  added: 12,
  updated: 1,
  unchanged: 2167,
  previousAt: AT,
  skipped: 1137,
  reasons: { google: 89, expired: 1000, partitioned: 48 }
}

afterEach(() => setMessages('en', {}))
const nbsp = (text) => String(text).replace(/[\u00a0\u202f]/g, ' ')

describe('cookie import text', () => {
  it('English', () => {
    expect(headlineText(AGAIN)).toMatch(/^Already imported on .+\. This time: 12 new, 1 updated, 2,167 unchanged\.$/)
    // How many were skipped; the reasons are in the Details, not repeated.
    expect(skippedText(AGAIN)).toBe('1,137 skipped.')
    expect(skippedText({ skipped: 0 })).toBe('')
    expect(toastText(AGAIN)).toBe("Cookies imported into Tessel's browser: 12 new, 1 updated, 2,167 unchanged.")
    expect(headlineText({ imported: 1, added: null })).toBe('Imported 1 cookie.')
    // Without a comparison: the old wording.
    expect(toastText({ imported: 5, added: null })).toBe("Imported 5 cookies into Tessel's browser.")
    expect(headlineText({ imported: 5, added: null })).toBe('Imported 5 cookies.')
  })

  it('French, with the plural forms and the date in French', () => {
    setMessages('fr', fr)
    expect(nbsp(headlineText(AGAIN))).toMatch(/^Déjà importé le 3 oct\. 2026\. Cette fois : 12 nouveaux, 1 mis à jour, 2 167 inchangés\.$/)
    expect(headlineText({ ...AGAIN, added: 1, unchanged: 1 })).toContain('1 nouveau, 1 mis à jour, 1 inchangé.')
    expect(nbsp(skippedText(AGAIN))).toBe('1 137 ignorés.')
    expect(skippedText({ skipped: 1 })).toBe('1 ignoré.')
    expect(nbsp(toastText(AGAIN))).toBe('Cookies importés dans le navigateur de Tessel : 12 nouveaux, 1 mis à jour, 2 167 inchangés.')
    expect(nbsp(lastImportText({ at: AT, imported: 2180 }))).toBe('Importé le 3 oct. 2026 · 2 180 cookies')
    expect(lastImportText({ at: AT, imported: 1 })).toBe('Importé le 3 oct. 2026 · 1 cookie')
    expect(skipBreakdown(AGAIN).map((r) => r.label)).toEqual(['Expirés (plus valides dans ce navigateur)', 'Partitionnés (cookies tiers gardés par site)', 'Google (jamais importés)'])
  })

  it('the breakdown adds up to the skipped total', () => {
    const s = { skipped: 10, reasons: { expired: 4, appBound: 2, invalid: 3, mystery: 1 } }
    const rows = skipBreakdown(s)
    expect(rows.map((r) => r.id)).toEqual(['expired', 'appBound', 'other'])
    expect(rows.reduce((n, r) => n + r.n, 0)).toBe(10)
  })
})
