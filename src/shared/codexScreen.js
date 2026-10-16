// The model Codex's own footer names, read from its screen: the line under
// its input box, "GPT-6-Luna medium fast · C:\Tessel" (older versions:
// "gpt-5.5-codex high · 100% context left · ~/proj"). It is what the session
// runs right now, a /model or a "switch model?" answer included, before its
// next turn writes it to the rollout.
//
// Only a line below the input box ("›") counts, so a line of the
// conversation is never taken for the footer; no input box on screen (a
// picker or an approval drawn over it): null, what the pane showed stays.

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const SEGMENT = /^([A-Za-z][\w.:/-]*(?: [A-Za-z0-9][\w.:/-]*){0,2}?)(?:\s+(none|minimal|low|medium|high|xhigh|max))?(?:\s+fast)?$/i
const FAMILY = /^(?:gpt|o\d|codex)[\w.-]*$/i

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '-')

// lines: the screen's last lines, top to bottom. models: Codex's listed
// models ({ id, label }), optional. -> { model, name?, effort } or null.
export function codexModelOnScreen(lines, models = []) {
  const rows = (lines || []).map((l) => String(l || '').replace(/\s+$/, ''))
  let prompt = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (/^\s*›/.test(rows[i])) {
      prompt = i
      break
    }
  }
  if (prompt === -1) return null
  const list = Array.isArray(models) ? models.filter((m) => m && typeof m.id === 'string') : []
  for (let i = prompt + 1; i < rows.length; i++) {
    const first = rows[i].trim().split(/\s+·\s+/)[0]
    const m = SEGMENT.exec(first)
    if (!m) continue
    const name = m[1]
    const key = norm(name)
    const listed = list.find((x) => norm(x.id) === key || (typeof x.label === 'string' && norm(x.label) === key))
    // A model's name: listed, else one word of OpenAI's families or with a
    // digit (a local model); never a hint such as "tab to queue message".
    if (!listed && (/\s/.test(name) || !(FAMILY.test(key) || (/\d/.test(name) && /[-:]/.test(name))))) continue
    const effort = m[2] ? m[2].toLowerCase() : null
    return { model: listed ? listed.id : key, ...(listed && listed.label ? { name: listed.label } : {}), effort: EFFORTS.includes(effort) ? effort : null }
  }
  return null
}
