import { describe, it, expect } from 'vitest'
import { antigravityLabelParts, antigravityVariant, groupAntigravityModels, antigravityModelOnScreen, antigravityListed } from '../antigravityModels'
import { parseAntigravityModelList, listedToCatalogModels } from '../agentModelProbe'
import { catalogModelsFor, sessionOptionLaunchText, resolveAgentSessionOptionLaunch, getAgentSessionOptionCatalog, composedModelId } from '../agentSessionOptions'

// `agy models` on agy 1.3.5 (one row per effort variant).
const AGY_MODELS = [
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
  'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)'
].join('\n')

describe('Antigravity model names', () => {
  it('splits the effort a label names, and only an effort', () => {
    expect(antigravityLabelParts('Gemini 4 Argon (High)')).toEqual({ name: 'Gemini 4 Argon', effort: 'high' })
    expect(antigravityLabelParts('Gemini 3.8 Flash (Extra High)')).toEqual({ name: 'Gemini 3.8 Flash', effort: 'xhigh' })
    expect(antigravityLabelParts('Claude Sonnet 4.6 (Thinking)')).toEqual({ name: 'Claude Sonnet 4.6 (Thinking)', effort: null })
    expect(antigravityLabelParts('GPT-OSS 120B')).toEqual({ name: 'GPT-OSS 120B', effort: null })
    expect(antigravityLabelParts('')).toBe(null)
    expect(antigravityLabelParts('$(whoami) (High)')).toBe(null)
  })

  it('a variant needs its id and its label to say the same effort', () => {
    expect(antigravityVariant({ id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' })).toEqual({ base: 'gemini-4-argon', effort: 'high', name: 'Gemini 4 Argon' })
    expect(antigravityVariant({ id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (Low)' })).toBe(null)
    expect(antigravityVariant({ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' })).toBe(null)
  })

  it('groups the variants of a model into one row with its efforts, in order', () => {
    const rows = parseAntigravityModelList(AGY_MODELS)
    expect(groupAntigravityModels(rows)).toEqual([
      { id: 'gemini-4-argon', label: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'] },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'] },
      // No variants, or one: as listed (its id launches as it is).
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
    ])
  })
})

describe('Antigravity model picker and launch flags', () => {
  const models = catalogModelsFor('antigravity', listedToCatalogModels('antigravity', parseAntigravityModelList(AGY_MODELS)))
  const opts = (id) => models.find((m) => m.id === id).options

  it('offers only the efforts each model has (agy refuses any other)', () => {
    expect(opts('gemini-4-argon').map((o) => o.id)).toEqual(['effort'])
    expect(opts('gemini-4-argon')[0].kind.choices.map((c) => c.value)).toEqual(['low', 'medium', 'high'])
    expect(opts('gemini-4-argon')[0].kind.defaultValue).toBe('medium')
    expect(opts('gpt-oss-120b-medium')).toEqual([])
    expect(opts('claude-sonnet-4-6')).toEqual([])
  })

  it('launches a model as agy takes it: its base id and --effort', () => {
    expect(sessionOptionLaunchText('antigravity', { model: 'gemini-4-argon', effort: 'low' }, '', models)).toBe('--model gemini-4-argon --effort low')
    // Untouched effort: agy's own default for the model.
    expect(sessionOptionLaunchText('antigravity', { model: 'gemini-4-argon' }, '', models)).toBe('--model gemini-4-argon')
    expect(sessionOptionLaunchText('antigravity', { model: 'gpt-oss-120b-medium', effort: 'high' }, '', models)).toBe('--model gpt-oss-120b-medium')
    // The user's own --effort wins.
    expect(sessionOptionLaunchText('antigravity', { model: 'gemini-4-argon', effort: 'low' }, '--effort high', models)).toBe('--model gemini-4-argon')
  })

  it('never pairs a variant id with another effort ("conflicts with --effort")', () => {
    // A choice saved from the flat list, before models were grouped.
    expect(sessionOptionLaunchText('antigravity', { model: 'gemini-4-argon-high', effort: 'low' }, '', models)).toBe('--model gemini-4-argon --effort low')
    expect(sessionOptionLaunchText('antigravity', { model: 'gemini-4-argon-high' }, '', models)).toBe('--model gemini-4-argon-high')
    expect(resolveAgentSessionOptionLaunch('antigravity', { model: 'claude-opus-5-5-high', effort: 'medium' }).args).toEqual(['--model', 'claude-opus-5-5', '--effort', 'medium'])
    expect(composedModelId('antigravity', { model: 'gemini-4-argon', effort: 'high' }, models)).toBe('gemini-4-argon')
  })

  it('changes a running session with its own commands', () => {
    const catalog = getAgentSessionOptionCatalog('antigravity')
    expect(catalog.modelApply.midSession.build('gemini-4-argon')).toBe('/model gemini-4-argon')
    expect(opts('gemini-4-argon')[0].apply.midSession.build('high')).toBe('/effort high')
  })
})

describe("Antigravity's footer", () => {
  const grouped = catalogModelsFor('antigravity', listedToCatalogModels('antigravity', parseAntigravityModelList(AGY_MODELS)))
  const flat = parseAntigravityModelList(AGY_MODELS)
  const footer = (right) => ['────────', '>', '────────', `? for shortcuts${' '.repeat(80)}${right}`]

  it('reads the model and effort its status line ends with', () => {
    expect(antigravityModelOnScreen(footer('Gemini 4 Argon · high'), grouped)).toEqual({ model: 'gemini-4-argon', name: 'Gemini 4 Argon', effort: 'high' })
    expect(antigravityModelOnScreen(footer('Claude Opus 5.5 · low'), grouped)).toEqual({ model: 'claude-opus-5-5', name: 'Claude Opus 5.5', effort: 'low' })
    // One variant: the label as it is.
    expect(antigravityModelOnScreen(footer('GPT-OSS 120B (Medium)'), grouped)).toEqual({ model: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B', effort: 'medium' })
    expect(antigravityModelOnScreen(footer('Claude Sonnet 4.6 (Thinking)'), grouped)).toEqual({ model: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', effort: null })
    // A flat (ungrouped) list: its variant row.
    expect(antigravityModelOnScreen(footer('Gemini 4 Argon · low'), flat)).toEqual({ model: 'gemini-4-argon-low', name: 'Gemini 4 Argon', effort: 'low' })
    // No list yet: the name as printed.
    expect(antigravityModelOnScreen(footer('Gemini 4 Argon · high'), [])).toEqual({ model: 'Gemini 4 Argon', name: 'Gemini 4 Argon', effort: 'high' })
    // Working: another hint on the left.
    expect(antigravityModelOnScreen(['esc to interrupt                      Gemini 3.8 Flash · medium'], grouped)).toMatchObject({ model: 'gemini-3.8-flash', effort: 'medium' })
  })

  it('takes nothing else for its footer', () => {
    // A name the list does not have, a line of the conversation, no footer.
    expect(antigravityModelOnScreen(footer('Some Other Thing · high'), grouped)).toBe(null)
    expect(antigravityModelOnScreen(['I used Gemini 4 Argon · high for this.'], grouped)).toBe(null)
    expect(antigravityModelOnScreen(['? for shortcuts'], grouped)).toBe(null)
    expect(antigravityModelOnScreen(footer('Claude Sonnet 4.6 (Thinking)'), [])).toBe(null)
    // Only its last lines are its footer.
    expect(antigravityModelOnScreen([`x${' '.repeat(20)}Gemini 4 Argon · high`, 'a', 'b', 'c'], grouped)).toBe(null)
  })

  it('names what agy reports (its --model, settings, conversation) as the list does', () => {
    expect(antigravityListed(grouped, 'gemini-4-argon-high')).toEqual({ model: 'gemini-4-argon', name: 'Gemini 4 Argon', effort: 'high' })
    expect(antigravityListed(grouped, 'gemini-4-argon', 'low')).toEqual({ model: 'gemini-4-argon', name: 'Gemini 4 Argon', effort: 'low' })
    expect(antigravityListed(grouped, 'Gemini 3.8 Flash (Medium)')).toEqual({ model: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', effort: 'medium' })
    expect(antigravityListed(grouped, 'Gemini 4 Argon', 'low')).toEqual({ model: 'gemini-4-argon', name: 'Gemini 4 Argon', effort: 'low' })
    expect(antigravityListed(grouped, 'gpt-oss-120b-medium')).toEqual({ model: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B', effort: 'medium' })
    expect(antigravityListed(grouped, 'unknown-model')).toBe(null)
    expect(antigravityListed([], 'gemini-4-argon-high')).toBe(null)
  })
})
