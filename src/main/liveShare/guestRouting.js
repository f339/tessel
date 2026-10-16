// Live Share phase 2, guest side: which code answers a call the window
// makes for files (index.js). A Live Share host's project has virtual paths
// (lshare://<project>\..., src/shared/liveSharePath.js); its Files, editor,
// Changes and notes go to the host through this Tessel's session
// (guestFs.js), as a remote project's (ssh://...) go to its host
// (remoteFs.js), and the rest is this computer's. What would act on this
// computer (reveal in Explorer, open in another program, the PDF window, a
// terminal there, an agent writing the commit message) and what uses the
// host's credentials (push, pull, fetch, sync) is refused for a shared path
// (guestFs.js LOCAL_ONLY_ACTIONS).
import { isLsharePath } from '../../shared/liveSharePath'
import { isRemotePath } from '../../shared/remotePath'
import { LOCAL_ONLY_ACTIONS } from './guestFs.js'

// The fields of a call that name a file or folder.
const FIELDS = ['root', 'file', 'path', 'dir', 'cwd']

// A call (its argument: a path, or an object with paths) that names a shared
// project's path anywhere.
export const lshareArg = (q) => (q && typeof q === 'object' ? FIELDS.some((f) => isLsharePath(q[f])) : isLsharePath(q))
// One that names a remote project's path (and no shared one), as index.js
// has always read them.
export const remoteArg = (q) => !lshareArg(q) && (q && typeof q === 'object' ? isRemotePath(q.root) || isRemotePath(q.file) || isRemotePath(q.path) : isRemotePath(q))

// The code for a call: { local, remote, lshare } -> the one its paths ask
// for (a shared path first: never this computer's handler for it).
export function pickFs(q, { local, remote, lshare }) {
  if (lshareArg(q)) return lshare
  return remoteArg(q) ? remote : local
}

// A call this computer never makes for a shared path.
export const localOnlyFor = (action, q) => LOCAL_ONLY_ACTIONS.includes(action) && lshareArg(q)
