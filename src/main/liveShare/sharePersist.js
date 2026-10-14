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
    // The saved session, or null (none, unreadable, or too old: then the
    // file goes, with the secrets it holds).
    read() {
      let saved
      try {
        saved = JSON.parse(fs.readFileSync(path, 'utf8'))
      } catch {
        saved = null
      }
      const age = saved && saved.v === 1 && Number.isFinite(saved.savedAt) ? now() - saved.savedAt : -1
      if (age >= 0 && age < RESUME_MS) return saved
      this.clear()
      return null
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
      for (const file of [path, `${path}.tmp`]) {
        try {
          fs.rmSync(file, { force: true })
        } catch {
          /* already gone */
        }
      }
    },
    // Deleted only if what it holds is still what keep(saved) expects (a new
    // session may have saved its own meanwhile).
    clearIf(keep) {
      let saved
      try {
        saved = JSON.parse(fs.readFileSync(path, 'utf8'))
      } catch {
        saved = null
      }
      if (!saved || keep(saved)) this.clear()
    }
  }
}
