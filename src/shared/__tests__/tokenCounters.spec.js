// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { normalizeModelId, tokenCounterFor, claudeModelId, claudeOldTokenizer, estimateFrom, ESTIMATE_FACTORS, TOKENIZERS, DEFAULT_MODELS } from '../tokenCounters'

describe('model ids, normalized', () => {
  it('keeps the model name: no provider path, effort, speed, context, date or Ollama tag', () => {
    expect(normalizeModelId('anthropic/claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(normalizeModelId('kimi-code/kimi-for-coding')).toBe('kimi-for-coding')
    expect(normalizeModelId('gpt-5.1-codex-max')).toBe('gpt-5.1-codex')
    expect(normalizeModelId('claude-opus-4-6[1m]')).toBe('claude-opus-4-6')
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(normalizeModelId('gpt-4o-2024-08-06')).toBe('gpt-4o')
    expect(normalizeModelId('kimi-k2-0905-preview')).toBe('kimi-k2')
    expect(normalizeModelId('gemini-3-pro-preview')).toBe('gemini-3-pro')
    expect(normalizeModelId('ollama/qwen2.5-coder:7b')).toBe('qwen2.5-coder')
    expect(normalizeModelId('us.anthropic.claude-opus-4-1')).toBe('claude-opus-4-1')
    expect(normalizeModelId('Gemini 4 Argon (High)')).toBe('gemini-4-argon')
    expect(tokenCounterFor('Claude Sonnet 4.5 (Thinking)')).toMatchObject({ api: 'anthropic', model: 'claude-sonnet-4-5' })
    expect(normalizeModelId(null)).toBe('')
  })

  it('names Claude models the way count_tokens takes them', () => {
    expect(claudeModelId('opus')).toBe('claude-opus-5-5')
    expect(claudeModelId('fable')).toBe('claude-fable-5-1')
    expect(claudeModelId('claude-sonnet-4.5')).toBe('claude-sonnet-4-5')
    expect(claudeModelId('gpt-5')).toBe(null)
    expect(claudeOldTokenizer('claude-sonnet-4-6')).toBe(true)
    expect(claudeOldTokenizer('claude-opus-4-1')).toBe(true)
    expect(claudeOldTokenizer('claude-haiku-4-5')).toBe(true)
    expect(claudeOldTokenizer('claude-opus-4-7')).toBe(false)
    expect(claudeOldTokenizer('claude-opus-5-5')).toBe(false)
  })
})

describe('the counter each model gets', () => {
  // The research notes' worked examples.
  it('follows the worked examples', () => {
    expect(tokenCounterFor('claude-opus-5-5')).toMatchObject({ kind: 'api', api: 'anthropic', model: 'claude-opus-5-5', factorKey: 'anthropic-new' })
    expect(tokenCounterFor('gpt-5.1-codex')).toMatchObject({ kind: 'local', tokenizer: 'o200k_base' })
    expect(tokenCounterFor('gemini-3.1-pro')).toMatchObject({ kind: 'local', tokenizer: 'gemma4' })
    expect(tokenCounterFor('kimi-k2')).toMatchObject({ kind: 'local', tokenizer: 'kimi' })
    expect(tokenCounterFor('qwen3-coder')).toMatchObject({ kind: 'local', tokenizer: 'qwen3' })
    expect(tokenCounterFor('grok-4')).toMatchObject({ kind: 'api', api: 'xai' })
  })

  it('maps every family of the rules', () => {
    const tok = (m) => tokenCounterFor(m).tokenizer
    expect(tok('gpt-oss-120b')).toBe('o200k_harmony')
    expect(tok('gpt-4o-mini')).toBe('o200k_base')
    expect(tok('gpt-4.1')).toBe('o200k_base')
    expect(tok('o3')).toBe('o200k_base')
    expect(tok('o4-mini')).toBe('o200k_base')
    expect(tok('codex-mini-latest')).toBe('o200k_base')
    expect(tokenCounterFor('gpt-6-astra')).toMatchObject({ kind: 'api', api: 'openai' })
    expect(tok('gemini-2.5-pro')).toBe('gemma3')
    expect(tok('gemini-3-flash-preview')).toBe('gemma3')
    expect(tok('gemini-3.5-flash')).toBe('gemma4')
    expect(tokenCounterFor('gemini-4-argon')).toMatchObject({ kind: 'api', api: 'google' })
    expect(tokenCounterFor('muse-spark-1.3')).toMatchObject({ kind: 'api', api: 'meta' })
    expect(tok('muse-glimmer-30b')).toBe('glimmer')
    expect(tokenCounterFor('llama-4-scout')).toMatchObject({ kind: 'estimate', family: 'llama4' })
    expect(tok('llama3.1')).toBe('llama3')
    expect(tok('composer-2')).toBe('kimi')
    expect(tok('qwen3.6-plus')).toBe('qwen3.5')
    expect(tok('qwen2.5-coder')).toBe('qwen3')
    expect(tok('deepseek-v4-pro')).toBe('deepseek-v4')
    expect(tok('glm-5.2')).toBe('glm5')
    expect(tok('minimax-m3')).toBe('minimax-m')
    expect(tok('mimo-v2.6-flash')).toBe('mimo')
    expect(tok('devstral-small-2')).toBe('tekken')
    expect(tok('codestral-latest')).toBe('tekken')
    expect(tokenCounterFor('some-private-model')).toMatchObject({ kind: 'estimate', family: 'other', factor: ESTIMATE_FACTORS.other })
  })

  it('assumes the agent’s usual model when none was found, and says so', () => {
    expect(tokenCounterFor(null, 'claude')).toMatchObject({ kind: 'api', api: 'anthropic', model: DEFAULT_MODELS.claude, defaulted: true })
    expect(tokenCounterFor('', 'codex')).toMatchObject({ kind: 'local', tokenizer: 'o200k_base', defaulted: true })
    expect(tokenCounterFor('auto', 'cursor')).toMatchObject({ tokenizer: 'kimi', defaulted: true })
    expect(tokenCounterFor('opus', 'claude')).toMatchObject({ model: 'claude-opus-5-5', defaulted: false })
    expect(tokenCounterFor(null, 'cline')).toMatchObject({ kind: 'estimate', defaulted: true })
  })

  it('gives Claude its estimate factor by tokenizer generation', () => {
    expect(tokenCounterFor('claude-sonnet-4-5').factor).toBe(ESTIMATE_FACTORS['anthropic-old'])
    expect(tokenCounterFor('claude-opus-4-8').factor).toBe(ESTIMATE_FACTORS['anthropic-new'])
    expect(estimateFrom(1000, 1.35)).toBe(1350)
    expect(estimateFrom(-5, 1.2)).toBe(0)
  })

  it('knows which tokenizers ship and which use a chat template', () => {
    expect(TOKENIZERS.o200k_base.shipped).toBe(true)
    expect(TOKENIZERS.qwen3.shipped).toBe(false)
    expect(TOKENIZERS.qwen3.template).toBe(true)
    expect(TOKENIZERS.gemma3.template).toBe(false) // Gemini is counted as text
  })
})
