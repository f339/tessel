// VS Code's icon and colour for each kind of symbol (its SymbolKind, 0 to
// 25), as its Outline, breadcrumbs and suggestions show them: the codicon
// (symbolIcons / Codicon.symbol*) and the dark theme's default colour
// (symbolIcon.*Foreground; null: the text's colour).
const PURPLE = '#B180D7'
const ORANGE = '#EE9D28'
const BLUE = '#75BEFF'
const KINDS = [
  ['symbol-file', null], // File
  ['symbol-module', null], // Module
  ['symbol-namespace', null], // Namespace
  ['symbol-package', null], // Package
  ['symbol-class', ORANGE], // Class
  ['symbol-method', PURPLE], // Method
  ['symbol-property', null], // Property
  ['symbol-field', BLUE], // Field
  ['symbol-constructor', PURPLE], // Constructor
  ['symbol-enum', ORANGE], // Enum
  ['symbol-interface', BLUE], // Interface
  ['symbol-function', PURPLE], // Function
  ['symbol-variable', BLUE], // Variable
  ['symbol-constant', null], // Constant
  ['symbol-string', null], // String
  ['symbol-number', null], // Number
  ['symbol-boolean', null], // Boolean
  ['symbol-array', null], // Array
  ['symbol-object', null], // Object
  ['symbol-key', null], // Key
  ['symbol-null', null], // Null
  ['symbol-enum-member', BLUE], // EnumMember
  ['symbol-struct', null], // Struct
  ['symbol-event', ORANGE], // Event
  ['symbol-operator', null], // Operator
  ['symbol-type-parameter', null] // TypeParameter
]

export function symbolIcon(kind) {
  const k = KINDS[kind] || KINDS[12]
  return { name: k[0], color: k[1] }
}

// The symbols around a position, outermost first (VS Code's breadcrumbs and
// the Outline's "Follow Cursor"): those whose range holds it.
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
