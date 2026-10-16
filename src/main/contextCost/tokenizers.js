// The local tokenizers of Settings > Context (src/shared/tokenCounters.js
// says which model gets which). Loaded only in the counting process
// (worker.js): the o200k rank table alone takes tenths of a second to read
// and tens of MB once read, which the main process never pays.
//   OpenAI      gpt-tokenizer (MIT, pure JS, shipped): o200k_base, and
//               o200k_harmony for gpt-oss (the same ranks, Harmony's special
//               tokens). Its counts match OpenAI's tiktoken test vectors.
//   Kimi        its tiktoken.model (downloaded, hfTokenizers.js), read into
//               gpt-tokenizer with Kimi's split pattern (tokenization_kimi.py)
//               written for JavaScript's `v` flag: its `&&[^\p{Han}]` class
//               intersections become `--[\p{sc=Han}]`, its (?i:...) suffixes
//               spelled out in both cases.
//   Open models their tokenizer.json (downloaded) with @huggingface/tokenizers
//               (Apache-2.0), through the model's chat template (rendered with
//               @huggingface/jinja, MIT, as transformers' apply_chat_template).
// Bare text is counted as text: a special token written in a file
// ("<|endoftext|>") counts as the characters it is, as the agent reads it.
const PLAIN = { disallowedSpecial: new Set() }

// The shipped encodings, read on first use (separate chunks of the bundle).
const ENCODERS = {
  o200k_base: () => import('gpt-tokenizer/encoding/o200k_base'),
  o200k_harmony: () => import('gpt-tokenizer/encoding/o200k_harmony')
}
export const ENCODINGS = Object.keys(ENCODERS)

const loaded = new Map() // encoding -> Promise<module>

export function encoding(name) {
  if (!ENCODERS[name]) return Promise.reject(new Error(`Unknown encoding ${name}`)) // i18n-ignore internal
  if (!loaded.has(name)) {
    const p = ENCODERS[name]()
    p.catch(() => loaded.delete(name))
    loaded.set(name, p)
  }
  return loaded.get(name)
}

// -> the number of tokens of each text.
export async function countEncoding(name, texts) {
  const enc = await encoding(name)
  return texts.map((text) => (text ? enc.countTokens(String(text), PLAIN) : 0))
}

// Kimi's split pattern (tokenization_kimi.py pat_str), for the `v` flag.
const NOT_HAN_UPPER = String.raw`[[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]--[\p{sc=Han}]]`
const NOT_HAN_LOWER = String.raw`[[\p{Ll}\p{Lm}\p{Lo}\p{M}]--[\p{sc=Han}]]`
const SUFFIX = String.raw`(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])?`
export const KIMI_PATTERN = [
  String.raw`[\p{sc=Han}]+`,
  String.raw`[^\r\n\p{L}\p{N}]?${NOT_HAN_UPPER}*${NOT_HAN_LOWER}+${SUFFIX}`,
  String.raw`[^\r\n\p{L}\p{N}]?${NOT_HAN_UPPER}+${NOT_HAN_LOWER}*${SUFFIX}`,
  String.raw`\p{N}{1,3}`,
  String.raw` ?[^\s\p{L}\p{N}]+[\r\n]*`,
  String.raw`\s*[\r\n]+`,
  String.raw`\s+(?!\S)`,
  String.raw`\s+`
].join('|')
const KIMI_RESERVED = 256

// A tiktoken ranks file ("<base64 token> <rank>" per line) as gpt-tokenizer
// takes it: each token as text when it is valid UTF-8, else as its bytes.
export function parseTiktokenRanks(text) {
  const lines = String(text).split('\n')
  const ranks = []
  const strict = new TextDecoder('utf-8', { fatal: true })
  for (const line of lines) {
    const space = line.indexOf(' ')
    if (space <= 0) continue
    const bytes = Buffer.from(line.slice(0, space), 'base64')
    const rank = Number(line.slice(space + 1))
    if (!Number.isInteger(rank) || rank < 0) continue
    let value
    try {
      value = strict.decode(bytes)
      if (Buffer.byteLength(value) !== bytes.length) value = [...bytes]
    } catch {
      value = [...bytes]
    }
    ranks[rank] = value
  }
  return ranks
}

