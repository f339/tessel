// A file's symbols for the explorer's Outline, read the way VS Code's Outline
// reads them: Monaco's outline model service (the language services'
// document symbol providers: TypeScript, JavaScript, JSON, CSS, HTML…).
// Loaded with Monaco (monacoSetup.js), never before.
import { StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices.js'
import { IOutlineModelService } from 'monaco-editor/editor/contrib/documentSymbols/browser/outlineModel.js'
import { ILanguageFeaturesService } from 'monaco-editor/editor/common/services/languageFeatures.js'
import { CancellationTokenSource } from 'monaco-editor/base/common/cancellation.js'

const plainRange = (r) => (r ? { startLineNumber: r.startLineNumber, startColumn: r.startColumn, endLineNumber: r.endLineNumber, endColumn: r.endColumn } : null)
function plain(symbols) {
  return (symbols || []).map((s) => ({
    name: s.name,
    detail: s.detail || '',
    kind: s.kind,
    deprecated: Array.isArray(s.tags) && s.tags.includes(1),
    range: plainRange(s.range),
    selectionRange: plainRange(s.selectionRange),
    children: plain(s.children)
  }))
}

// Does a language service give this file's symbols? (VS Code's "The active
// editor cannot provide outline information." when not.)
export function canGiveSymbols(model) {
  try {
    return !!(model && !model.isDisposed() && StandaloneServices.get(ILanguageFeaturesService).documentSymbolProvider.has(model))
  } catch {
    return false
  }
}

let pending = null
// -> null when no language service gives this file's symbols, else the tree
// [{ name, detail, kind (VS Code's SymbolKind), deprecated, range,
//    selectionRange, children }].
export async function documentSymbols(model) {
  if (!canGiveSymbols(model)) return null
  if (pending) pending.cancel()
  const cts = new CancellationTokenSource()
  pending = cts
  try {
    const outline = await StandaloneServices.get(IOutlineModelService).getOrCreate(model, cts.token)
    if (cts.token.isCancellationRequested) return null
    return plain(outline.getTopLevelSymbols())
  } catch {
    return null
  } finally {
    if (pending === cts) pending = null
    cts.dispose()
  }
}
