import { describe, it, expect } from 'vitest'
import { detectLanguage, pickLanguage, extName, baseName } from '../editorLanguage'

describe('detectLanguage (Orca table)', () => {
  it('knows exact file names first', () => {
    expect(detectLanguage('C:\\proj\\Dockerfile')).toBe('dockerfile')
    expect(detectLanguage('/p/Makefile')).toBe('makefile')
    expect(detectLanguage('C:\\p\\CMakeLists.txt')).toBe('cmake')
    expect(detectLanguage('C:\\p\\.gitignore')).toBe('ini')
    expect(detectLanguage('C:\\p\\.env.local')).toBe('ini')
  })
  it('maps extensions, case-insensitively', () => {
    expect(detectLanguage('a.ts')).toBe('typescript')
    expect(detectLanguage('a.TSX')).toBe('typescriptreact')
    expect(detectLanguage('a.jsx')).toBe('javascriptreact')
    expect(detectLanguage('C:\\x\\b.mjs')).toBe('javascript')
    expect(detectLanguage('c.py')).toBe('python')
    expect(detectLanguage('d.ps1')).toBe('powershell')
    expect(detectLanguage('e.yml')).toBe('yaml')
    expect(detectLanguage('f.toml')).toBe('toml')
    expect(detectLanguage('g.sol')).toBe('sol')
    expect(detectLanguage('h.vue')).toBe('vue')
    expect(detectLanguage('i.json')).toBe('json')
  })
  it('treats scoped .env files as INI only when no extension matches', () => {
    expect(detectLanguage('.env.staging')).toBe('ini')
    expect(detectLanguage('.env')).toBe('ini')
    expect(detectLanguage('.env.json')).toBe('json')
  })
  it('falls back to plain text', () => {
    expect(detectLanguage('notes.txt')).toBe('plaintext')
    expect(detectLanguage('LICENSE')).toBe('plaintext')
    expect(detectLanguage('')).toBe('plaintext')
  })
  it('splits names like Orca', () => {
    expect(baseName('C:\\a\\b/c.ts')).toBe('c.ts')
    expect(extName('c.test.ts')).toBe('.ts')
    expect(extName('Makefile')).toBe('')
    expect(extName('.sh')).toBe('.sh')
  })
})

describe('pickLanguage (what Monaco has registered)', () => {
  const langs = [
    { id: 'typescript', extensions: ['.ts'] },
    { id: 'html', extensions: ['.html'] },
    { id: 'json', extensions: ['.json'] },
    { id: 'ruby', extensions: ['.rb'], filenames: ['Gemfile'] },
    { id: 'plaintext', extensions: ['.txt'] }
  ]
  it('keeps a registered language', () => {
    expect(pickLanguage('a.ts', langs)).toBe('typescript')
  })
  it("uses the closest built-in language for Vue, Svelte, Astro, JSONL, TSX, TOML when VS Code's are not registered", () => {
    expect(pickLanguage('App.tsx', langs)).toBe('typescript')
    expect(pickLanguage('Cargo.toml', [...langs, { id: 'ini', extensions: ['.ini'] }])).toBe('ini')
    expect(pickLanguage('App.vue', langs)).toBe('html')
    expect(pickLanguage('x.svelte', langs)).toBe('html')
    expect(pickLanguage('log.jsonl', langs)).toBe('json')
  })
  it("takes VS Code's language when Tessel registered it (editor/textmate.js)", () => {
    const more = [...langs, { id: 'typescriptreact', extensions: ['.tsx'] }, { id: 'vue', extensions: ['.vue'] }]
    expect(pickLanguage('App.tsx', more)).toBe('typescriptreact')
    expect(pickLanguage('App.vue', more)).toBe('vue')
    expect(pickLanguage('a.ts', more)).toBe('typescript')
  })
  it("asks Monaco's own file names and extensions", () => {
    expect(pickLanguage('C:\\p\\Gemfile', langs)).toBe('ruby')
  })
  it('falls back to plain text for unknown ids', () => {
    expect(pickLanguage('x.nim', langs)).toBe('plaintext')
    expect(pickLanguage('x.unknownext', langs)).toBe('plaintext')
  })
})
