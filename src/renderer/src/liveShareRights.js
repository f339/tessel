// Live Share: the words for each right of the catalog
// (src/shared/liveShareRights.js), for every place that shows rights as
// checkboxes (an invitation, the accept prompt, a person, a trusted person,
// a project's people, the access grid) and for the guest's summary of what
// it may do. A right the window has no words for is never shown (no bare
// id, no box nobody can read), and a spec checks that every right of the
// catalog has its words. Adding a right: an entry in the catalog, its words
// here, its check in main.
import { RIGHT_IDS } from '../../shared/liveShareRights'
import { t } from './i18n'

const WORDS = {
  type: () => ({
    label: t('liveShare.right.type', 'Type in terminals and agents (they can run any command as you)'),
    short: t('liveShare.right.typeShort', 'Type'),
    hint: t('liveShare.right.typeHint', 'Only for people you trust: typing in a terminal runs commands on this PC.'),
    part: t('liveShare.rights.typePart', 'type in its terminals and agents')
  }),
  open: () => ({
    label: t('liveShare.right.open', 'Can open terminals and agents on your computer (they can run commands)'),
    short: t('liveShare.right.openShort', 'Open'),
    hint: t('liveShare.right.openHint', 'Without it, each terminal or agent they ask for waits for your yes.'),
    part: t('liveShare.rights.openPart', 'open terminals and agents')
  }),
  close: () => ({
    label: t('liveShare.right.close', 'Ask to close panes'),
    short: t('liveShare.right.closeShort', 'Close'),
    hint: t('liveShare.right.closeHint', 'An agent, or a terminal where something runs, still waits for your yes.'),
    part: t('liveShare.rights.closePart', 'ask to close panes')
  })
}

export const hasRightWords = (id) => typeof id === 'string' && Object.hasOwn(WORDS, id)

// One right's words ({ label, short, hint, part }), or null.
export const rightWords = (id) => (hasRightWords(id) ? WORDS[id]() : null)

// The rights shown, in the catalog's order: [{ id, label, short, hint, part }].
export function shownRights() {
  return RIGHT_IDS.filter(hasRightWords).map((id) => ({ id, ...WORDS[id]() }))
}

// Which rights are on, in a few words ("Type, Open"; "Watch only").
export function rightsShort(rights) {
  const on = shownRights().filter((r) => rights && rights[r.id] === true)
  return on.length ? on.map((r) => r.short).join(', ') : t('liveShare.right.watchOnly', 'Watch only')
}
