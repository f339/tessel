// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import { join, sep, resolve, parse, dirname } from 'path'
import {
  rulesCandidates,
  readRules,
  createFileReader,
  claudeImports,
  splitTesselBlock,
  claudeProjectSlug,
  foldersUp,
  importProblem,
  isSensitivePath,
  readBudget,
  importRoot,
  walkLinks,
  findGitRoot,
  isInside,
  IMPORT_LIMIT
} from '../contextCost/rulesFiles'
import { RULE_START, RULE_END } from '../agentMemory'

let root, home, project
beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'tessel-ctxrules-'))
  home = join(root, 'home')
  project = join(root, 'work', 'app')
  fs.mkdirSync(join(project, '.git'), { recursive: true })
  fs.mkdirSync(home, { recursive: true })
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})
const write = (p, text) => {
  fs.mkdirSync(join(p, '..'), { recursive: true })
  fs.writeFileSync(p, text)
}

describe('where each agent reads its rules', () => {
  it('lists user and project places per agent', () => {
    const paths = (agent) => rulesCandidates(agent, { home, cwd: project, gitRoot: project, env: {} }).map((c) => c.path || c.pick)
    expect(paths('claude')).toContainEqual(join(home, '.claude', 'CLAUDE.md'))
    expect(paths('claude')).toContainEqual(join(project, '.claude', 'rules'))
    expect(paths('codex')[0]).toEqual([join(home, '.codex', 'AGENTS.override.md'), join(home, '.codex', 'AGENTS.md')])
    expect(paths('gemini')).toEqual([join(home, '.gemini', 'GEMINI.md'), join(project, 'GEMINI.md')])
    expect(paths('cursor')).toContainEqual(join(project, '.cursorrules'))
    expect(paths('copilot')).toContainEqual(join(project, '.github', 'copilot-instructions.md'))
    expect(rulesCandidates('kimi', { home })).toEqual([]) // no project: nothing
    expect(claudeProjectSlug('C:\\Tessel')).toBe('C--Tessel')
    expect(foldersUp(join(project, 'src'), project)).toEqual([join(project, 'src'), project])
  })
})

