// A symbol's icon as VS Code draws it (SymbolKinds.toIcon in
// editor/common/languages.ts): the codicon of its kind (VS Code's SymbolKind,
// 0-25) and its colour in VS Code's dark themes (symbolIcons.ts); null: the
// text's own colour. Used by the Outline and the editor's breadcrumbs.
const NAMES = [
  'symbol-file',
  'symbol-module',
  'symbol-namespace',
  'symbol-package',
  'symbol-class',
  'symbol-method',
  'symbol-property',
  'symbol-field',
  'symbol-constructor',
  'symbol-enum',
  'symbol-interface',
  'symbol-function',
  'symbol-variable',
  'symbol-constant',
  'symbol-string',
  'symbol-number',
  'symbol-boolean',
  'symbol-array',
  'symbol-object',
  'symbol-key',
  'symbol-null',
  'symbol-enum-member',
  'symbol-struct',
  'symbol-event',
  'symbol-operator',
  'symbol-type-parameter'
]
const ORANGE = '#EE9D28' // class, enum, event
const PURPLE = '#B180D7' // method, function, constructor
const BLUE = '#75BEFF' // variable, field, interface, enum member
const COLORS = { 4: ORANGE, 9: ORANGE, 23: ORANGE, 5: PURPLE, 11: PURPLE, 8: PURPLE, 12: BLUE, 7: BLUE, 10: BLUE, 21: BLUE }

// -> { name: the codicon ('symbol-class'…), color: '#RRGGBB' or null }
export function symbolIcon(kind) {
  const k = Number.isInteger(kind) && kind >= 0 && kind < NAMES.length ? kind : 6 // VS Code: symbol-property for an unknown kind
  return { name: NAMES[k], color: COLORS[k] || null }
}

// The symbols around a position, outermost first (VS Code's breadcrumbs):
// those whose range holds it.
export function symbolsAt(tree, line, column) {
  const out = []
  const holds = (r) =>
    r &&
    (line > r.startLineNumber || (line === r.startLineNumber && column >= r.startColumn)) &&
    (line < r.endLineNumber || (line === r.endLineNumber && column <= r.endColumn))
  let level = tree || []
  for (;;) {
    const s = level.find((x) => holds(x.range))
    if (!s) break
    out.push(s)
    level = s.children || []
  }
  return out
}
