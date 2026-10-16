// An update's release notes for the update dialog (UpdateDialog.vue): the
// HTML GitHub gives (main's notesHtml), sanitized like a skill's preview;
// else the plain text read as markdown (its "• " lines as a list).
import { renderSkillMarkdown, sanitizePreviewHtml } from './skillPreview'

export function releaseNotesHtml(status) {
  const html = status && typeof status.notesHtml === 'string' ? status.notesHtml.trim() : ''
  if (html) return sanitizePreviewHtml(html)
  const text = String((status && status.notes) || '').replace(/^[ \t]*•[ \t]+/gm, '- ')
  return text.trim() ? renderSkillMarkdown(text) : ''
}
