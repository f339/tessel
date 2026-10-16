// Live Share phase 2c: the share's hidden files never named in the free text
// guests read (a past conversation's prompt and turns, what a terminal agent
// said, the activity's messages and titles).
//
// guestText (shareChat.js) already hides every path outside the project and
// writes the ones inside it from its folder. Here, every word of such a text
// that reads as a path from the project's folder ("src/app.js", ".env",
// ".tessel/team/<token>/inbox.json", "dist\\out.js") is checked against the
// share's rules, as the Files tab is (shareScope.js hiddenOf: .git and
// .tessel always, secret names and what git ignores with the share's
// setting), and a hidden one becomes "…". All the words of an answer are
// checked together: one git check-ignore run at most (cached by the scope),
// charged to the guest's budget like the Files tab's (charge(): false ->
// the answer is busy), inside runAsGuest by the caller (git then runs with
// the guest's settings: no hooks, no filters).
//
// A file's contents an agent quoted are not names: guestText's secret
// patterns are what masks those.
import { cleanRel } from '../../shared/liveSharePath'
import { hiddenByName } from './shareScope.js'

const HIDDEN = '…'
// The words of a text that may be paths, at most, per answer.
const MAX_WORDS = 1000
// A path-like word: names and separators, not inside a longer word.
const WORD = /(?<![\w.@+~/\\-])[\w.@+~-]+(?:[\\/]+[\w.@+~-]+)*[\\/]?/g

// A word -> { rel, tail } (rel: the path it names from the project's folder,
// or null; tail: what follows it, kept: a sentence's dot, a separator).
function readWord(word) {
  const m = /^(.*?)([\\/.]*)$/s.exec(word)
  let body = m[1]
  const tail = m[2]
  body = body.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '')
  if (!body || cleanRel(body) !== body) return { rel: null, tail }
  return { rel: body, tail }
}
// Worth asking about: a word with a separator or a dot (a file's name), or a
// secret's name by itself (id_rsa).
const looksLikePath = (rel, settings) => rel.includes('/') || rel.includes('.') || hiddenByName(rel, settings)

// The path-like words of texts (from the project's folder), each once.
export function pathWords(texts, settings) {
  const out = new Set()
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue
    for (const m of text.matchAll(WORD)) {
      const { rel } = readWord(m[0])
      if (rel && looksLikePath(rel, settings)) out.add(rel)
      if (out.size >= MAX_WORDS) return [...out]
    }
  }
  return [...out]
}

// A text with each word naming a hidden path (hidden(rel) -> true) as "…".
export function hideWords(text, hidden) {
  if (typeof text !== 'string' || !text) return text
  return text.replace(WORD, (word) => {
    const { rel, tail } = readWord(word)
    return rel && hidden(rel) ? `${HIDDEN}${tail}` : word
  })
}

// texts -> the same texts, every hidden path named in them as "…". scope:
// the share's (shareScope.js), info: the project's root (scope.root), null
// for a project without one (then only what is hidden by its name);
// settings: the share's; charge: the guest's git budget (or null).
export async function hideHiddenNames(texts, { scope = null, info = null, settings = {}, charge = null } = {}) {
  const words = pathWords(texts, settings)
  if (!words.length) return texts
  let off
  if (scope && info) off = await scope.hiddenOf(info, words, settings, { charge })
  else off = new Set(words.filter((rel) => hiddenByName(rel, settings)))
  if (!off.size) return texts
  // A word asked about is hidden as given; past the words asked about, by
  // its name alone.
  const asked = new Set(words)
  const hidden = (rel) => off.has(rel) || (!asked.has(rel) && hiddenByName(rel, settings))
  return texts.map((t) => hideWords(t, hidden))
}
