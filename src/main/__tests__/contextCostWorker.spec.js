// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { createHash } from 'crypto'
import { answer, tesselContext } from '../contextCost/worker'
import { createCountWorker } from '../contextCost/workerClient'
import { createHfTokenizers, matchesHash, fileUrl, allowedDownloadUrl } from '../contextCost/hfTokenizers'
import { TOKENIZER_FILES } from '../contextCost/catalog'
import { toolDefs, testMcp } from '../agentTools'
import teamServer from '../teamMcp/server.cjs'

describe('the counting process', () => {
  it('counts with a shipped encoding', async () => {
    expect(await answer({ id: 1, op: 'encoding', encoding: 'o200k_base', texts: ['hello world', ''] })).toEqual({ id: 1, counts: [2, 0] })
  })

  it("gives Tessel's team tools exactly as the team server announces them", () => {
    const ctx = tesselContext()
    expect(ctx.instructions).toContain('task board')
    expect(ctx.tools.map((tl) => tl.name)).toEqual(teamServer.TOOLS.map((tl) => tl.name))
    expect(ctx.tools.length).toBeGreaterThan(20)
  })

  it('answers an unknown request with an error', async () => {
    expect((await answer({ id: 3, op: 'nope' })).error).toBeTruthy()
  })
})

describe('the counting process, from the main process', () => {
  function fakeChild(onMessage) {
    const child = new EventEmitter()
    child.postMessage = (msg) => setTimeout(() => onMessage(child, msg), 0)
    child.kill = vi.fn(() => child.emit('exit'))
    return child
  }

  it('starts on the first request, answers by id, stops when idle', async () => {
    vi.useFakeTimers()
    try {
      let forks = 0
      let child
      const client = createCountWorker({
        fork: () => {
          forks++
          child = fakeChild((c, msg) => c.emit('message', { id: msg.id, counts: [msg.texts.length] }))
          return child
        },
        idleMs: 1000
      })
      const p = client.request({ op: 'encoding', texts: ['a', 'b'] })
      await vi.advanceTimersByTimeAsync(1)
      expect(await p).toEqual({ id: 1, counts: [2] })
      expect(forks).toBe(1)
      await vi.advanceTimersByTimeAsync(1500)
      expect(child.kill).toHaveBeenCalled()
      client.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves null when it fails, crashes or does not answer in time', async () => {
    vi.useFakeTimers()
    try {
      const failing = createCountWorker({ fork: () => fakeChild((c, msg) => c.emit('message', { id: msg.id, error: 'boom' })) })
      const p1 = failing.request({ op: 'x' })
      await vi.advanceTimersByTimeAsync(1)
      expect(await p1).toBe(null)
      const silent = createCountWorker({ fork: () => fakeChild(() => {}), replyMs: 500 })
      const p2 = silent.request({ op: 'x' })
      await vi.advanceTimersByTimeAsync(600)
      expect(await p2).toBe(null)
      const broken = createCountWorker({
        fork: () => {
          throw new Error('no utility process')
        }
      })
      expect(await broken.request({ op: 'x' })).toBe(null)
      failing.close()
      silent.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('downloaded tokenizers: on a click, checked by hash', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-tokdl-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('checks sha256 for LFS files and git blob sha1 for the others', () => {
    const buf = Buffer.from('hello')
    expect(matchesHash(buf, { sha256: createHash('sha256').update(buf).digest('hex') })).toBe(true)
    expect(matchesHash(buf, { sha1: 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0' })).toBe(true) // git hash-object of "hello"
    expect(matchesHash(buf, { sha1: '0'.repeat(40) })).toBe(false)
    expect(fileUrl(TOKENIZER_FILES.qwen3, 'tokenizer.json')).toBe(`https://huggingface.co/Qwen/Qwen3-Coder-480B-A35B-Instruct/resolve/${TOKENIZER_FILES.qwen3.rev}/tokenizer.json`)
  })

  it('keeps nothing when a file does not match its hash, everything when all do; Remove deletes it', async () => {
    const asked = []
    const fakeFetch = (good) => async (url) => {
      asked.push(url)
      return new Response(good ? 'right' : 'wrong')
    }
    const spec = TOKENIZER_FILES['deepseek-v4']
    const names = Object.keys(spec.files)
    const files = createHfTokenizers({ dir, request: fakeFetch(false) })
    const bad = await files.download('deepseek-v4')
    expect(bad.ok).toBe(false)
    expect(fs.existsSync(join(dir, 'deepseek-v4'))).toBe(false)
    expect(await files.loaderFor('deepseek-v4')).toBe(null)
    expect(asked[0]).toContain(`/resolve/${spec.rev}/`)
    // Every file as the catalogue's hash says (patched for the test).
    const right = Buffer.from('right')
    const patched = Object.fromEntries(names.map((n) => [n, { size: right.length, sha256: createHash('sha256').update(right).digest('hex') }]))
    const saved = spec.files
    Object.defineProperty(spec, 'files', { value: patched, configurable: true })
    try {
      const good = await createHfTokenizers({ dir, request: fakeFetch(true) }).download('deepseek-v4')
      expect(good).toEqual({ ok: true })
      const ok = createHfTokenizers({ dir })
      expect(await ok.loaderFor('deepseek-v4')).toEqual({ dir: join(dir, 'deepseek-v4'), format: 'hf', noTemplate: false })
      expect((await ok.status())['deepseek-v4'].ready).toBe(true)
      await ok.remove('deepseek-v4')
      expect(fs.existsSync(join(dir, 'deepseek-v4'))).toBe(false)
    } finally {
      Object.defineProperty(spec, 'files', { value: saved, configurable: true })
    }
  })
})

describe('MCP tool definitions for Measure', () => {
  it('keeps name, description and schema, bounded', () => {
    expect(toolDefs([{ name: 'a', description: 'd', inputSchema: { type: 'object' }, extra: 1 }, { nope: true }])).toEqual([{ name: 'a', description: 'd', inputSchema: { type: 'object' } }])
    expect(toolDefs(Array.from({ length: 600 }, (_, i) => ({ name: `t${i}` })))).toHaveLength(500)
  })

  it('gives the definitions only when asked (the window’s Test gets names)', async () => {
    // A stdio server that answers initialize and tools/list.
    const spawnFn = () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      child.stdin = {
        write: (line) => {
          const msg = JSON.parse(line)
          const send = (m) => setTimeout(() => child.stdout.emit('data', JSON.stringify(m) + '\n'), 0)
          if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'fake' } } })
          if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }] } })
        }
      }
      return child
    }
    const home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-mcpdefs-'))
    const prev = process.env.USERPROFILE
    const prevHome = process.env.HOME
    try {
      fs.writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { fake: { command: 'fake-server', args: [] } } }))
      process.env.USERPROFILE = home
      process.env.HOME = home
      const plain = await testMcp({ agent: 'claude', name: 'fake', scope: 'user' }, {}, spawnFn)
      expect(plain).toMatchObject({ ok: true, tools: ['read'] })
      expect(plain.defs).toBeUndefined()
      const withDefs = await testMcp({ agent: 'claude', name: 'fake', scope: 'user' }, {}, spawnFn, { defs: true })
      expect(withDefs.defs).toEqual([{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }])
    } finally {
      process.env.USERPROFILE = prev
      process.env.HOME = prevHome
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('a hung counting process', () => {
  it('is killed at its timeout and not started again before a backoff', async () => {
    vi.useFakeTimers()
    try {
      let now = 0
      let forks = 0
      const children = []
      const client = createCountWorker({
        fork: () => {
          forks++
          const child = new EventEmitter()
          child.postMessage = () => {} // never answers
          child.kill = vi.fn()
          children.push(child)
          return child
        },
        replyMs: 1000,
        backoffMs: 5000,
        clock: () => now
      })
      const p = client.request({ op: 'x' })
      await vi.advanceTimersByTimeAsync(1100)
      expect(await p).toBe(null)
      expect(children[0].kill).toHaveBeenCalled()
      now += 1000
      expect(await client.request({ op: 'x' })).toBe(null) // still in its backoff
      expect(forks).toBe(1)
      now += 5000
      const p2 = client.request({ op: 'x' })
      expect(forks).toBe(2)
      await vi.advanceTimersByTimeAsync(1100)
      await p2
      client.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('tokenizer downloads: catalogue ids, Hugging Face hosts, clean files', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-tokdl2-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('knows only the catalogue’s own ids (no inherited names, no paths)', async () => {
    const asked = []
    const files = createHfTokenizers({ dir, request: async (url) => (asked.push(url), new Response('x')) })
    for (const id of ['constructor', '__proto__', 'toString', '..', '../outside']) {
      expect((await files.download(id)).ok).toBe(false)
      expect((await files.remove(id)).ok).toBe(false)
      expect(await files.loaderFor(id)).toBe(null)
    }
    expect(asked).toEqual([])
  })

  it('follows redirects only over https to Hugging Face hosts', async () => {
    expect(allowedDownloadUrl('https://huggingface.co/x')).toBe(true)
    expect(allowedDownloadUrl('https://cdn-lfs.huggingface.co/x')).toBe(true)
    expect(allowedDownloadUrl('https://cas-bridge.xethub.hf.co/x')).toBe(true)
    expect(allowedDownloadUrl('http://huggingface.co/x')).toBe(false)
    expect(allowedDownloadUrl('https://huggingface.co.evil.com/x')).toBe(false)
    expect(allowedDownloadUrl('https://user:pw@huggingface.co/x')).toBe(false)
    expect(allowedDownloadUrl('https://huggingface.co:8443/x')).toBe(false)
    const seen = []
    const redirectTo = (location) => async (url) => {
      seen.push(url)
      return seen.length === 1 ? new Response(null, { status: 302, headers: { location } }) : new Response('body')
    }
    const off = await createHfTokenizers({ dir, request: redirectTo('https://evil.example.com/t.json') }).download('qwen3')
    expect(off.ok).toBe(false)
    expect(seen).toHaveLength(1)
    seen.length = 0
    const down = await createHfTokenizers({ dir, request: redirectTo('http://cdn-lfs.huggingface.co/t.json') }).download('qwen3')
    expect(down.ok).toBe(false)
    expect(seen).toHaveLength(1)
    seen.length = 0
    // To the CDN over https: followed (then refused here by the hash).
    await createHfTokenizers({ dir, request: redirectTo('https://cas-bridge.xethub.hf.co/t.json') }).download('qwen3')
    expect(seen[1]).toBe('https://cas-bridge.xethub.hf.co/t.json')
  })

  it('removes the whole folder, leftovers included, without following links', async () => {
    const target = join(dir, 'qwen3')
    fs.mkdirSync(target, { recursive: true })
    for (const n of ['tokenizer.json', 'ready.json', 'tokenizer.json.123.tmp', 'stray.txt']) fs.writeFileSync(join(target, n), 'x')
    const outside = join(dir, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(join(outside, 'keep.txt'), 'keep')
    try {
      fs.symlinkSync(outside, join(target, 'link'), 'junction')
    } catch {
      // no links here: the rest still holds
    }
    expect(await createHfTokenizers({ dir }).remove('qwen3')).toEqual({ ok: true })
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })
})
