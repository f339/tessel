// The short model name shown in an agent pane's header.

// An agent's own word for its reasoning effort as Tessel's effort labels
// name it (the header and Conversations translate those): "Extra high",
// "extra_high" -> 'xhigh', thinking "off" -> 'none', "MEDIUM" -> 'medium'.
// A word Tessel has no label for: null (never shown as an effort).
const EFFORT_WORDS = {
  none: 'none',
  off: 'none',
  disabled: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  'x high': 'xhigh',
  'extra high': 'xhigh',
  max: 'max',
  ultra: 'ultra'
}
export function effortLevel(value) {
  if (typeof value !== 'string') return null
  const word = value.trim().toLowerCase().replace(/[\s_-]+/g, ' ')
  return EFFORT_WORDS[word] || null
}

// A short name for the header: "claude-opus-5-5" -> "Opus 5.5",
// "claude-sonnet-4-5-20250929" -> "Sonnet 4.5", "opus[1m]" -> "Opus (1M)";
// "anthropic/claude-sonnet-5" -> "Sonnet 5"; "gpt-6-astra" -> "GPT-6 Astra";
// anything else as it is.
export function modelLabel(model) {
  let s = String(model || '').trim()
  if (!s) return ''
  s = s.replace(/^.*\//, '')
  const big = /\[1m\]$/i.test(s)
  s = s.replace(/\[1m\]$/i, '')
  const c = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+))?(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(s)
  if (c) {
    const name = c[1][0].toUpperCase() + c[1].slice(1).toLowerCase()
    const ver = c[2] ? (c[3] ? `${c[2]}.${c[3]}` : c[2]) : ''
    return `${name}${ver ? ' ' + ver : ''}${big ? ' (1M)' : ''}`
  }
  // OpenAI's ids as their listed names: "gpt-6-astra" -> "GPT-6 Astra",
  // "gpt-5.2-codex" -> "GPT-5.2 Codex", "gpt-5.4-mini" -> "GPT-5.4 mini".
  const g = /^gpt-(\d+(?:\.\d+)?)((?:-[a-z0-9]+)*)$/i.exec(s)
  if (g) {
    const words = g[2]
      .split('-')
      .filter(Boolean)
      .map((w) => (/^(mini|nano)$/i.test(w) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    return [`GPT-${g[1]}`, ...words].join(' ') + (big ? ' (1M)' : '')
  }
  // Meta's Muse models as their product names: "muse-spark-1.3" -> "Muse
  // Spark 1.3", "muse-spark-1.3-contributor" -> "Muse Spark 1.3 Contributor".
  if (/^muse-[a-z]+(?:-[a-z0-9.]+)*$/i.test(s))
    return s
      .split('-')
      .map((w) => (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()))
      .join(' ')
  return s + (big ? ' (1M)' : '')
}
