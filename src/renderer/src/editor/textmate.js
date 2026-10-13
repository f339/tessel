// VS Code's colouring in Tessel's editor: its TextMate grammars and its
// default colours (Dark+ / Light+, which Dark Modern and Light Modern keep for
// code), through Shiki (MIT). Monaco's own colouring (Monarch) knows keywords,
// strings and comments; VS Code's grammars also tell functions, variables,
// types, parameters and properties apart, as VS Code shows them.
//
// Shiki's JavaScript regex engine, not its WebAssembly one: the window's
// content security policy allows no WebAssembly. A grammar loads the first
// time a file of its language opens. The tokens carry the colour of the
// theme's colour map (t12, t12.s1 with a font style), and the editor's theme
// ('tessel', EditorPane.vue) gets one rule per colour: Tessel keeps its own
// background and text colour.
//
// Adapted from Shiki's Monaco integration (@shikijs/monaco, MIT, Copyright (c)
// 2021 Pine Wu, 2023 Anthony Fu): its tokens provider and colour map, without
// replacing monaco.editor.setTheme (Tessel names its own theme), with the
// grammar's own state equality (VS Code's) so an edit re-colours only the
// lines it changes.
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages } from 'shiki/langs'
// Only VS Code's two themes (not Shiki's other sixty).
import darkPlus from 'shiki/dist/themes/dark-plus.mjs'
import lightPlus from 'shiki/dist/themes/light-plus.mjs'
import { INITIAL, EncodedTokenMetadata, FontStyle } from 'shiki/textmate'

export const DARK_THEME = 'dark-plus'
export const LIGHT_THEME = 'light-plus'

// Monaco language id -> Shiki grammar, where the names differ. A .tsx or
// .jsx file has its own id (as in VS Code), so a .ts file keeps the plain
// TypeScript grammar (in which <T>(x) => x is a generic arrow, not a tag).
const GRAMMAR_OF = {
  typescriptreact: 'tsx',
  javascriptreact: 'jsx',
  shell: 'shellscript',
  dockerfile: 'docker',
  mysql: 'sql',
  pgsql: 'sql',
  restructuredtext: 'rst',
  protobuf: 'proto',
  systemverilog: 'system-verilog',
  plaintext: null
}
// The grammar for a Monaco language, or null (Monaco's own colouring stays).
export function grammarFor(languageId) {
  const name = Object.hasOwn(GRAMMAR_OF, languageId) ? GRAMMAR_OF[languageId] : languageId
  return name && Object.hasOwn(bundledLanguages, name) ? name : null
}

// Languages VS Code colours that Monaco does not know: registered so their
// files get VS Code's grammar (editorLanguage.js names them).
export const EXTRA_LANGUAGES = [
  { id: 'typescriptreact', extensions: ['.tsx'], aliases: ['TypeScript JSX', 'tsx'] },
  { id: 'javascriptreact', extensions: ['.jsx'], aliases: ['JavaScript JSX', 'jsx'] },
  { id: 'vue', extensions: ['.vue'], aliases: ['Vue'] },
  { id: 'svelte', extensions: ['.svelte'], aliases: ['Svelte'] },
  { id: 'astro', extensions: ['.astro'], aliases: ['Astro'] },
  { id: 'toml', extensions: ['.toml'], filenames: ['Cargo.lock', 'uv.lock', 'poetry.lock'], aliases: ['TOML'] },
  { id: 'prisma', extensions: ['.prisma'], aliases: ['Prisma'] },
  { id: 'zig', extensions: ['.zig'], aliases: ['Zig'] },
  { id: 'nix', extensions: ['.nix'], aliases: ['Nix'] },
  { id: 'gdscript', extensions: ['.gd'], aliases: ['GDScript'] },
  { id: 'glsl', extensions: ['.glsl', '.vert', '.frag'], aliases: ['GLSL'] },
  { id: 'hlsl', extensions: ['.hlsl', '.fx'], aliases: ['HLSL'] }
]

class TokenizerState {
  constructor(ruleStack) {
    this.ruleStack = ruleStack
  }
  clone() {
    return new TokenizerState(this.ruleStack)
  }
  equals(other) {
    if (!(other instanceof TokenizerState)) return false
    if (other.ruleStack === this.ruleStack) return true
    return !!(this.ruleStack && typeof this.ruleStack.equals === 'function' && this.ruleStack.equals(other.ruleStack))
  }
}

