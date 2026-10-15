// The Antigravity CLI's (agy) models, as it names them, for the model pickers
// and the pane header. Checked with agy 1.3.5:
// - `agy models` lists one row per effort variant: "gemini-4-argon-high\tGemini
//   4 Argon (High)". A model with one variant only ("gpt-oss-120b-medium") or
//   none ("claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)") exists too.
// - `--model <base> --effort <level>` picks the variant ("gemini-4-argon" +
//   low = gemini-4-argon-low); a variant id with another --effort, or an
//   effort the model lacks, is refused at launch.
// - Its footer ends with the model in use: "Gemini 4 Argon · high", or the
//   label when the model has one variant ("GPT-OSS 120B (Medium)"). /model and
//   /effort change it at once (and save "model": "<label>" in
//   ~/.gemini/antigravity-cli/settings.json).

export const ANTIGRAVITY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_WORDS = { low: 'low', medium: 'medium', high: 'high', 'extra high': 'xhigh', xhigh: 'xhigh', max: 'max', maximum: 'max' }
// A name as agy prints it: letters, digits, spaces and a few signs.
const NAME = /^[A-Za-z0-9][\w .+:/-]{0,79}$/

// "Gemini 4 Argon (High)" -> { name: 'Gemini 4 Argon', effort: 'high' }; a
// note that is not an effort ("Claude Sonnet 4.6 (Thinking)") stays in the
// name, effort null. null for anything that is not a model name.
export function antigravityLabelParts(label) {
  const text = String(label || '').replace(/\s+/g, ' ').trim()
  if (!text || text.length > 120) return null
  const m = /^(.*\S)\s*\(([^()]{1,20})\)$/.exec(text)
  const effort = m ? EFFORT_WORDS[m[2].trim().toLowerCase()] || null : null
  const name = effort ? m[1] : text
  if (!NAME.test(name.replace(/[()]/g, ''))) return null
  return { name, effort }
}

// A listed row that is one effort variant of a model: { base, effort, name }
// ("gemini-4-argon-high", "Gemini 4 Argon (High)" -> gemini-4-argon, high).
// null when its id and label do not both say the same effort.
export function antigravityVariant(row) {
  if (!row || typeof row.id !== 'string') return null
  const parts = antigravityLabelParts(row.label)
  if (!parts || !parts.effort) return null
  const suffix = `-${parts.effort}`
  if (!row.id.endsWith(suffix) || row.id.length <= suffix.length) return null
  return { base: row.id.slice(0, -suffix.length), effort: parts.effort, name: parts.name }
}

// Listed rows -> one row per model: { id, label, efforts? }. A model listed
// in two or more variants becomes its base id with the efforts it has (in
// agy's order: low, medium, high, xhigh, max); a single variant, or a model
// without one, stays as listed (its id launches as it is, with no effort).
export function groupAntigravityModels(rows) {
  const out = []
  const groups = new Map() // base -> its row in out
  const variants = (rows || []).map((r) => antigravityVariant(r))
  const counts = new Map()
  for (const v of variants) if (v) counts.set(v.base, (counts.get(v.base) || 0) + 1)
  ;(rows || []).forEach((row, i) => {
    if (!row || typeof row.id !== 'string') return
    const v = variants[i]
    if (!v || counts.get(v.base) < 2) {
      out.push({ ...row })
      return
    }
    let g = groups.get(v.base)
    if (!g) {
      g = { id: v.base, label: v.name, efforts: [] }
      groups.set(v.base, g)
      out.push(g)
    }
    if (!g.efforts.includes(v.effort)) g.efforts.push(v.effort)
    if (row.isDefault) g.isDefault = true
  })
  for (const g of groups.values()) g.efforts.sort((a, b) => ANTIGRAVITY_EFFORTS.indexOf(a) - ANTIGRAVITY_EFFORTS.indexOf(b))
  return out
}

// The model agy's footer names (its last lines on screen): the right-hand
// part of its status line, "Gemini 4 Argon · high" or "GPT-OSS 120B
// (Medium)". models: the picker's rows (grouped, or as listed); with a list,
// only a name in it counts, so a line of the conversation is never taken
// for the footer. -> { model, name, effort } (model: the row's id when
// listed, else the name) or null.
export function antigravityModelOnScreen(lines, models = []) {
  const list = Array.isArray(models) ? models : []
  const rows = (lines || []).map((l) => String(l || '').replace(/\s+$/, '')).filter((l) => l.trim())
  for (let i = rows.length - 1; i >= 0 && i >= rows.length - 3; i--) {
    // The footer's right-hand part comes after a run of spaces.
    const parts = rows[i].split(/\s{2,}/)
    if (parts.length < 2) continue
    const right = parts[parts.length - 1].trim()
    let name
    let effort
    const dot = /^(.+?)\s+·\s+(low|medium|high|xhigh|max)$/i.exec(right)
    if (dot) {
      name = dot[1].trim()
      effort = dot[2].toLowerCase()
    } else {
      const label = antigravityLabelParts(right)
      if (!label) continue
      // A model without effort variants: only its exact listed label.
      if (!label.effort && !list.some((m) => m && m.label === right)) continue
      name = label.name
      effort = label.effort
    }
    if (!NAME.test(name.replace(/[()]/g, ''))) continue
    const found = antigravityRow(list, name, effort)
    if (list.length && !found) continue
    return { model: found ? found.id : name, name: found ? antigravityRowName(found) : name, effort }
  }
  return null
}

// The row of a list for a model name (and effort): the grouped row named so,
// or the listed variant "<name> (<Effort>)".
function antigravityRow(list, name, effort) {
  const key = name.toLowerCase()
  return (
    list.find((m) => m && typeof m.label === 'string' && m.label.toLowerCase() === key) ||
    list.find((m) => {
      const parts = m && antigravityLabelParts(m.label)
      return parts && parts.name.toLowerCase() === key && (!effort || !parts.effort || parts.effort === effort)
    }) ||
    null
  )
}
const antigravityRowName = (row) => {
  const parts = antigravityLabelParts(row.label)
  return parts ? parts.name : row.label
}

// What the header shows for a model id or label agy reports (its --model,
// its settings, its conversation) with a list: the listed model's name and
// the effort its variant says. -> { model, name, effort } or null when the
// list does not know it.
export function antigravityListed(models, idOrLabel, effort = null) {
  const list = Array.isArray(models) ? models : []
  const value = String(idOrLabel || '').trim()
  if (!value) return null
  const byId = list.find((m) => m && m.id === value)
  if (byId) return { model: byId.id, name: antigravityRowName(byId), effort: effort || (antigravityLabelParts(byId.label) || {}).effort || null }
  // A variant id of a grouped row ("gemini-4-argon-high" -> gemini-4-argon, high).
  for (const level of ANTIGRAVITY_EFFORTS) {
    if (!value.endsWith(`-${level}`)) continue
    const base = list.find((m) => m && m.id === value.slice(0, -level.length - 1) && Array.isArray(m.efforts))
    if (base) return { model: base.id, name: base.label, effort: effort || level }
  }
  const parts = antigravityLabelParts(value)
  const row = parts && antigravityRow(list, parts.name, parts.effort || effort)
  return row ? { model: row.id, name: antigravityRowName(row), effort: effort || parts.effort || (antigravityLabelParts(row.label) || {}).effort || null } : null
}