// Kimi's tokenizer: its ranks, then 256 special ids named by its
// tokenizer_config.json (the others "<|reserved_token_N|>").
export async function kimiTokenizer(ranksText, configJson, jinjaFile = null) {
  const { GptEncoding } = await import('gpt-tokenizer/GptEncoding')
  const ranks = parseTiktokenRanks(ranksText)
  const named = (configJson && configJson.added_tokens_decoder) || {}
  const special = new Map()
  for (let id = ranks.length; id < ranks.length + KIMI_RESERVED; id++) special.set((named[String(id)] && named[String(id)].content) || `<|reserved_token_${id}|>`, id)
  const enc = new GptEncoding({ bytePairRankDecoder: ranks, specialTokensEncoder: special, tokenSplitRegex: new RegExp(KIMI_PATTERN, 'gv') })
  const n = (text) => (text ? enc.countTokens(String(text), PLAIN) : 0)
  // The template's own markers are special tokens; the text inside is not.
  const rendered = (text) => (text ? enc.countTokens(String(text), { allowedSpecial: 'all' }) : 0)
  return withTemplate({ n, rendered, config: configJson || {}, jinjaFile })
}

const tokenText = (v) => (typeof v === 'string' ? v : v && typeof v.content === 'string' ? v.content : undefined)

// The chat template a tokenizer_config.json names (one string, or a list of
// named ones: "default", or "tool_use" when tools are given), unless the
// repository's own chat_template.jinja replaces it (as in transformers).
export function pickTemplate(config, jinjaFile, withTools) {
  if (typeof jinjaFile === 'string' && jinjaFile.trim()) return jinjaFile
  const ct = config && config.chat_template
  if (typeof ct === 'string') return ct
  if (Array.isArray(ct)) {
    const named = (n) => ct.find((x) => x && x.name === n && typeof x.template === 'string')
    return ((withTools && named('tool_use')) || named('default') || ct.find((x) => x && typeof x.template === 'string') || {}).template || null
  }
  return null
}

const asFunction = (tl) => ({
  type: 'function',
  function: { name: tl.name, description: tl.description || '', parameters: tl.input_schema || tl.inputSchema || { type: 'object', properties: {} } }
})

// count(item) -> { tokens, template }: what the model sees of the item. With
// a chat template, the item is rendered in a conversation and counted with
// its role markers and the model's own tool format, minus the same
// conversation without it:
//   text  - joined to the system prompt;
//   tools - given as `tools` (the OpenAI function format templates expect),
//           or as JSON in the system prompt when the template has no tools.
// No template (or noTemplate: Gemma read as Gemini's tokenizer, which Google
// counts as text), or one that refuses the conversation: the bare text.
async function withTemplate({ n, rendered = n, config, jinjaFile, noTemplate = false }) {
  let Template = null
  if (!noTemplate) {
    try {
      ;({ Template } = await import('@huggingface/jinja'))
    } catch {
      Template = null
    }
  }
  const templates = new Map() // source -> Template
  const vars = {
    bos_token: tokenText(config.bos_token) ?? '',
    eos_token: tokenText(config.eos_token) ?? '',
    unk_token: tokenText(config.unk_token),
    pad_token: tokenText(config.pad_token),
    add_generation_prompt: false
  }
  function render(source, messages, tools) {
    if (!templates.has(source)) templates.set(source, new Template(source))
    return templates.get(source).render({ ...vars, messages, ...(tools ? { tools } : {}) })
  }
  const user = { role: 'user', content: '.' }
  const system = (content) => ({ role: 'system', content })
  const probe = { name: 'probe', description: 'Probe.', input_schema: { type: 'object', properties: {} } } // i18n-ignore
  const toolsJson = (item) => JSON.stringify((item.tools || []).map(asFunction))
  function count(item) {
    const withTools = item.kind === 'tools'
    const bare = () => ({ tokens: withTools ? n(toolsJson(item)) : n(item.text), template: false })
    const source = Template ? pickTemplate(config, jinjaFile, withTools) : null
    if (!source) return bare()
    try {
      if (withTools && /\btools\b/.test(source)) {
        const base = render(source, [system('.'), user], [asFunction(probe)])
        const full = render(source, [system('.'), user], [asFunction(probe), ...(item.tools || []).map(asFunction)])
        return { tokens: Math.max(0, rendered(full) - rendered(base)), template: true }
      }
      const text = withTools ? toolsJson(item) : String(item.text || '')
      const base = render(source, [system('.'), user])
      const full = render(source, [system(`.\n\n${text}`), user])
      return { tokens: Math.max(0, rendered(full) - rendered(base)), template: true }
    } catch {
      return bare()
    }
  }
  return { count, countText: n }
}

// A Hugging Face tokenizer, from its tokenizer.json and tokenizer_config.json
// (parsed) and its chat_template.jinja (text) when it has one.
export async function hfTokenizer(tokenizerJson, configJson, jinjaFile = null, { noTemplate = false } = {}) {
  const { Tokenizer } = await import('@huggingface/tokenizers')
  const config = configJson || {}
  const tok = new Tokenizer(tokenizerJson, config)
  const n = (text) => (text ? tok.encode(String(text), { add_special_tokens: false }).ids.length : 0)
  return withTemplate({ n, config, jinjaFile, noTemplate })
}
