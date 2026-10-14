// Live Share across a restart of Tessel: what a share (the host's) or a
// joined session (a guest's) needs to carry on, kept in a file of Tessel's
// data folder while it runs, written again every minute. The next Tessel
// takes it back if it is recent (RESUME_MS): a restart, an update, a crash.
// Stop sharing, Leave or quitting Tessel deletes it. It holds the invite's
// secret and a guest's reconnect key, like the other sign-ins in that folder.
import fs from 'fs'
import { dirname } from 'path'

export const RESUME_MS = 10 * 60 * 1000

export function createSessionFile(path, { now = Date.now } = {}) {
  return {
    // The saved session, or null (none, unreadable, or too old).
    read() {
      try {
        const saved = JSON.parse(fs.readFileSync(path, 'utf8'))
        if (!saved || saved.v !== 1 || !Number.isFinite(saved.savedAt)) return null
        const age = now() - saved.savedAt
        return age >= 0 && age < RESUME_MS ? saved : null
      } catch {
        return null
      }
    },
    write(data) {
      try {
        fs.mkdirSync(dirname(path), { recursive: true })
        const tmp = `${path}.tmp`
        fs.writeFileSync(tmp, JSON.stringify({ ...data, v: 1, savedAt: now() }))
        fs.renameSync(tmp, path)
      } catch {
        /* only taking the session back after a restart is lost */
      }
    },
    clear() {
      try {
        fs.rmSync(path, { force: true })
      } catch {
        /* already gone */
      }
    }
  }
}
