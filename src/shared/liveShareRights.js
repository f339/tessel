// Live Share: what a guest may do beyond watching its projects, as one list.
//
// Each right has an id (what goes over the wire and into saved files) and
// its default (every one is off until the host turns it on). The host's
// Tessel enforces each one where the guest's request is taken
// (src/main/liveShare/shareHost.js); the window names each one
// (src/renderer/src/liveShareRights.js) and every editor (the accept prompt,
// an invitation, a person, a trusted person, a project's people) shows them
// from this list. Adding a right means adding an entry here, its label there,
// and its check on the host.
//
// Rights from an older or newer Tessel are read through cleanRights: an id
// this list does not know is dropped (never granted), and a known one is on
// only when it is exactly true.
export const SHARE_RIGHTS = Object.freeze([
  // Type in the shared terminals and agents (run any command as the host).
  Object.freeze({ id: 'type', default: false }),
  // Open terminals and agents in a shared project, on the host's computer.
  // Without it, a guest's request asks the host.
  Object.freeze({ id: 'open', default: false }),
  // Ask to close panes (an agent or a busy terminal still asks the host).
  Object.freeze({ id: 'close', default: false })
])

export const RIGHT_IDS = Object.freeze(SHARE_RIGHTS.map((r) => r.id))

export const isRightId = (id) => typeof id === 'string' && RIGHT_IDS.includes(id)

// Every known right with its default.
export function defaultRights() {
  const out = {}
  for (const r of SHARE_RIGHTS) out[r.id] = r.default
  return out
}

// A rights object as given by anyone (a peer, a saved file, the window):
// every known right, on only when it is exactly true; nothing else.
export function cleanRights(rights) {
  const given = rights && typeof rights === 'object' ? rights : null
  const out = {}
  for (const r of SHARE_RIGHTS) out[r.id] = !!given && Object.hasOwn(given, r.id) && given[r.id] === true
  return out
}

export const NO_RIGHTS = Object.freeze(cleanRights(null))

// The same rights (every known id equal).
export const sameRights = (a, b) => RIGHT_IDS.every((id) => !!(a && a[id]) === !!(b && b[id]))
