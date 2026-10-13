// Builds the editor's colours from VS Code's own default themes ("Dark 2026"
// and "Light 2026", VS Code's defaults): node scripts/gen-vscode-themes.mjs
// <path to a VS Code checkout>
//
// Each theme's include chain (2026 > Modern > Plus > Visual Studio) merged as
// VS Code merges it: the included theme's colours and token colours first,
// the including theme's after (they win). Writes
// src/renderer/src/editor/themes/vscode-dark.json and vscode-light.json, in
// the TextMate theme format Shiki reads. VS Code: MIT, Copyright (c)
// Microsoft Corporation (THIRD_PARTY_NOTICES.md).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.argv[2]
if (!root) {
  console.error('usage: node scripts/gen-vscode-themes.mjs <vscode checkout>')
  process.exit(1)
}
const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '..', 'src', 'renderer', 'src', 'editor', 'themes')
const dir = path.join(root, 'extensions', 'theme-defaults', 'themes')

// JSON with comments and trailing commas (VS Code's theme files).
function jsonc(file) {
  const s = fs.readFileSync(file, 'utf8')
  let text = ''
  let inString = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      text += c
      if (c === '\\') text += s[++i]
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      text += c
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++
      text += '\n'
    } else if (c === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i) + 1
    } else text += c
  }
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'))
}

function load(file) {
  const theme = jsonc(path.join(dir, file))
  const base = theme.include ? load(theme.include.replace(/^\.\//, '')) : { colors: {}, tokenColors: [] }
  const own = Array.isArray(theme.tokenColors) ? theme.tokenColors : []
  return { colors: { ...base.colors, ...(theme.colors || {}) }, tokenColors: [...base.tokenColors, ...own] }
}

fs.mkdirSync(out, { recursive: true })
for (const [file, name, type] of [
  ['2026-dark.json', 'vscode-dark', 'dark'],
  ['2026-light.json', 'vscode-light', 'light']
]) {
  const t = load(file)
  const theme = { name, displayName: `VS Code ${type === 'dark' ? 'Dark' : 'Light'} 2026`, type, colors: t.colors, tokenColors: t.tokenColors }
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(theme) + '\n')
  console.log(`${name}: ${Object.keys(t.colors).length} colours, ${t.tokenColors.length} token rules`)
}
