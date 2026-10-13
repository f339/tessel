// Live Share: makes the host's share server reachable from anywhere with a
// Cloudflare quick tunnel (free, no account): cloudflared gives a random
// https://<words>.trycloudflare.com address that forwards to the server on
// 127.0.0.1, and stops forwarding when cloudflared is stopped.
//
// cloudflared is downloaded once, from Cloudflare's GitHub release, at a
// pinned version whose SHA-256 is checked before it is ever run, and kept in
// Tessel's data folder. One already on PATH (winget, choco) is not used: its
// version is unknown. The tunnel only carries ciphertext (shareCrypto.js).
import fs from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import crypto from 'crypto'
import WebSocket from 'ws'

export const CLOUDFLARED_VERSION = '2026.9.3'
const CLOUDFLARED_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`
const CLOUDFLARED_SHA256 = 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2'
const START_TIMEOUT_MS = 45000

const ADDRESS_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

export function cloudflaredPath(dataDir) {
  return join(dataDir, 'bin', `cloudflared-${CLOUDFLARED_VERSION}.exe`)
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// The checked cloudflared program, downloaded when missing (or not the
// expected file). onProgress gets 0..1 while it downloads.
export async function ensureCloudflared(dataDir, { fetchImpl = fetch, onProgress } = {}) {
  const exe = cloudflaredPath(dataDir)
  try {
    if (sha256(fs.readFileSync(exe)) === CLOUDFLARED_SHA256) return exe
  } catch {
    /* not downloaded yet */
  }
  const res = await fetchImpl(CLOUDFLARED_URL, { redirect: 'follow' })
  if (!res.ok) throw new Error(`cloudflared download failed (HTTP ${res.status})`) // i18n-ignore shown with the share error
  const total = Number(res.headers?.get?.('content-length')) || 0
  const chunks = []
  let got = 0
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      got += value.length
      if (total && onProgress) onProgress(Math.min(1, got / total))
    }
  } else {
    chunks.push(Buffer.from(await res.arrayBuffer()))
  }
  const data = Buffer.concat(chunks)
  if (sha256(data) !== CLOUDFLARED_SHA256) throw new Error('cloudflared download does not match its published SHA-256') // i18n-ignore shown with the share error
  fs.mkdirSync(join(dataDir, 'bin'), { recursive: true })
  const tmp = exe + '.part'
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, exe)
  return exe
}

// The tunnel's address in cloudflared's output, as a wss:// URL, or null.
export function parseTunnelAddress(text) {
  const m = ADDRESS_RE.exec(String(text || ''))
  return m ? m[0].replace(/^https:/i, 'wss:') + '/' : null
}

// A new tunnel's address takes a few seconds to resolve everywhere: try it
// (the share server's first message proves it is ours) before the invite
// code is shown, so a guest does not join too early.
export async function waitReachable(url, { WebSocketImpl = WebSocket, timeoutMs = 60000, everyMs = 2000 } = {}) {
  const WS = WebSocketImpl
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const ok = await new Promise((resolve) => {
      let socket
      const done = (v) => {
        clearTimeout(timer)
        try {
          socket?.terminate?.()
        } catch {
          /* closed */
        }
        resolve(v)
      }
      const timer = setTimeout(() => done(false), 8000)
      try {
        socket = new WS(url, { handshakeTimeout: 8000 })
      } catch {
        done(false)
        return
      }
      socket.on('message', (data) => {
        try {
          done(JSON.parse(data.toString()).app === 'tessel-liveshare')
        } catch {
          done(false)
        }
      })
      socket.on('error', () => done(false))
      socket.on('close', () => done(false))
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, everyMs))
  }
  return false
}

// Starts a quick tunnel to 127.0.0.1:port. Resolves { url, stop } once
// Cloudflare gave the address; onExit(code) is called if it stops by itself.
export function startTunnel({ exe, port, dataDir, spawnImpl = spawn, onExit, timeoutMs = START_TIMEOUT_MS }) {
  // An empty config of its own: a quick tunnel refuses to start when the
  // user's ~/.cloudflared/config.yml exists (a named tunnel of theirs).
  const config = join(dataDir, 'bin', 'cloudflared-quick.yml')
  try {
    fs.mkdirSync(join(dataDir, 'bin'), { recursive: true })
    fs.writeFileSync(config, '')
  } catch {
    /* cloudflared then reports what is wrong */
  }
  const args = ['tunnel', '--no-autoupdate', '--config', config, '--url', `http://127.0.0.1:${port}`]
  return new Promise((resolve, reject) => {
    const child = spawnImpl(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const stop = () => {
      try {
        child.kill()
      } catch {
        /* already stopped */
      }
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      stop()
      reject(new Error('Cloudflare did not give a tunnel address in time')) // i18n-ignore shown with the share error
    }, timeoutMs)
    const onData = (chunk) => {
      if (settled) return
      output = (output + chunk.toString()).slice(-20000)
      const url = parseTunnelAddress(output)
      if (!url) return
      settled = true
      clearTimeout(timer)
      resolve({ url, stop, pid: child.pid })
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        const last = output.trim().split(/\r?\n/).slice(-3).join(' | ')
        reject(new Error(`cloudflared stopped (${code})${last ? ': ' + last : ''}`)) // i18n-ignore shown with the share error
        return
      }
      onExit?.(code)
    })
  })
}
