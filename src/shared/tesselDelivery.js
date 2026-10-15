// The heads of what Tessel itself types into an agent's terminal (App.vue
// builds them here), and how such a message is recognised in the agent's own
// conversation file (src/main/chat/terminalConversations.js: not one of your
// prompts, and the agent's answer to it is not to you). Sent to agents: these
// stay English.

// Tessel's own notices and briefs: "[Tessel] …", "[Tessel task] …",
// "[Tessel review] …", "[Tessel worker brief]".
const TESSEL_TAG = /^\[Tessel\b[^\]\n]{0,40}\]/

// A message from the team lead, or from a teammate through the team channel.
export const leadHead = (name) => `[From your lead ${name}]` // i18n-ignore
export function teammateHead(name, team, { id = '', replyTo = '' } = {}) {
  return `[From ${name}, team "${team}"${id ? `, message ${id}${replyTo ? `, reply to ${replyTo}` : ''}` : ''}]` // i18n-ignore
}
const FROM_HEAD =
  /^\[From (?:your lead [^\]\n]{1,120}|[^\]\n]{1,120}, team "[^"\n]{0,120}"(?:, message [^\]\n]{1,160})?)\]/

// The review a card's reviewer is asked for.
const REVIEW_START = 'Please review the changes ' // i18n-ignore
const REVIEW_HOW = 'Run git status and git diff there to see them. ' // i18n-ignore
export function reviewRequest(who, where = '', branch = '') {
  return (
    `${REVIEW_START}${who} made${where}${branch}. ` + // i18n-ignore
    REVIEW_HOW +
    'Point out bugs, risky changes and missing tests, with file and line references. Do not modify any files; only report.' // i18n-ignore
  )
}

// Text Tessel typed (one of the heads above at its start), not yours.
export function isTesselDelivery(text) {
  const s = String(text || '').trimStart()
  if (TESSEL_TAG.test(s) || FROM_HEAD.test(s)) return true
  return s.startsWith(REVIEW_START) && s.includes(REVIEW_HOW)
}
