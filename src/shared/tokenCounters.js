// Which token counter a model gets (Settings > Context, the Skills page's
// token tags, MCP Measure). The rule: the model's own tokenizer whenever one
// is public, a provider's count API only where none is, an estimate (≈)
// otherwise, and every number says which it is.
//   local, shipped     OpenAI o200k_base (GPT-4o and later, o-series, Codex)
//                      and o200k_harmony (gpt-oss), with gpt-tokenizer.
//   local, downloaded  the open models' own tokenizer files, fetched once on
//                      the user's click and checked by hash
//                      (main/contextCost/catalog.js): Kimi, DeepSeek V4,
//                      Qwen 3 / 3.5, GLM 5, MiniMax M, MiMo, Mistral Tekken,
//                      Muse Glimmer, Llama 3, and Gemma 3 / 4, which Google's
//                      own SDK uses as Gemini 2.x-3.5's local tokenizer.
//   api                Claude (count_tokens), later Gemini (countTokens),
//                      Grok (tokenize-text), Muse Spark / Wonder and GPT-6
//                      (responses input_tokens): no public tokenizer.
//   estimate           o200k_base times the family's factor, recalibrated
//                      from this user's own exact counts once there are
//                      enough (main/contextCost/counts.js).
// The mapping follows the research of 2026-10-16 (Tessel's token-counters
// notes); its worked examples are tokenCounters.spec.js.

// Claude Code's aliases, as the models they name today.
export const CLAUDE_ALIASES = Object.freeze({
  default: 'claude-opus-5-5',
  opus: 'claude-opus-5-5',
  opusplan: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
  mythos: 'claude-mythos-5-1'
})

// The model an agent runs when Tessel found none in its settings or session.
export const DEFAULT_MODELS = Object.freeze({
  claude: 'claude-opus-5-5',
  codex: 'gpt-5.5-codex',
  gemini: 'gemini-2.5-pro',
  antigravity: 'gemini-3.5-flash',
  qwen: 'qwen3-coder-plus',
  copilot: 'claude-sonnet-5',
  kimi: 'kimi-k2.6',
  cursor: 'composer-2',
  ollama: null
})

// o200k_base times this many when there is no exact count. Claude: Anthropic
// says tiktoken undercounts Claude by about 15-20%, and the tokenizer of Opus
// 4.7 and later counts up to a third more again.
export const ESTIMATE_FACTORS = Object.freeze({
  'anthropic-new': 1.35,
  'anthropic-old': 1.2,
  google: 1.1,
  xai: 1.05,
  meta: 1.1,
  openai: 1,
  other: 1.1
})

// Every local tokenizer: its name, whether it ships with Tessel, and whether
// its count goes through the model's chat template (false for Gemma read as
// Gemini's tokenizer: Google counts the text alone).
export const TOKENIZERS = Object.freeze({
  o200k_base: { name: 'o200k_base', shipped: true, template: false }, // i18n-ignore
  o200k_harmony: { name: 'o200k_harmony', shipped: true, template: false }, // i18n-ignore
  kimi: { name: 'Kimi', shipped: false, template: true }, // i18n-ignore
  'deepseek-v4': { name: 'DeepSeek V4', shipped: false, template: true }, // i18n-ignore
  qwen3: { name: 'Qwen 3', shipped: false, template: true }, // i18n-ignore
  'qwen3.5': { name: 'Qwen 3.5', shipped: false, template: true }, // i18n-ignore
  glm5: { name: 'GLM 5', shipped: false, template: true }, // i18n-ignore
  'minimax-m': { name: 'MiniMax M', shipped: false, template: true }, // i18n-ignore
  mimo: { name: 'MiMo', shipped: false, template: true }, // i18n-ignore
  tekken: { name: 'Mistral Tekken', shipped: false, template: true }, // i18n-ignore
  glimmer: { name: 'Muse Glimmer', shipped: false, template: true }, // i18n-ignore
  llama3: { name: 'Llama 3', shipped: false, template: true }, // i18n-ignore
  gemma3: { name: 'Gemma 3', shipped: false, template: false }, // i18n-ignore
  gemma4: { name: 'Gemma 4', shipped: false, template: false } // i18n-ignore
})

// The count APIs: what they need (an environment variable holding a key, or
// a sign-in Tessel already reads).
export const COUNT_APIS = Object.freeze({
  anthropic: { name: 'Anthropic count_tokens', key: 'ANTHROPIC_API_KEY' }, // i18n-ignore
  google: { name: 'Google countTokens', key: 'GEMINI_API_KEY' }, // i18n-ignore
  xai: { name: 'xAI tokenize-text', key: 'XAI_API_KEY' }, // i18n-ignore
  meta: { name: 'Meta input_tokens', key: 'MODEL_API_KEY' }, // i18n-ignore
  openai: { name: 'OpenAI input_tokens', key: 'OPENAI_API_KEY' } // i18n-ignore
})

