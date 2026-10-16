import { describe, expect, it } from 'vitest'
import { splitFrontmatter, renderSkillMarkdown } from '../skillPreview'

describe('a SKILL.md before installing (skillPreview.js)', () => {
  it('the front matter: key/value pairs, a folded or literal block and a list read as one value', () => {
    const md = [
      '---',
      'name: "pdf"',
      "license: 'MIT'",
      'description: >-',
      '  Fill PDF forms',
      '  and merge files.',
      'notes: |',
      '  Line one',
      '  Line two',
      'allowed-tools:',
      '  - Read',
      '  - "Bash(python:*)"',
      'empty:',
      '---',
      '# Title',
      ''
    ].join('\r\n')
    const { meta, body } = splitFrontmatter(md)
    expect(meta).toEqual([
      { key: 'name', value: 'pdf' },
      { key: 'license', value: 'MIT' },
      { key: 'description', value: 'Fill PDF forms and merge files.' },
      { key: 'notes', value: 'Line one\nLine two' },
      { key: 'allowed-tools', value: 'Read, Bash(python:*)' },
      { key: 'empty', value: '' }
    ])
    expect(body).toBe('# Title\r\n')
  })

  it('no front matter (or one never closed): all of it is the body', () => {
    expect(splitFrontmatter('# Just text\n\nname: not meta')).toEqual({ meta: [], body: '# Just text\n\nname: not meta' })
    expect(splitFrontmatter('---\nname: x\n# never closed')).toEqual({ meta: [], body: '---\nname: x\n# never closed' })
    expect(splitFrontmatter('\uFEFF---\n---\nBody')).toEqual({ meta: [], body: 'Body' })
    expect(splitFrontmatter(null)).toEqual({ meta: [], body: '' })
  })

  it('the instructions as safe HTML: raw HTML as text, no image loaded, no style, links kept for the window to handle', () => {
    const html = renderSkillMarkdown(
      [
        '# Use it',
        '',
        '<img src=x onerror="alert(1)"> <iframe src="evil.html"></iframe> <div style="position:fixed">over</div>',
        '',
        '![pixel](https://tracker.example/p.png "t")',
        '',
        '[docs](https://example.com) [bad](javascript:alert(1))',
        '',
        '```js',
        'run()',
        '```'
      ].join('\n')
    )
    const box = document.createElement('div')
    box.innerHTML = html
    expect(box.querySelector('h1').textContent).toBe('Use it')
    // Raw HTML is text, never elements.
    expect(box.querySelector('iframe, div')).toBeNull()
    expect(box.textContent).toContain('<iframe src="evil.html"></iframe>')
    expect(box.querySelectorAll('img')).toHaveLength(1)
    const img = box.querySelector('img')
    expect(img.getAttribute('src')).toBeNull()
    expect(img.getAttribute('alt')).toBe('pixel')
    expect(img.getAttribute('onerror')).toBeNull()
    const links = [...box.querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com'])
    expect(links[0].getAttribute('rel')).toBe('noreferrer')
    expect(box.textContent).toContain('[bad](javascript:alert(1))') // markdown-it refuses that link
    expect(box.querySelector('[class], [style], [id]')).toBeNull()
    expect(box.querySelector('pre code').textContent).toBe('run()\n')
  })
})
