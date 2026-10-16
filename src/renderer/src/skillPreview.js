// A skill's SKILL.md as the Skills window shows it before installing
// (SkillsDialog.vue, Add): its front matter as a few key/value pairs, then
// the instructions as formatted text. The file comes from GitHub or any
// folder, so it is untrusted: no raw HTML (shown as text), no style or class
// attribute, no image loaded (a remote one would tell its server who reads
// it), and links never open in the window (the window opens http ones in
// the browser).
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const md = new MarkdownIt({ html: false, linkify: true, typographer: false })

const unquote = (v) => (/^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v)

// "---\nname: pdf\ndescription: >\n  Fill forms.\n---\n# pdf…" ->
// { meta: [{ key, value }], body }. Top-level keys only: an indented line
// continues the value above it (a folded or literal block, a list), so a
// long description reads as one value. No front matter: all of it is body.
export function splitFrontmatter(text) {
  const s = String(text || '').replace(/^\uFEFF/, '')
  const m = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(s)
  if (!m) return { meta: [], body: s }
  const meta = []
  let last = null
  for (const line of (m[1] || '').split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_][\w.-]*)[ \t]*:(?:[ \t]+(.*))?$/.exec(line)
    if (kv) {
      last = { key: kv[1], value: unquote((kv[2] || '').trim()), block: null, items: false }
      if (/^[|>][+-]?$/.test(last.value)) {
        last.block = last.value[0]
        last.value = ''
      }
      meta.push(last)
    } else if (last && /^[ \t]+\S/.test(line)) {
      const part = line.trim()
      if (!last.block && /^- /.test(part)) {
        last.value = last.value && last.items ? `${last.value}, ${unquote(part.slice(2).trim())}` : unquote(part.slice(2).trim())
        last.items = true
      } else {
        const sep = last.block === '|' ? '\n' : ' '
        last.value = last.value ? last.value + sep + part : part
      }
    }
  }
  return { meta: meta.map(({ key, value }) => ({ key, value })), body: s.slice(m[0].length) }
}

function onElement(node) {
  if (node.nodeName === 'IMG') {
    node.removeAttribute('src')
    node.removeAttribute('srcset')
  }
  if (node.nodeName === 'A' && node.hasAttribute('href')) node.setAttribute('rel', 'noreferrer')
}

// The instructions (the body, without its front matter) as safe HTML.
export function renderSkillMarkdown(body) {
  return sanitizePreviewHtml(md.render(String(body || '')))
}

// Untrusted HTML (a skill's rendered markdown, an update's release notes from
// GitHub) made safe to show: no script, style, form or media, no style or
// class attribute, no image loaded, links with no referrer.
export function sanitizePreviewHtml(html) {
  DOMPurify.addHook('afterSanitizeAttributes', onElement)
  try {
    return DOMPurify.sanitize(html, {
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'picture'],
      FORBID_ATTR: ['style', 'class', 'id', 'srcset']
    })
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes', onElement)
  }
}
