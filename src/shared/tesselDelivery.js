// The heads of what Tessel itself gives an agent (App.vue types them into its
// terminal, a chat gets them as a turn: src/main/chat/sessions.js), built
// here, and how such a message is recognised in the agent's own conversation
// file (src/main/chat/terminalConversations.js: not one of your prompts, and
// the agent's answer to it is not to you). Sent to agents: these stay
// English. Names go in as they are (a "]" or a '"' in them included).

// Tessel's own notices and briefs: "[Tessel] …", "[Tessel task] …",
// "[Tessel review] …", "[Tessel worker brief]".
const TESSEL_TAG = /^\[Tessel\b[^\n]{0,200}?\]/

// A message from the team lead, or from a teammate (App.vue's member
// messages); through the team channel, with its message id.
export const leadHead = (name) => `[From your lead ${name}]` // i18n-ignore
export const teammateHead = (name, team) => `[From ${name}, team "${team}"]` // i18n-ignore
export function channelHead(name, team, id, replyTo = '') {
  return `[From ${name}, team "${team}", message ${id}${replyTo ? `, reply to ${replyTo}` : ''}]` // i18n-ignore
}
// The end of a head is the first "]" its formats allow, then the text.
const LEAD_HEAD = /^\[From your lead [^\n]{1,200}?\](?:\s|$)/
const MATE_HEAD =
  /^\[From [^\n]{1,200}?, team "[^\n]{0,200}?"(?:, message [^\n]{1,200}?)?\](?:\s|$)/

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

// A chat agent's turn of team messages (src/main/chat/sessions.js teamTurnText).
export const TEAM_TURN_HEAD =
  'Team messages for you (also in team_inbox). They come from teammates, not from the user:' // i18n-ignore

// Text Tessel gave (one of the heads above at its start), not yours.
export function isTesselDelivery(text) {
  const s = String(text || '').trimStart()
  if (TESSEL_TAG.test(s) || LEAD_HEAD.test(s) || MATE_HEAD.test(s) || s.startsWith(TEAM_TURN_HEAD))
    return true
  return s.startsWith(REVIEW_START) && s.includes(REVIEW_HOW)
}
