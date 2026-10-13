// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createTextmate, grammarFor, rulesFor, vscodeColours, EXTRA_LANGUAGES } from '../editor/textmate'

// A Monaco stand-in: its languages and the tokens providers set on them.
function fakeMonaco(ids = ['typescript', 'javascript', 'python', 'plaintext']) {
  const langs = ids.map((id) => ({ id }))
  const providers = {}
  return {
    providers,
    languages: {
      getLanguages: () => langs,
      register: (l) => langs.push(l),
      setTokensProvider: (id, p) => (providers[id] = p)
    }
  }
}
// The colour of each piece of a line, by the editor theme's rules.
function colours(tm, provider, line, dark = true) {
  const rules = new Map(tm.rules(dark).map((r) => [r.token, r]))
  const { tokens } = provider.tokenize(line, provider.getInitialState())
  return tokens.map((tk, i) => {
    const text = line.slice(tk.startIndex, i + 1 < tokens.length ? tokens[i + 1].startIndex : line.length)
    const r = rules.get(tk.scopes) || rules.get(String(tk.scopes).split('.')[0])
    return [text, r && r.foreground ? r.foreground : 'text']
  })
}

describe("VS Code's colouring in the editor (Shiki, TextMate)", () => {
  it('maps Monaco languages to VS Code grammars; .tsx and .jsx are their own', () => {
    expect(grammarFor('typescript')).toBe('typescript')
    expect(grammarFor('typescriptreact')).toBe('tsx')
    expect(grammarFor('javascriptreact')).toBe('jsx')
    expect(grammarFor('shell')).toBe('shellscript')
    expect(grammarFor('dockerfile')).toBe('docker')
    expect(grammarFor('plaintext')).toBeNull()
    expect(grammarFor('no-such-language')).toBeNull()
    for (const l of EXTRA_LANGUAGES) expect(grammarFor(l.id)).toBeTruthy()
  })

  it('registers the languages Monaco lacks, then colours TypeScript as VS Code Dark 2026 does', async () => {
    const monaco = fakeMonaco()
    const tm = createTextmate({ monaco })
    const ids = monaco.languages.getLanguages().map((l) => l.id)
    expect(ids).toEqual(expect.arrayContaining(['typescriptreact', 'javascriptreact', 'vue', 'toml']))
    expect(tm.rules(true)).toEqual([]) // nothing before the grammars load
    expect(await tm.useLanguage('typescript')).toBe(true)
    expect(tm.hasGrammar('typescript')).toBe(true)
    const got = Object.fromEntries(colours(tm, monaco.providers.typescript, 'const total = sum(items)').map(([t, c]) => [t.trim(), c]))
    // Dark 2026 (VS Code's default): keyword red, constant blue, function
    // purple, a variable in the text colour.
    expect(got.const).toBe('ff7b72')
    expect(got.total).toBe('79c0ff')
    expect(got.sum).toBe('d2a8ff')
    expect(got.items).toBe('c9d1d9')
    // Light 2026 after a switch: the same pieces in its light colours.
    const light = Object.fromEntries(colours(tm, monaco.providers.typescript, 'const total = sum(items)', false).map(([t, c]) => [t.trim(), c]))
    expect(light.sum).not.toBe(got.sum)
  })

  it('keeps a line state the grammar sees as equal (an edit re-colours only what changed)', async () => {
    const monaco = fakeMonaco()
    const tm = createTextmate({ monaco })
    await tm.useLanguage('python')
    const p = monaco.providers.python
    const a = p.tokenize('x = 1', p.getInitialState()).endState
    const b = p.tokenize('y = 2', p.getInitialState()).endState
    expect(a.equals(b)).toBe(true)
    const open = p.tokenize('s = """start', p.getInitialState()).endState
    expect(open.equals(a)).toBe(false)
  })

  it('a language without a VS Code grammar keeps Monaco colours', async () => {
    const monaco = fakeMonaco()
    const tm = createTextmate({ monaco })
    expect(await tm.useLanguage('plaintext')).toBe(false)
    expect(monaco.providers.plaintext).toBeUndefined()
  })

  it('theme rules: one per colour, the text colour left to Tessel, font styles kept', () => {
    const rules = rulesFor(['', '#D4D4D4', '#569CD6'])
    expect(rules.find((r) => r.token === 't1')).toBeUndefined()
    expect(rules.find((r) => r.token === 't2')).toEqual({ token: 't2', foreground: '569cd6' })
    expect(rules.find((r) => r.token === 't2.s1')).toEqual({ token: 't2.s1', foreground: '569cd6', fontStyle: 'italic' })
    expect(rules.find((r) => r.token === 't1.s2')).toEqual({ token: 't1.s2', fontStyle: 'bold' })
  })

  it("VS Code's colours for the find widget and the rest over the code; never the editor's own background", () => {
    const dark = vscodeColours(true)
    expect(dark['editorWidget.background']).toBe('#202122')
    expect(dark['focusBorder']).toBe('#3994BCB3')
    expect(dark['inputOption.activeBackground']).toBeTruthy()
    expect(dark['editor.findMatchBackground']).toBeTruthy()
    expect(dark['minimapSlider.background']).toBeTruthy()
    expect(dark['editor.background']).toBeUndefined()
    expect(dark['editorLineNumber.foreground']).toBeUndefined()
    expect(vscodeColours(false)['editorWidget.background']).not.toBe(dark['editorWidget.background'])
  })
})
