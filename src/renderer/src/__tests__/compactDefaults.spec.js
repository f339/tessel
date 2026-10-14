// Compact defaults (settings.js): the editor at 12 px and pages a little
// smaller than 100 %; settings saved with the earlier editor size get the new
// one once, a size chosen since stays.
import { describe, it, expect, beforeEach } from 'vitest'
import { settings, loadSettings, resetSettings, DEFAULT_SETTINGS } from '../settings'

describe('compact defaults', () => {
  beforeEach(() => resetSettings())

  it('the editor at 12 px, pages at Chromium level -0.5 (91 %)', () => {
    expect(DEFAULT_SETTINGS.editorFontSize).toBe(12)
    expect(DEFAULT_SETTINGS.browserZoomLevel).toBe(-0.5)
  })

  it('settings saved with the earlier default (14 px) get the new one, once', () => {
    loadSettings({ editorFontSize: 14 })
    expect(settings.editorFontSize).toBe(12)
    expect(settings.compactDefaults).toBe(false)
  })

  it('a size chosen by hand stays: another size, or 14 chosen once the compact defaults are in', () => {
    loadSettings({ editorFontSize: 16 })
    expect(settings.editorFontSize).toBe(16)
    resetSettings()
    loadSettings({ editorFontSize: 14, compactDefaults: true })
    expect(settings.editorFontSize).toBe(14)
  })

  it('the page zoom default is kept within Chromium zoom limits', () => {
    loadSettings({ browserZoomLevel: -9 })
    expect(settings.browserZoomLevel).toBe(-3)
  })
})