const STYLE_BITS = [
  [FontStyle.Italic, 'italic'],
  [FontStyle.Bold, 'bold'],
  [FontStyle.Underline, 'underline'],
  [FontStyle.Strikethrough, 'strikethrough']
]
function fontStyleOf(bits) {
  return STYLE_BITS.filter(([b]) => bits & b)
    .map(([, s]) => s)
    .join(' ')
}
// The colour map's colours, as Monaco theme rules: t<index> (and
// t<index>.s<style bits>). Index 1 is the theme's text colour: left to
// Tessel's own.
export function rulesFor(colorMap) {
  const rules = []
  const styles = [FontStyle.Italic, FontStyle.Bold, FontStyle.Underline, FontStyle.Strikethrough]
  const combos = []
  for (let bits = 1; bits < 16; bits++) if (styles.some((s) => bits & s)) combos.push(bits)
  for (let i = 1; i < colorMap.length; i++) {
    const c = String(colorMap[i] || '').replace(/^#/, '').toLowerCase()
    const fg = i > 1 && /^[0-9a-f]{6}([0-9a-f]{2})?$/.test(c) ? c.slice(0, 6) : undefined
    if (fg) rules.push({ token: `t${i}`, foreground: fg })
    for (const bits of combos) rules.push({ token: `t${i}.s${bits}`, ...(fg ? { foreground: fg } : {}), fontStyle: fontStyleOf(bits) })
  }
  return rules
}

export function createTextmate({ monaco, maxLineLength = 20000, timeLimitMs = 500, log = () => {} }) {
  let highlighter = null
  let ready = null
  let themeName = DARK_THEME
  let colorMap = []
  const providers = new Set() // Monaco language ids with VS Code's grammar
  const loading = new Map()
  const listeners = new Set()
  const changed = () => listeners.forEach((fn) => fn())

  for (const l of EXTRA_LANGUAGES) {
    if (!monaco.languages.getLanguages().some((x) => x.id === l.id)) monaco.languages.register(l)
  }

  function start() {
    if (!ready) {
      ready = createHighlighterCore({
        themes: [darkPlus, lightPlus],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true })
      }).then((h) => {
        highlighter = h
        colorMap = h.setTheme(themeName).colorMap
        changed()
        return h
      })
      ready.catch((err) => log(`textmate: Shiki did not start: ${err && err.message}`)) // i18n-ignore
    }
    return ready
  }

  function provider(languageId, grammarName) {
    return {
      getInitialState: () => new TokenizerState(INITIAL),
      tokenize(line, state) {
        if (line.length >= maxLineLength) return { endState: state, tokens: [{ startIndex: 0, scopes: '' }] }
        const grammar = highlighter.getLanguage(grammarName)
        const result = grammar.tokenizeLine2(line, state.ruleStack, timeLimitMs)
        const tokens = []
        for (let j = 0; j < result.tokens.length / 2; j++) {
          const meta = result.tokens[2 * j + 1]
          const fg = EncodedTokenMetadata.getForeground(meta)
          const style = EncodedTokenMetadata.getFontStyle(meta)
          tokens.push({ startIndex: result.tokens[2 * j], scopes: style > 0 ? `t${fg}.s${style}` : fg > 1 ? `t${fg}` : '' })
        }
        return { endState: new TokenizerState(result.ruleStack), tokens }
      }
    }
  }

  // A file of this language opened: its grammar (and the ones it embeds),
  // then VS Code's colours for it (Monaco colours the file again).
  function useLanguage(languageId) {
    const name = grammarFor(languageId)
    if (!name || providers.has(languageId)) return Promise.resolve(providers.has(languageId))
    if (loading.has(languageId)) return loading.get(languageId)
    const p = start()
      .then((h) => h.loadLanguage(bundledLanguages[name]))
      .then(() => {
        monaco.languages.setTokensProvider(languageId, provider(languageId, name))
        providers.add(languageId)
        return true
      })
      .catch((err) => {
        log(`textmate: no VS Code grammar for ${languageId}: ${err && err.message}`) // i18n-ignore
        return false
      })
      .finally(() => loading.delete(languageId))
    loading.set(languageId, p)
    return p
  }

  // The theme's rules for the editor's theme; a switch between dark and
  // light colours the open files again (the tokens carry the colour map's
  // indexes).
  function rules(dark) {
    const want = dark ? DARK_THEME : LIGHT_THEME
    if (highlighter && want !== themeName) {
      themeName = want
      colorMap = highlighter.setTheme(want).colorMap
      for (const id of providers) monaco.languages.setTokensProvider(id, provider(id, grammarFor(id)))
    } else themeName = want
    return highlighter ? rulesFor(colorMap) : []
  }

  return {
    start,
    useLanguage,
    rules,
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    hasGrammar: (languageId) => providers.has(languageId)
  }
}
