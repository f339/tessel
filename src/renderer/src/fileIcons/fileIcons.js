// File icons as VS Code draws them with its default icon theme (Seti): a
// glyph of the Seti font in the colour of the file's type. Folders get none,
// as in VS Code (the arrow says it is a folder).
//
// Which icon, in VS Code's order (its getIconClasses.ts and
// fileIconThemeData.ts: the most specific CSS rule wins): the file's exact
// name, then its longest known extension ("d.ts" before "ts"), then its
// language, then the plain file icon. A light theme takes the same icon in
// its light colour. The data comes from VS Code (scripts/gen-file-icons.mjs).
import data from './seti.json'
import './fileIcons.css'

const memo = new Map()

function languageOf(name, exts) {
  if (data.languageByName[name]) return data.languageByName[name]
  for (const e of exts) if (data.languageByExtension[e]) return data.languageByExtension[e]
  return null
}

// "a.d.ts" -> ["d.ts", "ts"]: every extension, the longest first.
function extensionsOf(name) {
  const parts = name.split('.')
  const out = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(i).join('.'))
  return out
}

// The icon id for a file name (any case), or the plain file's.
export function fileIconId(fileName) {
  const name = String(fileName || '').toLowerCase()
  if (memo.has(name)) return memo.get(name)
  let id = data.fileNames[name] || null
  const exts = name.length <= 255 ? extensionsOf(name) : []
  if (!id) for (const e of exts) if ((id = data.fileExtensions[e] || null)) break
  if (!id) {
    const lang = languageOf(name, exts)
    id = (lang && data.languageIds[lang]) || null
  }
  id = id && data.icons[id] ? id : data.file
  if (memo.size > 2000) memo.clear()
  memo.set(name, id)
  return id
}

// { glyph, color } for a file (light: the light theme's colour), or null
// for a folder.
export function fileIcon(fileName, { dir = false, light = false } = {}) {
  if (dir) return null
  const icon = data.icons[fileIconId(baseName(fileName))]
  if (!icon) return null
  return { glyph: String.fromCodePoint(icon[0]), color: (light ? icon[2] : icon[1]) || null }
}

export function baseName(p) {
  const s = String(p || '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(i + 1) : s
}