// "anthropic/claude-sonnet-5" -> "claude-sonnet-5"; effort, speed, context
// and date suffixes dropped ("gpt-5.1-codex-max", "claude-opus-4-6[1m]",
// "-20251001", "-2024-08-06", "-0731"); an Ollama tag (":7b") dropped; a
// display name as some agents report it ("Gemini 4 Argon (High)") written
// as an id ("gemini-4-argon").
const SUFFIX = /(?:-(?:low|medium|high|xhigh|max|ultra|fast|thinking(?:-max)?|1m|highspeed|preview|latest|exp|instruct)|\[1m\]|-\d{8}|-\d{4}-\d{2}-\d{2}|-\d{4})$/
export function normalizeModelId(model) {
  if (typeof model !== 'string') return ''
  let m = model.trim().toLowerCase().slice(0, 160)
  m = m.split('/').filter(Boolean).pop() || ''
  m = m.replace(/^(?:(?:us|eu|apac|global)\.)?anthropic\./, '').replace(/@.*$/, '').replace(/:.*$/, '')
  m = m.replace(/\s*\([^)]*\)\s*$/, '').trim().replace(/\s+/g, '-')
  for (let i = 0; i < 6; i++) {
    const next = m.replace(SUFFIX, '')
    if (next === m) break
    m = next
  }
  return m
}

// A Claude id count_tokens takes: an alias resolved, "4.5" written "4-5".
export function claudeModelId(model) {
  const m = normalizeModelId(model)
  if (CLAUDE_ALIASES[m]) return CLAUDE_ALIASES[m]
  if (/^claude-[a-z0-9.-]{1,60}$/.test(m)) return m.replace(/(\d)\.(\d)/g, '$1-$2')
  return null
}
// Claude models before Opus 4.7's tokenizer.
export const claudeOldTokenizer = (id) => /^claude-(?:3|haiku-4|sonnet-4)/.test(String(id || '')) || /^claude-opus-4(?:-[0-6])?$/.test(String(id || ''))

const local = (tokenizer, m, extra = {}) => ({ kind: 'local', tokenizer, id: `local:${tokenizer}`, model: m, ...extra })
const api = (name, m, factorKey, extra = {}) => ({ kind: 'api', api: name, id: `${name}:${m}`, model: m, factor: ESTIMATE_FACTORS[factorKey], factorKey, ...extra })
const estimate = (family, m) => ({ kind: 'estimate', family, id: `estimate:${family}`, model: m || null, factor: ESTIMATE_FACTORS.other, factorKey: 'other' })

// -> { kind: 'local' | 'api' | 'estimate', id, model, defaulted,
//      tokenizer? (local), api?, factor?, factorKey? (api, estimate) }
export function tokenCounterFor(model, agent = null) {
  let m = normalizeModelId(model)
  let defaulted = false
  if (!m || m === 'auto' || (m === 'default' && agent !== 'claude')) {
    m = normalizeModelId(DEFAULT_MODELS[agent] || '')
    defaulted = true
  }
  const out = (counter) => ({ ...counter, defaulted })
  if (!m) return out(estimate('other', null))
  if (/^claude-/.test(m) || CLAUDE_ALIASES[m]) {
    const id = claudeModelId(m) || DEFAULT_MODELS.claude
    const key = claudeOldTokenizer(id) ? 'anthropic-old' : 'anthropic-new'
    return out(api('anthropic', id, key))
  }
  if (/^gpt-oss/.test(m)) return out(local('o200k_harmony', m))
  if (/^(gpt-5|gpt-4o|gpt-4\.[15]|o[134](-|$)|codex)/.test(m)) return out(local('o200k_base', m))
  if (/^gpt-6/.test(m)) return out(api('openai', m, 'openai'))
  if (/^gemini-(2\.|3-(pro|flash))/.test(m)) return out(local('gemma3', m))
  if (/^gemini-(3\.1-pro|3\.1-flash-lite|3\.5-flash)/.test(m)) return out(local('gemma4', m))
  if (/^gemini-/.test(m)) return out(api('google', m, 'google'))
  if (/^grok-/.test(m)) return out(api('xai', m, 'xai'))
  if (/^(muse-spark|muse-wonder)/.test(m)) return out(api('meta', m, 'meta'))
  if (/^muse-glimmer/.test(m)) return out(local('glimmer', m))
  if (/^llama-?4/.test(m)) return out(estimate('llama4', m))
  if (/^llama-?3/.test(m)) return out(local('llama3', m))
  if (/^(kimi-|moonshot|composer-)/.test(m)) return out(local('kimi', m))
  if (/^qwen3\.([5-9]|\d\d)/.test(m)) return out(local('qwen3.5', m))
  if (/^(qwen3|qwen-coder|qwen2|qwq)/.test(m)) return out(local('qwen3', m))
  if (/^deepseek-/.test(m)) return out(local('deepseek-v4', m))
  if (/^glm-/.test(m)) return out(local('glm5', m))
  if (/^minimax-/.test(m)) return out(local('minimax-m', m))
  if (/^mimo-/.test(m)) return out(local('mimo', m))
  if (/^(devstral|codestral|mistral-|magistral|ministral)/.test(m)) return out(local('tekken', m))
  if (/^gpt-/.test(m)) return out(estimate('openai-old', m))
  return out(estimate('other', m))
}

// An estimate from an o200k count.
export const estimateFrom = (o200k, factor) => Math.round(Math.max(0, o200k) * (factor > 0 ? factor : 1))
