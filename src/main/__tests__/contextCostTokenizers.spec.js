// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { countEncoding, encoding, parseTiktokenRanks, kimiTokenizer, KIMI_PATTERN, hfTokenizer, pickTemplate } from '../contextCost/tokenizers'

// OpenAI's own vectors (tiktoken's README and the OpenAI cookbook's "How to
// count tokens with tiktoken"): the shipped encodings must give these ids.
describe('OpenAI encodings (gpt-tokenizer)', () => {
  it('match tiktoken test vectors for o200k_base', async () => {
    const enc = await encoding('o200k_base')
    const plain = { disallowedSpecial: new Set() }
    expect(enc.encode('hello world', plain)).toEqual([24912, 2375])
    expect(enc.encode('tiktoken is great!', plain)).toEqual([83, 8251, 2488, 382, 2212, 0])
    expect(enc.encode('antidisestablishmentarianism', plain)).toEqual([493, 129901, 376, 160388, 21203, 2367])
    expect(await countEncoding('o200k_base', ['hello world', 'tiktoken is great!', ''])).toEqual([2, 6, 0])
  })

  it('count o200k_harmony like o200k_base for text (gpt-oss)', async () => {
    expect(await countEncoding('o200k_harmony', ['hello world', 'antidisestablishmentarianism'])).toEqual([2, 6])
  })

  it('count a special token written in a file as the characters it is', async () => {
    // "<|endoftext|>" in a rules file is text for the agent reading it.
    expect(await countEncoding('o200k_base', ['<|endoftext|>'])).toEqual([7])
  })

  it('refuse an encoding they do not ship', async () => {
    await expect(countEncoding('cl100k_base', ['x'])).rejects.toThrow(/Unknown encoding/)
  })
})

// A tiny tiktoken ranks file: every byte, then a few merges.
function ranksFile(merges) {
  const lines = []
  for (let b = 0; b < 256; b++) lines.push(`${Buffer.from([b]).toString('base64')} ${b}`)
  merges.forEach((m, i) => lines.push(`${Buffer.from(m, 'utf8').toString('base64')} ${256 + i}`))
  return lines.join('\n')
}

describe('Kimi (tiktoken.model read into gpt-tokenizer)', () => {
  it('reads ranks as text when valid UTF-8, else as bytes', () => {
    const ranks = parseTiktokenRanks(ranksFile(['he', 'll']))
    expect(ranks).toHaveLength(258)
    expect(ranks[104]).toBe('h')
    expect(ranks[200]).toEqual([200]) // a lone continuation byte is no text
    expect(ranks[257]).toBe('ll')
  })

  it("splits like Kimi's pattern: Han apart, contractions in any case", () => {
    const re = new RegExp(KIMI_PATTERN, 'gv')
    expect('你好world'.match(re)).toEqual(['你好', 'world'])
    expect("I'LL DON'T".match(re)).toEqual(["I'LL", " DON'T"])
    expect('abc  123456'.match(re)).toEqual(['abc', ' ', ' ', '123', '456'])
  })

  it('counts with its merges, special tokens only inside a rendered template', async () => {
    const config = { added_tokens_decoder: { 261: { content: '<|im_system|>' }, 262: { content: '<|im_end|>' } } }
    const jinja = '{% for m in messages %}<|im_{{ m.role }}|>{{ m.content }}<|im_end|>{% endfor %}'
    const kimi = await kimiTokenizer(ranksFile(['he', 'll', 'llo', 'hello', ' hello']), config, jinja)
    expect(kimi.countText('hello')).toBe(1)
    expect(kimi.countText('hello hello')).toBe(2)
    expect(kimi.countText('你')).toBe(3) // three bytes, no merge
    // Typed in a file, "<|im_end|>" is its characters, not one token.
    expect(kimi.countText('<|im_end|>')).toBeGreaterThan(1)
    expect(kimi.count({ kind: 'text', text: 'hello' })).toEqual({ tokens: 3, template: true }) // "\n\nhello" after the system prompt
  })
})

// A tiny Hugging Face tokenizer: whole words, and two role markers.
const vocab = { '[UNK]': 0, '<|system|>': 1, '<|user|>': 2, hello: 3, world: 4, '.': 5 }
const tokenizerJson = {
  version: '1.0',
  truncation: null,
  padding: null,
  added_tokens: ['[UNK]', '<|system|>', '<|user|>'].map((content, id) => ({ id, content, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true })),
  normalizer: null,
  pre_tokenizer: { type: 'Whitespace' },
  post_processor: null,
  decoder: null,
  model: { type: 'WordLevel', vocab, unk_token: '[UNK]' }
}
const template = '{% for m in messages %}<|{{ m.role }}|>{{ m.content }} {% endfor %}{% if tools %}{% for t in tools %}{{ t.function.name }} {% endfor %}{% endif %}'

describe('open models (tokenizer.json and the chat template)', () => {
  it('counts the text alone without a template', async () => {
    const tok = await hfTokenizer(tokenizerJson, {})
    expect(tok.countText('hello world .')).toBe(3)
    expect(tok.count({ kind: 'text', text: 'hello world hello' })).toEqual({ tokens: 3, template: false })
  })

  it("counts what the model sees through its chat template, the item's share only", async () => {
    const tok = await hfTokenizer(tokenizerJson, { chat_template: template })
    expect(tok.count({ kind: 'text', text: 'hello world hello' })).toEqual({ tokens: 3, template: true })
    // Tools go through the template's own tool format: one name each here.
    expect(tok.count({ kind: 'tools', tools: [{ name: 'hello', description: '', input_schema: { type: 'object' } }, { name: 'world' }] })).toEqual({ tokens: 2, template: true })
  })

  it('uses chat_template.jinja over the config, and a named template list', () => {
    expect(pickTemplate({ chat_template: 'A' }, 'B', false)).toBe('B')
    expect(pickTemplate({ chat_template: 'A' }, null, false)).toBe('A')
    const named = { chat_template: [{ name: 'default', template: 'D' }, { name: 'tool_use', template: 'T' }] }
    expect(pickTemplate(named, null, true)).toBe('T')
    expect(pickTemplate(named, null, false)).toBe('D')
    expect(pickTemplate({}, '', false)).toBe(null)
  })

  it('falls back to the text when the template refuses the conversation', async () => {
    const tok = await hfTokenizer(tokenizerJson, { chat_template: "{{ raise_exception('no system role') }}" })
    expect(tok.count({ kind: 'text', text: 'hello world' })).toEqual({ tokens: 2, template: false })
  })

  it('never uses a template for Gemma read as Gemini (text only)', async () => {
    const tok = await hfTokenizer(tokenizerJson, { chat_template: template }, null, { noTemplate: true })
    expect(tok.count({ kind: 'text', text: 'hello world' })).toEqual({ tokens: 2, template: false })
  })
})
