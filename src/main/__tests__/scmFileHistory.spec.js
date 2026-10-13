// @vitest-environment node
// The explorer's Timeline (VS Code's Git History): a file's commits, following
// renames, whether it has uncommitted changes, and a commit's numbers and page.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { scmFileHistory, scmCommitInfo } from '../sourceControl'

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString()
let dir
let repo
const write = (rel, text) => fs.writeFileSync(join(repo, rel), text)

beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-timeline-'))
  repo = join(dir, 'repo')
  fs.mkdirSync(repo)
  g(repo, 'init', '-q', '-b', 'main')
  g(repo, 'config', 'user.email', 'ann@example.com')
  g(repo, 'config', 'user.name', 'Ann')
  g(repo, 'config', 'core.autocrlf', 'false')
  write('a.txt', 'one\n')
  write('other.txt', 'x\n')
  g(repo, 'add', '-A')
  g(repo, 'commit', '-q', '-m', 'first')
  write('a.txt', 'one\ntwo\n')
  g(repo, 'commit', '-q', '-am', 'second\n\nWhy it changed:\n- a list')
  write('other.txt', 'y\n')
  g(repo, 'commit', '-q', '-am', 'not about a')
  g(repo, 'mv', 'a.txt', 'b.txt')
  g(repo, 'commit', '-q', '-m', 'renamed')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('scmFileHistory / scmCommitInfo', () => {
  it("a file's commits, newest first, through its rename, with author, time and whole message", async () => {
    const h = await scmFileHistory({ root: repo, path: join(repo, 'b.txt') })
    expect(h.ok).toBe(true)
    expect(h.items.map((i) => i.message.split('\n')[0])).toEqual(['renamed', 'second', 'first'])
    expect(h.items[1]).toMatchObject({ author: 'Ann', email: 'ann@example.com' })
    expect(h.items[1].message).toBe('second\n\nWhy it changed:\n- a list')
    expect(h.items[0].time).toBeGreaterThan(0)
    expect(h.uncommitted).toBe(false)
    write('b.txt', 'changed\n')
    expect((await scmFileHistory({ root: repo, path: join(repo, 'b.txt') })).uncommitted).toBe(true)
    expect((await scmFileHistory({ root: repo, path: join(repo, 'b.txt'), limit: 1 })).hasMore).toBe(true)
    expect((await scmFileHistory({ root: repo, path: join(dir, 'outside.txt') })).ok).toBe(false)
  })

  it("a commit's numbers, and its GitHub page when origin is on GitHub", async () => {
    const h = await scmFileHistory({ root: repo, path: join(repo, 'b.txt') })
    const second = h.items[1].id
    const info = await scmCommitInfo({ root: repo, commit: second })
    expect(info).toMatchObject({ ok: true, stats: { files: 1, insertions: 1, deletions: 0 }, webUrl: null })
    g(repo, 'remote', 'add', 'origin', 'https://github.com/someone/tessel.git')
    expect((await scmCommitInfo({ root: repo, commit: second })).webUrl).toBe(`https://github.com/someone/tessel/commit/${second}`)
    expect((await scmCommitInfo({ root: repo, commit: 'HEAD' })).ok).toBe(false)
  })
})
