// Builds Tessel's file icons from VS Code's own icon theme ("Seti", VS Code's
// default): node scripts/gen-file-icons.mjs <path to a VS Code checkout>
//
// Writes src/renderer/src/fileIcons/seti.json (the icons, their colours and
// which file gets which, as VS Code resolves them) and copies seti.woff (the
// icon font) next to it. Seti UI: MIT, Copyright (c) 2014 Jesse Weed;
// VS Code's theme-seti and language lists: MIT, Copyright (c) Microsoft
// Corporation (THIRD_PARTY_NOTICES.md).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.argv[2]
if (!root) {
  console.error('usage: node scripts/gen-file-icons.mjs <vscode checkout>')
  process.exit(1)
}
const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '..', 'src', 'renderer', 'src', 'fileIcons')
const themeDir = path.join(root, 'extensions', 'theme-seti', 'icons')
const theme = JSON.parse(fs.readFileSync(path.join(themeDir, 'vs-seti-icon-theme.json'), 'utf8'))

// Which language a file is, from VS Code's built-in language extensions
// (their extensions and file names), only for the languages Seti draws.
const wanted = new Set(Object.keys(theme.languageIds))
const byExt = {}
const byName = {}
const add = (map, key, id) => {
  const k = key.toLowerCase()
  if (!(k in map)) map[k] = id
}
for (const dir of fs.readdirSync(path.join(root, 'extensions'))) {
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'extensions', dir, 'package.json'), 'utf8'))
  } catch {
    continue
  }
  for (const l of (pkg.contributes && pkg.contributes.languages) || []) {
    if (!wanted.has(l.id)) continue
    for (const e of l.extensions || []) add(byExt, e.replace(/^\./, ''), l.id)
    for (const f of l.filenames || []) add(byName, f, l.id)
  }
}
// Languages Seti draws that come from the usual marketplace extensions, not
// from VS Code itself: their common file types.
const EXTRA = {
  vue: ['vue'],
  kotlin: ['kt', 'kts'],
  sass: ['sass'],
  stylus: ['styl'],
  haskell: ['hs', 'lhs'],
  elixir: ['ex', 'exs'],
  elm: ['elm'],
  ocaml: ['ml', 'mli'],
  terraform: ['tf', 'tfvars'],
  gradle: ['gradle'],
  haml: ['haml'],
  erb: ['erb'],
  bicep: ['bicep'],
  godot: ['gd'],
  haxe: ['hx'],
  jinja: ['jinja', 'jinja2', 'j2'],
  mustache: ['mustache'],
  nunjucks: ['njk', 'nunjucks'],
  rescript: ['res', 'resi'],
  vala: ['vala', 'vapi'],
  postcss: ['pcss', 'postcss'],
  blade: ['blade.php'],
  argdown: ['argdown', 'ad']
}
for (const [id, exts] of Object.entries(EXTRA)) if (wanted.has(id)) for (const e of exts) add(byExt, e, id)

// Every icon: [code point, dark colour, light colour].
const icons = {}
for (const [id, def] of Object.entries(theme.iconDefinitions)) {
  if (id.endsWith('_light')) continue
  const light = theme.iconDefinitions[id + '_light']
  const cp = parseInt(String(def.fontCharacter).replace(/^\\/, ''), 16)
  icons[id] = [cp, def.fontColor || null, (light && light.fontColor) || def.fontColor || null]
}
const lower = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k.toLowerCase(), v]))
const data = {
  source: `VS Code theme-seti (${theme.version})`,
  file: theme.file,
  icons,
  fileNames: lower(theme.fileNames),
  fileExtensions: lower(theme.fileExtensions),
  languageIds: theme.languageIds,
  languageByExtension: byExt,
  languageByName: byName
}
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'seti.json'), JSON.stringify(data) + '\n')
fs.copyFileSync(path.join(themeDir, 'seti.woff'), path.join(out, 'seti.woff'))
console.log(`${Object.keys(icons).length} icons, ${Object.keys(data.fileExtensions).length} extensions, ${Object.keys(data.fileNames).length} names, ${Object.keys(byExt).length + Object.keys(byName).length} language rules -> ${out}`)