describe('reading them', () => {
  it("reads Claude's files, imports, memory and conditional rules; Tessel's block apart", async () => {
    const claudeDir = join(home, '.claude')
    write(join(claudeDir, 'CLAUDE.md'), `Be brief.\n@~/.claude/team.md\n@~/shared/notes.md\n\`@not/an/import.md\`\n${RULE_START}\nBoard rule.\n${RULE_END}\n`)
    write(join(claudeDir, 'team.md'), 'Team conventions.')
    write(join(home, 'shared', 'notes.md'), 'Outside notes.')
    write(join(project, 'CLAUDE.md'), 'Project rules.')
    write(join(project, '.claude', 'rules', 'style.md'), 'Use tabs.')
    write(join(project, '.claude', 'rules', 'tests.md'), '---\npaths: ["**/*.spec.js"]\n---\nTest rules.')
    const memory = join(claudeDir, 'projects', claudeProjectSlug(project), 'memory', 'MEMORY.md')
    write(memory, Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n'))
    const rules = await readRules('claude', { home, cwd: project, env: {}, claudeDir })
    const by = (name) => rules.find((r) => r.path.endsWith(name) && !r.tessel)
    expect(by('CLAUDE.md').text).toContain('Be brief.')
    expect(by('CLAUDE.md').text).not.toContain('Board rule.')
    const tessel = rules.find((r) => r.tessel)
    expect(tessel.text).toContain('Board rule.')
    expect(by('team.md')).toMatchObject({ note: 'import', scope: 'user', loaded: true })
    // Outside the project and Claude's folders: listed, never read.
    expect(by('notes.md')).toMatchObject({ note: 'outside', loaded: false, text: '' })
    expect(rules.some((r) => r.path.endsWith('an' + sep + 'import.md'))).toBe(false)
    expect(by('style.md').loaded).toBe(true)
    expect(by('tests.md')).toMatchObject({ loaded: false, note: 'onDemand' })
    expect(by('MEMORY.md')).toMatchObject({ note: 'memory' })
    expect(by('MEMORY.md').text.split('\n')).toHaveLength(200)
    expect(rules.filter((r) => r.path === join(project, 'CLAUDE.md'))).toHaveLength(1)
  })

  it("reads Codex's override first and caps its project files at 32 KiB", async () => {
    write(join(home, '.codex', 'AGENTS.md'), 'plain')
    write(join(home, '.codex', 'AGENTS.override.md'), 'override')
    write(join(project, 'AGENTS.md'), 'x'.repeat(40 * 1024))
    const rules = await readRules('codex', { home, cwd: project, env: {} })
    expect(rules[0]).toMatchObject({ text: 'override', scope: 'user' })
    expect(rules.some((r) => r.text === 'plain')).toBe(false)
    expect(rules[1]).toMatchObject({ note: 'truncated' })
    expect(rules[1].text.length).toBe(32 * 1024)
  })

  it('finds "@path" imports outside code only, network paths kept unresolved', () => {
    const file = join(home, 'CLAUDE.md')
    expect(claudeImports('See @docs/a.md and @~/b.md, ask @someone.\n```\n@c.md\n```', file, home)).toEqual([
      { raw: 'docs/a.md', path: join(home, 'docs', 'a.md') },
      { raw: '~/b.md', path: join(home, 'b.md') }
    ])
    expect(claudeImports('@\\\\evil\\share\\r.md and @//evil/share/r.md', file, home)).toEqual([
      { raw: '\\\\evil\\share\\r.md', path: null },
      { raw: '//evil/share/r.md', path: null }
    ])
    expect(splitTesselBlock('only mine')).toEqual({ own: 'only mine', tessel: '' })
    expect(splitTesselBlock(`${RULE_START}\nx\n${RULE_END}`).own).toBe('')
  })
})

describe('imports never lead out of the project, to the network or to credentials', () => {
  it('refuses network, device, outside, credentials and non-text targets before touching the disk', () => {
    const roots = [project, join(home, '.claude')]
    const at = (p) => importProblem(p, p, roots)
    expect(importProblem('\\\\evil.example.com\\share\\rules.md', null, roots)).toBe('network')
    expect(importProblem('//evil.example.com/share/rules.md', null, roots)).toBe('network')
    expect(at('\\\\.\\pipe\\probe')).toBe('network')
    expect(at(join(project, 'NUL'))).toBe('network')
    expect(at(join(home, '.ssh', 'id_ed25519'))).toBe('skipped')
    expect(at(join(home, '.claude', '.credentials.json'))).toBe('skipped')
    expect(at(join(project, 'setup.cmd'))).toBe('skipped')
    expect(at(join(project, 'tool.dll'))).toBe('skipped')
    expect(at('C:\\Windows\\win.ini')).toBe('skipped') // not text
    expect(at(join(root, 'elsewhere', 'notes.md'))).toBe('outside')
    expect(at(join(project, 'docs', 'rules.md'))).toBe(null)
    expect(at(join(home, '.claude', 'team.md'))).toBe(null)
    expect(isSensitivePath(join(home, '.aws', 'config'))).toBe(true)
    expect(isSensitivePath(join(project, '.env.local'))).toBe(true)
    expect(isSensitivePath(join(project, 'CLAUDE.md'))).toBe(false)
  })

  it('lists the refused imports without reading them, and never stats a network path', async () => {
    write(join(project, 'CLAUDE.md'), ['@\\\\evil.example.com\\share\\rules.md', '@~/.ssh/id_ed25519', '@../../outside.md', '@docs/ok.md', '@docs/run.cmd'].join('\n'))
    write(join(project, 'docs', 'ok.md'), 'Fine.')
    write(join(root, 'outside.md'), 'Outside.')
    const stat = vi.spyOn(fsp, 'stat')
    const rules = await readRules('claude', { home, cwd: project, env: {}, claudeDir: join(home, '.claude') }, createFileReader({ fsApi: fsp }))
    expect(stat.mock.calls.some(([p]) => /^[\\/]{2}/.test(String(p)))).toBe(false)
    stat.mockRestore()
    const notes = Object.fromEntries(rules.map((r) => [r.path.split(/[\\/]/).pop(), r.note]))
    expect(notes['ok.md']).toBe('import')
    expect(notes['rules.md']).toBe('outside')
    expect(notes['outside.md']).toBe('outside')
    expect(notes['id_ed25519']).toBe('skipped')
    expect(notes['run.cmd']).toBe('skipped')
    expect(rules.filter((r) => r.note === 'outside' || r.note === 'skipped').every((r) => r.text === '' && r.loaded === false)).toBe(true)
  })

  it('caps what one summary reads: files and bytes, shared by all agents', async () => {
    const lines = []
    for (let i = 0; i < 8; i++) {
      write(join(project, 'docs', `r${i}.md`), 'x'.repeat(1000))
      lines.push(`@docs/r${i}.md`)
    }
    write(join(project, 'CLAUDE.md'), lines.join('\n'))
    const budget = { ...readBudget(), files: 4, bytes: 1024 * 1024 }
    // (Only this project's files: a CLAUDE.md above the temp folder is not ours.)
    const mine = (list) => list.filter((r) => r.path.startsWith(project))
    const rules = mine(await readRules('claude', { home, cwd: project, env: {}, budget }, createFileReader({ fsApi: fsp })))
    expect(rules.filter((r) => r.loaded).length).toBe(4)
    expect(rules.filter((r) => r.note === 'limit').length).toBe(5)
    // The same file again for another agent costs nothing more.
    const again = mine(await readRules('claude', { home, cwd: project, env: {}, budget }, createFileReader({ fsApi: fsp })))
    expect(again.filter((r) => r.loaded).length).toBe(4)
    const bytes = { ...readBudget(), bytes: 1500 }
    const byBytes = mine(await readRules('claude', { home, cwd: project, env: {}, budget: bytes }, createFileReader({ fsApi: fsp })))
    expect(byBytes.filter((r) => r.loaded).length).toBe(3)
  })
})

describe('the file reader: read again only when size or date changed', () => {
  it('keeps a file by mtime and size', async () => {
    const file = join(root, 'rules.md')
    write(file, 'first')
    const open = vi.spyOn(fsp, 'open')
    const reader = createFileReader({ fsApi: fsp })
    expect((await reader.read(file)).text).toBe('first')
    expect((await reader.read(file)).text).toBe('first')
    expect(open).toHaveBeenCalledTimes(1)
    fs.writeFileSync(file, 'second, longer')
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(file, later, later)
    expect((await reader.read(file)).text).toBe('second, longer')
    expect(open).toHaveBeenCalledTimes(2)
    fs.rmSync(file)
    expect(await reader.read(file)).toBe(null)
    open.mockRestore()
  })

  it('keeps a bounded memo (files and bytes), the oldest dropped first', async () => {
    const reader = createFileReader({ fsApi: fsp, memoFiles: 3, memoBytes: 25 })
    for (let i = 0; i < 5; i++) {
      write(join(root, `m${i}.md`), '0123456789')
      await reader.read(join(root, `m${i}.md`))
    }
    expect(reader.memoSize()).toEqual({ files: 2, bytes: 20 })
    reader.clear()
    expect(reader.memoSize()).toEqual({ files: 0, bytes: 0 })
    expect(await reader.read('\\\\host\\share\\x.md')).toBe(null)
  })
})

// Only the temp folder of the test: the folders above it (and a CLAUDE.md
// there, the real user's) are missing to this reader.
const confined = (reader) => {
  const mine = (p) => isInside(root, p)
  return {
    ...reader,
    real: (p, c) => (mine(p) ? reader.real(p, c) : Promise.resolve(null)),
    read: (p, c) => (mine(p) ? reader.read(p, c) : Promise.resolve(null)),
    list: (p, x, c) => (mine(p) ? reader.list(p, x, c) : Promise.resolve([])),
    isDir: (p, c) => (mine(p) ? reader.isDir(p, c) : Promise.resolve(false)),
    linkProblem: (p, c) => (mine(p) ? reader.linkProblem(p, c) : Promise.resolve('missing'))
  }
}

describe('a flood of imports: one summary looks at IMPORT_LIMIT of them', () => {
  it('lists IMPORT_LIMIT at most, then one line with the number of the others, never resolved', async () => {
    const lines = []
    for (let i = 0; i < 300; i++) lines.push(`@../../out${i}.md`) // outside
    for (let i = 0; i < 300; i++) lines.push(`@docs/missing${i}.md`) // missing
    write(join(project, 'CLAUDE.md'), lines.join('\n'))
    const reader = confined(createFileReader({ fsApi: fsp }))
    const real = vi.spyOn(reader, 'real')
    const links = vi.spyOn(reader, 'linkProblem')
    const rules = await readRules('claude', { home, cwd: project, env: {}, claudeDir: join(home, '.claude') }, reader)
    const listed = rules.filter((r) => ['outside', 'skipped', 'limit'].includes(r.note))
    expect(listed).toHaveLength(IMPORT_LIMIT)
    expect(rules.filter((r) => r.note === 'more')).toEqual([{ id: 'claude:more', path: '', scope: null, text: '', loaded: false, note: 'more', count: 600 - IMPORT_LIMIT }])
    // The missing ones past the limit were never looked up.
    expect([...real.mock.calls, ...links.mock.calls].filter(([p]) => /missing\d+\.md$/.test(p))).toHaveLength(0)
  })

  it('looks a missing import up once, and counts it against the read budget', async () => {
    write(join(project, 'CLAUDE.md'), ['@docs/a.md', '@docs/a.md', '@./docs/a.md', '@docs/b.md', '@docs/c.md', '@docs/ok.md'].join('\n'))
    write(join(project, 'docs', 'ok.md'), 'Fine.')
    const reader = confined(createFileReader({ fsApi: fsp }))
    const links = vi.spyOn(reader, 'linkProblem')
    const budget = { ...readBudget(), files: 4 }
    const rules = await readRules('claude', { home, cwd: project, env: {}, budget }, reader)
    expect(links.mock.calls.filter(([p]) => p.endsWith('a.md'))).toHaveLength(1)
    // CLAUDE.md, then a, b and c (missing): the budget is spent before ok.md.
    expect(rules.find((r) => r.path.endsWith('ok.md'))).toMatchObject({ note: 'limit', loaded: false, text: '' })
    expect(budget.files).toBe(0)
  })
})

// A fake disk: this PC refuses to create file symlinks (EPERM), so links are
// answered by lstat and readlink here. stat, realpath, open and readdir
// record each path they are asked, which the system would follow.
function fakeDisk({ files = {}, links = {}, dirs = [] }) {
  const norm = (p) => resolve(p).toLowerCase()
  const F = new Map(Object.entries(files).map(([p, t]) => [norm(p), t]))
  const L = new Map(Object.entries(links).map(([p, t]) => [norm(p), t]))
  const D = new Set(dirs.map(norm))
  const followed = []
  const isDir = (p) => {
    const n = norm(p)
    if (D.has(n) || n === norm(parse(n).root)) return true
    return [...F.keys(), ...L.keys(), ...D].some((k) => k.startsWith(n.endsWith(sep) ? n : n + sep))
  }
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const kind = (link, file, dir) => ({ isSymbolicLink: () => link, isFile: () => file, isDirectory: () => dir })
  // Where the system would land: the local links followed.
  const land = (p) => {
    const full = resolve(p)
    let cur = parse(full).root
    for (const part of full.slice(cur.length).split(/[\\/]/).filter(Boolean)) {
      const next = join(cur, part)
      const t = L.get(norm(next))
      cur = t === undefined ? next : resolve(dirname(next), t)
    }
    return cur
  }
  return {
    followed,
    async lstat(p) {
      const n = norm(p)
      if (L.has(n)) return kind(true, false, false)
      if (F.has(n)) return { ...kind(false, true, false), size: F.get(n).length, mtimeMs: 1 }
      if (isDir(p)) return kind(false, false, true)
      throw enoent()
    },
    async readlink(p) {
      if (!L.has(norm(p))) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
      return L.get(norm(p))
    },
    async stat(p) {
      followed.push(p)
      const n = norm(land(p))
      if (F.has(n)) return { ...kind(false, true, false), size: F.get(n).length, mtimeMs: 1 }
      if (isDir(land(p))) return kind(false, false, true)
      throw enoent()
    },
    async realpath(p) {
      followed.push(p)
      const to = land(p)
      if (!F.has(norm(to)) && !isDir(to)) throw enoent()
      return to
    },
    async open(p) {
      followed.push(p)
      const text = F.get(norm(land(p)))
      if (text === undefined) throw enoent()
      return {
        async read(buffer, offset, length) {
          const b = Buffer.from(text)
          b.copy(buffer, offset, 0, length)
          return { bytesRead: Math.min(length, b.length) }
        },
        async close() {}
      }
    },
    async readdir(p) {
      followed.push(p)
      return []
    }
  }
}

describe('links to the network or a device are never followed', () => {
  const base = join(os.tmpdir(), 'tessel-fake-disk') // never created: fakeDisk only
  const proj = join(base, 'proj')
  const fakeHome = join(base, 'home')
  const bad = [join(proj, 'share'), join(proj, 'pipe.md'), join(proj, 'chain'), join(base, 'hop'), join(proj, 'dev.md'), join(proj, '.git'), join(proj, 'rules')]
  const disk = () =>
    fakeDisk({
      dirs: [proj, fakeHome],
      files: {
        [join(proj, 'CLAUDE.md')]: ['@./share/rules.md', '@./pipe.md', '@./chain/rules.md', '@./dev.md', '@./ok.md', '@./notes.md', '@./cfg.md'].join('\n'),
        [join(proj, 'ok.md')]: 'Fine.',
        [join(proj, 'tool.exe')]: 'MZ',
        [join(base, 'other', '.git', 'config')]: '[core]'
      },
      links: {
        [join(proj, 'share')]: '\\\\evil.example.com\\share',
        [join(proj, 'pipe.md')]: '\\\\.\\pipe\\probe',
        [join(proj, 'chain')]: join(base, 'hop'), // local, but leads on to a share
        [join(base, 'hop')]: '//evil.example.com/share',
        [join(proj, 'dev.md')]: join(base, 'NUL'),
        [join(proj, '.git')]: '\\\\evil.example.com\\repo',
        [join(proj, 'rules')]: '\\\\evil.example.com\\rules',
        // Links with a text name, to a program and into .git.
        [join(proj, 'notes.md')]: join(proj, 'tool.exe'),
        [join(proj, 'cfg.md')]: join(base, 'other', '.git', 'config')
      }
    })
  const throughBad = (followed) => followed.filter((p) => bad.some((link) => isInside(link, p)))

  it('lists an import through such a link as not followed, and never stats, opens or resolves it', async () => {
    const fsApi = disk()
    const rules = await readRules('claude', { home: fakeHome, cwd: proj, env: {}, claudeDir: join(fakeHome, '.claude'), gitRoot: proj }, createFileReader({ fsApi }))
    const notes = Object.fromEntries(rules.map((r) => [r.path.slice(proj.length + 1), r.note]))
    expect(notes[join('share', 'rules.md')]).toBe('outside')
    expect(notes['pipe.md']).toBe('outside')
    expect(notes[join('chain', 'rules.md')]).toBe('outside')
    expect(notes['dev.md']).toBe('outside')
    expect(notes['ok.md']).toBe('import')
    expect(throughBad(fsApi.followed)).toEqual([])
    expect(rules.find((r) => r.path.endsWith('ok.md')).text).toBe('Fine.')
  })

  it('checks the real path of a link with a text name: a program or a .git file is not read', async () => {
    const fsApi = disk()
    const rules = await readRules('claude', { home: fakeHome, cwd: proj, env: {}, gitRoot: proj }, createFileReader({ fsApi }))
    expect(rules.find((r) => r.path === join(proj, 'notes.md'))).toMatchObject({ note: 'skipped', loaded: false, text: '' })
    expect(rules.find((r) => r.path === join(proj, 'cfg.md'))).toMatchObject({ note: 'skipped', loaded: false, text: '' })
    expect(fsApi.followed.some((p) => /tool\.exe$|config$/.test(p))).toBe(false)
  })

  it('refuses them in every reader call and in findGitRoot', async () => {
    const fsApi = disk()
    const reader = createFileReader({ fsApi })
    expect(await reader.read(join(proj, 'share', 'x.md'))).toBe(null)
    expect(await reader.real(join(proj, 'pipe.md'))).toBe(null)
    expect(await reader.list(join(proj, 'rules'), ['.md'])).toEqual([])
    expect(await reader.isDir(join(proj, 'chain'))).toBe(false)
    expect(await reader.linkProblem(join(proj, 'chain', 'x.md'))).toBe('network')
    expect(await reader.linkProblem(join(proj, 'nothing.md'))).toBe('missing')
    expect((await walkLinks(join(proj, 'notes.md'), { fsApi })).path).toBe(join(proj, 'tool.exe'))
    expect(await findGitRoot(join(proj, 'src'), fsApi)).toBe(proj) // a .git link, seen by lstat, not followed
    expect(throughBad(fsApi.followed)).toEqual([])
  })

  it('ends a loop of links', async () => {
    const fsApi = fakeDisk({ dirs: [proj], links: { [join(proj, 'a')]: join(proj, 'b'), [join(proj, 'b')]: join(proj, 'a') } })
    const readlink = vi.spyOn(fsApi, 'readlink')
    expect((await walkLinks(join(proj, 'a', 'x.md'), { fsApi })).problem).toBe('skipped')
    expect(readlink.mock.calls.length).toBeLessThan(20)
  })
})

describe('where imports may lead', () => {
  it('the project folder, or its git root when close above it and holding neither home nor a drive', () => {
    const repo = join(root, 'repo')
    expect(importRoot(join(repo, 'a', 'b'), repo, home)).toBe(repo)
    expect(importRoot(join(repo, 'a', 'b', 'c', 'd'), repo, home)).toBe(join(repo, 'a', 'b', 'c', 'd')) // too far down
    expect(importRoot(join(home, 'Downloads', 'x'), home, home)).toBe(join(home, 'Downloads', 'x')) // a dotfiles repo
    expect(importRoot(join(home, 'x'), dirname(home), home)).toBe(join(home, 'x')) // above home
    const drive = parse(root).root
    expect(importRoot(join(drive, 'work'), drive, home)).toBe(join(drive, 'work'))
    expect(importRoot(project, null, home)).toBe(project)
    expect(importRoot(null, repo, home)).toBe(null)
  })

  it('never into a dotfiles repository’s whole home folder', async () => {
    fs.mkdirSync(join(home, '.git'), { recursive: true })
    const proj = join(home, 'Downloads', 'unzipped')
    write(join(home, 'Documents', 'notes.txt'), 'PRIVATE NOTES')
    write(join(proj, 'CLAUDE.md'), 'See @../../Documents/notes.txt')
    const gitRoot = await findGitRoot(proj)
    expect(gitRoot).toBe(home)
    const rules = await readRules('claude', { home, cwd: proj, env: {}, claudeDir: join(home, '.claude'), gitRoot }, confined(createFileReader({ fsApi: fsp })))
    expect(rules.find((r) => r.path.endsWith('notes.txt'))).toMatchObject({ note: 'outside', text: '' })
    expect(JSON.stringify(rules)).not.toContain('PRIVATE NOTES')
  })

  it('never anything in .git, even a file with no extension', () => {
    expect(importProblem('./.git/config', join(project, '.git', 'config'), [project])).toBe('skipped')
    expect(importProblem('./.GIT/hooks/pre-commit', join(project, '.GIT', 'hooks', 'pre-commit'), [project])).toBe('skipped')
    expect(importProblem('./docs/README', join(project, 'docs', 'README'), [project])).toBe(null)
  })

  it('follows the imports of a project opened through a junction, and of a ~/.claude behind one', async () => {
    const real = join(root, 'real-project')
    write(join(real, 'docs', 'style.md'), 'Project style.')
    write(join(real, 'CLAUDE.md'), 'See @./docs/style.md')
    fs.mkdirSync(join(real, '.git'))
    const linked = join(root, 'linked-project')
    fs.symlinkSync(real, linked, 'junction')
    const claudeReal = join(root, 'dotfiles', 'claude')
    write(join(claudeReal, 'CLAUDE.md'), 'See @./team.md')
    write(join(claudeReal, 'team.md'), 'Team rules.')
    fs.symlinkSync(claudeReal, join(home, '.claude'), 'junction')
    const rules = await readRules('claude', { home, cwd: linked, env: {}, gitRoot: linked }, confined(createFileReader({ fsApi: fsp })))
    expect(rules.find((r) => r.path.endsWith('style.md'))).toMatchObject({ note: 'import', text: 'Project style.' })
    expect(rules.find((r) => r.path.endsWith('team.md'))).toMatchObject({ note: 'import', text: 'Team rules.' })
  })
})
