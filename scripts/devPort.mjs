// The dev window's server (npm run dev): on 127.0.0.1, never "localhost", and
// on a port of its own checked free first.
//
// "localhost" can mean ::1 or 127.0.0.1. Vite checks that its port is free
// only on the address it listens on, so an agent's own Vite on
// 127.0.0.1:5173 and Tessel's on [::1]:5173 both started, and Tessel's window
// loaded the agent's site (or a blank page). With an explicit 127.0.0.1, a
// port nobody else defaults to, and the free port found before Vite starts
// (strictPort: Vite never moves to another port behind electron-vite's back,
// which would send the window to the configured one), the window always
// reaches Tessel's own server.
import net from 'node:net'

export const DEV_HOST = '127.0.0.1'
export const DEV_PORT = 5737

export function portFree(port, host = DEV_HOST) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)))
  })
}

// The first free port from `start` (TESSEL_DEV_PORT, or 5737), up to 50 tried.
export async function freeDevPort({ start = Number(process.env.TESSEL_DEV_PORT) || DEV_PORT, host = DEV_HOST, tries = 50, isFree = portFree } = {}) {
  for (let p = start; p < start + tries; p++) if (await isFree(p, host)) return p
  return start
}
