import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { fileIcon, fileIconId, baseName } from '../fileIcons/fileIcons'
import data from '../fileIcons/seti.json'
import FileIcon from '../components/FileIcon.vue'
import { settings } from '../settings'

describe("file icons (VS Code's Seti theme)", () => {
  it('resolves as VS Code does: exact name, then the longest extension, then the language, then the plain file', () => {
    // An exact file name beats its extension and language.
    expect(fileIconId('tsconfig.json')).toBe(data.fileNames['tsconfig.json'])
    expect(fileIconId('tsconfig.json')).not.toBe(fileIconId('other.json'))
    expect(fileIconId('Vite.Config.TS')).toBe(data.fileNames['vite.config.ts'])
    // The longest extension first: a test file has its own icon, not the
    // language's.
    expect(fileIconId('app.spec.ts')).toBe(data.fileExtensions['spec.ts'])
    expect(fileIconId('app.spec.ts')).not.toBe(fileIconId('app.ts'))
    // By language: .ts is TypeScript's icon, .vue Vue's, .py Python's.
    expect(fileIconId('main.ts')).toBe(data.languageIds.typescript)
    expect(fileIconId('App.vue')).toBe(data.languageIds.vue)
    expect(fileIconId('tool.py')).toBe(data.languageIds.python)
    // Any case; unknown types get the plain file icon.
    expect(fileIconId('README.MD')).toBe(fileIconId('readme.md'))
    expect(fileIconId('notes.zzzunknown')).toBe(data.file)
    expect(fileIconId('')).toBe(data.file)
  })

  it('gives the glyph and its dark or light colour; a folder has none', () => {
    const ts = fileIcon('src/main.ts')
    const def = data.icons[data.languageIds.typescript]
    expect(ts.glyph).toBe(String.fromCodePoint(def[0]))
    expect(ts.color).toBe(def[1])
    expect(fileIcon('C:\\x\\main.ts', { light: true }).color).toBe(def[2])
    expect(fileIcon('src', { dir: true })).toBeNull()
    expect(baseName('a/b\\c.txt')).toBe('c.txt')
  })

  describe('FileIcon.vue', () => {
    beforeEach(() => {
      settings.fileIcons = 'color'
    })
    it('in colour by default, one colour or none as set in Settings', async () => {
      const w = mount(FileIcon, { props: { name: 'index.js' } })
      const el = w.get('[data-test="file-icon"]')
      expect(el.text()).toBe(fileIcon('index.js').glyph)
      expect(el.attributes('style')).toContain('color')
      settings.fileIcons = 'mono'
      await nextTick()
      expect(w.get('[data-test="file-icon"]').classes()).toContain('mono')
      expect(w.get('[data-test="file-icon"]').attributes('style')).toBeUndefined()
      settings.fileIcons = 'off'
      await nextTick()
      expect(w.find('[data-test="file-icon"]').exists()).toBe(false)
      w.unmount()
    })
    it('draws nothing for a folder', () => {
      const w = mount(FileIcon, { props: { name: 'src', dir: true } })
      expect(w.find('[data-test="file-icon"]').exists()).toBe(false)
      w.unmount()
    })
  })
})
