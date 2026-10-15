import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { listSkills, packageFromFolder, installSkill, removeSkill, createSkillSources, skillOrigin, contentHash, dropStaleSources, SKILL_CAPS } from '../skillsManager'
import { createSkillHistory, readSkillTree, isText, HISTORY_CAPS } from '../skillHistory'
import { createSkillUpdates, mapCommit, UPDATE_CHECK } from '../skillUpdates'
import { diffTexts } from '../../shared/diff'
import { setLanguage } from '../i18n'

let tmp, home, env, clock
const now = () => clock
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
}
const skillMd = (name, body = 'Do things.') => `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`
const blobsOf = (history, dir) => {
  try {
    return fs.readdirSync(path.join(history.folderOf(dir), 'blobs'))
  } catch {
    return []
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-skilltrack-'))
  home = path.join(tmp, 'home')
  fs.mkdirSync(home, { recursive: true })
  env = {}
  clock = Date.UTC(2026, 9, 15, 12, 0, 0)
})
afterEach(() => {
  setLanguage('en')
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('origin', () => {
  it('is the user\'s own without a record, GitHub or folder when Tessel added it, the agent\'s when managed', () => {
    expect(skillOrigin({ source: null, managed: null })).toBe('own')
    expect(skillOrigin({ source: { kind: 'github', owner: 'o', repo: 'r' }, managed: null })).toBe('github')
    expect(skillOrigin({ source: { kind: 'folder', path: '/x' }, managed: null })).toBe('folder')
    expect(skillOrigin({ source: null, managed: 'synced' })).toBe('agent')
    expect(skillOrigin({ source: { kind: 'github' }, managed: 'nested' })).toBe('agent')
  })

  it('comes with every listed copy', async () => {
    const root = path.join(home, '.claude', 'skills')
    write(path.join(root, 'mine', 'SKILL.md'), skillMd('mine'))
    write(path.join(root, 'pdf', 'SKILL.md'), skillMd('pdf'))
    write(path.join(root, 'copied', 'SKILL.md'), skillMd('copied'))
    write(path.join(root, 'synced', 'acct', 'docx', 'SKILL.md'), skillMd('docx'))
    const sources = createSkillSources(path.join(tmp, 'data', 'skill-sources.json'))
    sources.set(path.join(root, 'pdf'), { kind: 'github', owner: 'o', repo: 'r', path: 'skills/pdf' })
    sources.set(path.join(root, 'copied'), { kind: 'folder', path: '/somewhere' })
    const { skills } = await listSkills({ home, env, sources: sources.all() })
    const origin = Object.fromEntries(skills.map((s) => [s.name, s.origin]))
    expect(origin).toEqual({ mine: 'own', pdf: 'github', copied: 'folder', docx: 'agent' })
  })
})

describe('text diff', () => {
  it('finds the lines added and removed, with context, in the shape of a parsed unified diff', () => {
    const a = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].join('\n') + '\n'
    const b = ['one', 'two', 'THREE', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'].join('\n') + '\n'
    const d = diffTexts(a, b, { context: 1 })
    expect(d).toMatchObject({ binary: false, added: 2, removed: 1, truncated: false })
    expect(d.hunks).toHaveLength(2)
    expect(d.hunks[0].header).toBe('@@ -2,3 +2,3 @@')
    expect(d.hunks[0].lines.map((l) => [l.kind, l.text, l.old, l.new])).toEqual([
      ['ctx', 'two', 2, 2],
      ['del', 'three', 3, ''],
      ['add', 'THREE', '', 3],
      ['ctx', 'four', 4, 4]
    ])
    expect(d.hunks[1].lines.map((l) => l.kind)).toEqual(['ctx', 'add'])
    expect(diffTexts('', 'a\nb\n')).toMatchObject({ added: 2, removed: 0 })
    expect(diffTexts('a\r\nb\r\n', 'a\nb\n')).toMatchObject({ added: 0, removed: 0, hunks: [] })
  })

  it('stays bounded: a huge middle is shown replaced, and the lines shown are capped', () => {
    const a = Array.from({ length: 300 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: 300 }, (_, i) => `b${i}`).join('\n')
    const d = diffTexts(a, b, { maxCells: 100, maxLines: 50 })
    expect(d).toMatchObject({ added: 300, removed: 300, truncated: true })
    expect(d.hunks.reduce((n, h) => n + h.lines.length, 0)).toBe(50)
  })
})

describe('version history', () => {
  const skillDir = () => path.join(home, '.claude', 'skills', 'mine')
  const historyAt = (caps) => createSkillHistory(path.join(tmp, 'data', 'skill-history'), { now, caps: { ...HISTORY_CAPS, ...caps } })

  it('keeps a version only when the content changed, outside the skill folder', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine'))
    write(path.join(dir, 'notes.md'), 'line 1\nline 2\n')
    const history = historyAt()
    const first = await history.track(dir)
    expect(first).toMatchObject({ versions: 1 })
    expect(fs.readdirSync(dir).sort()).toEqual(['SKILL.md', 'notes.md']) // nothing written in the skill
    clock += 1000
    expect(await history.track(dir)).toMatchObject({ versions: 1, hash: first.hash })
    // Saved again with the same content (a newer time): no version.
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(path.join(dir, 'notes.md'), later, later)
    expect(await history.track(dir)).toMatchObject({ versions: 1, hash: first.hash })
    // Changed: a new version, with what it changed.
    write(path.join(dir, 'notes.md'), 'line 1\nline two\nline 3\n')
    clock += 1000
    const second = await history.track(dir)
    expect(second.versions).toBe(2)
    expect(second.hash).not.toBe(first.hash)
    const { versions } = history.list(dir)
    expect(versions[0]).toMatchObject({ latest: true, first: false, files: ['notes.md'], fileCount: 1, stats: { modified: 1, plus: 2, minus: 1 } })
    expect(versions[1]).toMatchObject({ first: true, latest: false, files: ['SKILL.md', 'notes.md'] })
  })

  it('keeps every file up to the file cap, binaries too; a larger one is noted by its hash', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine'))
    write(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]))
    write(path.join(dir, 'big.txt'), 'x'.repeat(500))
    const history = historyAt({ fileCap: 200 })
    expect(await history.track(dir)).toMatchObject({ saved: true, complete: false, truncated: false })
    expect(blobsOf(history, dir)).toHaveLength(2) // SKILL.md and logo.png
    fs.rmSync(path.join(dir, 'big.txt'))
    clock += 1000
    expect(await history.track(dir)).toMatchObject({ complete: true })
    expect(isText(Buffer.from('héllo'))).toBe(true)
    expect(isText(Buffer.from([0xff, 0xfe, 0x41]))).toBe(false)
  })

  it('is bounded: the oldest versions go beyond the count or the text kept, with their contents', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine'))
    const history = historyAt({ versions: 3 })
    for (let i = 0; i < 6; i++) {
      write(path.join(dir, 'notes.md'), `version ${i}\n`.repeat(i + 1))
      clock += 1000
      await history.track(dir)
    }
    expect(history.list(dir).versions).toHaveLength(3)
    expect(history.list(dir).versions[2]).toMatchObject({ oldest: true, first: false })
    expect(blobsOf(history, dir)).toHaveLength(5) // SKILL.md, the 3 kept notes, and the one the index's backup copy still names

    const small = historyAt({ bytes: 600 })
    const other = path.join(home, '.claude', 'skills', 'other')
    write(path.join(other, 'SKILL.md'), skillMd('other'))
    for (let i = 0; i < 4; i++) {
      write(path.join(other, 'notes.md'), `${i}`.repeat(300))
      clock += 1000
      await small.track(other)
    }
    expect(small.list(other).versions).toHaveLength(2) // over the size cap: still the last two
  })

  it('compares a version with the one before: added, removed, changed, binary', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine', 'Old rule.'))
    write(path.join(dir, 'old.md'), 'gone\n')
    write(path.join(dir, 'logo.png'), Buffer.from([1, 0, 2]))
    const history = historyAt()
    await history.track(dir)
    write(path.join(dir, 'SKILL.md'), skillMd('mine', 'New rule.'))
    fs.rmSync(path.join(dir, 'old.md'))
    write(path.join(dir, 'new.md'), 'hello\nworld\n')
    write(path.join(dir, 'logo.png'), Buffer.from([1, 0, 3, 4]))
    clock += 1000
    await history.track(dir)
    const [latest, first] = history.list(dir).versions
    const d = await history.diff(dir, latest.id)
    expect(d.previous).toBe(first.id)
    const by = Object.fromEntries(d.files.map((f) => [f.path, f]))
    expect(by['SKILL.md']).toMatchObject({ status: 'M', added: 1, removed: 1, binary: false })
    expect(by['SKILL.md'].hunks[0].lines.filter((l) => l.kind !== 'ctx').map((l) => l.text)).toEqual(['Old rule.', 'New rule.'])
    expect(by['new.md']).toMatchObject({ status: 'A', added: 2, removed: 0 })
    expect(by['old.md']).toMatchObject({ status: 'D', added: 0, removed: 1 })
    expect(by['logo.png']).toMatchObject({ status: 'M', binary: true })
    expect(latest.stats).toMatchObject({ added: 1, removed: 1, modified: 2, plus: 3, minus: 2 })
    // The first version: shown whole.
    const whole = await history.diff(dir, first.id)
    expect(whole.previous).toBe(null)
    expect(whole.files.find((f) => f.path === 'old.md')).toMatchObject({ status: 'A', added: 1 })
    await expect(history.diff(dir, 'nope')).rejects.toThrow(/no longer in the history/)
  })

  it('restores a version after keeping the current content, and refuses a folder it does not know', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine', 'Version one.'))
    write(path.join(dir, 'docs', 'a.md'), 'a\n')
    const history = historyAt()
    await history.track(dir)
    const v1 = history.list(dir).versions[0]
    // Edited, never listed since: restore keeps this first.
    write(path.join(dir, 'SKILL.md'), skillMd('mine', 'Version two, edited.'))
    write(path.join(dir, 'extra', 'b.md'), 'b\n')
    write(path.join(dir, 'pic.bin'), Buffer.from([0, 1, 2, 3]))
    clock += 1000
    const res = await history.restore(dir, v1.id, { home, env })
    expect(res).toMatchObject({ ok: true, kept: [] })
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('Version one.')
    expect(fs.existsSync(path.join(dir, 'extra'))).toBe(false) // emptied folder removed
    expect(fs.existsSync(path.join(dir, 'pic.bin'))).toBe(false) // kept in the history, so removed
    expect(fs.existsSync(path.join(dir, 'docs', 'a.md'))).toBe(true)
    const versions = history.list(dir).versions
    expect(versions).toHaveLength(3)
    expect(versions[0].note).toMatchObject({ kind: 'restore', from: v1.id })
    // The edited version is in the history: it can come back.
    const edited = versions[1]
    expect((await history.diff(dir, edited.id)).files.map((f) => f.path)).toContain('extra/b.md')
    await history.restore(dir, edited.id, { home, env })
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('Version two, edited.')
    expect(fs.readFileSync(path.join(dir, 'extra', 'b.md'), 'utf8')).toBe('b\n')
    expect([...fs.readFileSync(path.join(dir, 'pic.bin'))]).toEqual([0, 1, 2, 3]) // a binary comes back too

    const elsewhere = path.join(tmp, 'elsewhere', 'mine')
    write(path.join(elsewhere, 'SKILL.md'), skillMd('mine'))
    await expect(history.restore(elsewhere, v1.id, { home, env })).rejects.toThrow(/not a skill folder Tessel knows/)
  })

  it('refuses to restore a version whose large file was not kept and is gone since', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine'))
    write(path.join(dir, 'big.dat'), 'x'.repeat(300))
    const history = historyAt({ fileCap: 200 })
    await history.track(dir)
    const v1 = history.list(dir).versions[0]
    fs.rmSync(path.join(dir, 'big.dat'))
    write(path.join(dir, 'SKILL.md'), skillMd('mine', 'Edited.'))
    clock += 1000
    await expect(history.restore(dir, v1.id, { home, env })).rejects.toMatchObject({ code: 'SKILL_HISTORY_MISSING' })
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('Edited.') // untouched
  })

  it('never restores a kept content that was damaged', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine', 'One.'))
    const history = historyAt()
    await history.track(dir)
    const v1 = history.list(dir).versions[0]
    for (const name of blobsOf(history, dir)) fs.writeFileSync(path.join(history.folderOf(dir), 'blobs', name), 'damaged')
    write(path.join(dir, 'SKILL.md'), skillMd('mine', 'Two, longer.'))
    clock += 1000
    await expect(history.restore(dir, v1.id, { home, env })).rejects.toMatchObject({ code: 'SKILL_HISTORY_MISSING' })
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('Two, longer.')
  })

  it('reads a skill folder within the caps, without links or .git', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine'))
    write(path.join(dir, '.git', 'HEAD'), 'ref')
    for (let i = 0; i < 5; i++) write(path.join(dir, `f${i}.md`), 'x')
    const tree = await readSkillTree(dir, { ...SKILL_CAPS, files: 4 })
    expect(tree.files).toHaveLength(4)
    expect(tree.truncated).toBe(true)
    expect(tree.files.some((f) => f.rel.startsWith('.git'))).toBe(false)
  })
})

describe('modified locally', () => {
  it('compares each added copy with what was installed; an older record takes its content now', async () => {
    const src = path.join(tmp, 'src', 'helper')
    write(path.join(src, 'SKILL.md'), skillMd('helper'))
    write(path.join(src, 'scripts', 'run.md'), 'step 1\n')
    const sources = createSkillSources(path.join(tmp, 'data', 'skill-sources.json'))
    const history = createSkillHistory(path.join(tmp, 'data', 'skill-history'), { now })
    const pkg = await packageFromFolder(src)
    const res = await installSkill({ id: pkg.id, agents: ['claude'], scope: 'user', home, env, sources, history })
    expect(res.ok).toBe(true)
    const dest = path.join(home, '.claude', 'skills', 'helper')
    const recorded = sources.get(dest)
    expect(recorded.hash).toBe(contentHash([{ rel: 'SKILL.md', data: Buffer.from(skillMd('helper')) }, { rel: 'scripts/run.md', data: Buffer.from('step 1\n') }]))
    const listed = async () => {
      const { skills } = await listSkills({ home, env, sources: sources.all() })
      await history.annotate(skills, { sources })
      return skills.find((s) => s.name === 'helper')
    }
    let copy = await listed()
    expect(copy).toMatchObject({ origin: 'folder', modified: false })
    expect(copy.history.versions).toBe(1)
    expect(history.list(dest).versions[0].note).toMatchObject({ kind: 'install', from: 'folder' })

    write(path.join(dest, 'scripts', 'run.md'), 'step 1\nstep 2 (mine)\n')
    clock += 1000
    copy = await listed()
    expect(copy).toMatchObject({ modified: true })
    expect(copy.history.versions).toBe(2)

    // Updated (replaced): the edited copy stays in the history.
    const again = await packageFromFolder(src)
    clock += 1000
    await installSkill({ id: again.id, replace: dest, home, env, sources, history })
    copy = await listed()
    expect(copy).toMatchObject({ modified: false })
    const versions = history.list(dest).versions
    expect(versions[0].note).toMatchObject({ kind: 'update' })
    expect(versions.some((v) => v.files.includes('scripts/run.md') && v.stats.plus === 1)).toBe(true)

    // Recorded before Tessel kept the installed content: taken as installed.
    const legacy = path.join(home, '.claude', 'skills', 'legacy')
    write(path.join(legacy, 'SKILL.md'), skillMd('legacy'))
    sources.set(legacy, { kind: 'github', owner: 'o', repo: 'r', path: 'legacy' })
    const { skills } = await listSkills({ home, env, sources: sources.all() })
    await history.annotate(skills, { sources })
    expect(skills.find((s) => s.name === 'legacy')).toMatchObject({ modified: false })
    expect(sources.get(legacy)).toMatchObject({ hashAdopted: true })
    expect(sources.get(legacy).hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('leaves the agent\'s own skills alone', async () => {
    write(path.join(home, '.claude', 'skills', 'synced', 'acct', 'docx', 'SKILL.md'), skillMd('docx'))
    const history = createSkillHistory(path.join(tmp, 'data', 'skill-history'), { now })
    const { skills } = await listSkills({ home, env })
    await history.annotate(skills)
    expect(skills[0].history).toBeUndefined()
    expect(fs.existsSync(path.join(tmp, 'data', 'skill-history'))).toBe(false)
  })
})

describe('update check', () => {
  const sha = (c) => c.repeat(40)
  const H = sha('e')
  const A = sha('a')
  const commit = (s, message, date = '2026-10-01T10:00:00Z', name = 'Ada Lovelace') => ({
    sha: s,
    commit: { message, author: { name, date: '2026-09-30T00:00:00Z' }, committer: { name: 'GitHub', date } },
    author: { login: 'ada' }
  })
  const reply = ({ status = 200, body = null, headers = {} } = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body })
  // routes: [[regex, reply | (url, init) => reply]]
  function github(routes) {
    const calls = []
    const fn = async (url, init) => {
      calls.push({ url, etag: init.headers['If-None-Match'] || null })
      for (const [re, r] of routes) if (re.test(url)) return reply(typeof r === 'function' ? r(url, init) : r)
      return reply({ status: 404 })
    }
    fn.calls = calls
    return fn
  }
  // Each skill folder made: a record whose folder is gone is dropped.
  const store = (entries) => {
    const sources = createSkillSources(path.join(tmp, 'data', 'skill-sources.json'))
    for (const [dir, source] of entries) {
      fs.mkdirSync(dir, { recursive: true })
      sources.set(dir, source)
    }
    return sources
  }
  const pdfDir = () => path.join(home, '.claude', 'skills', 'pdf')
  const pdfSource = (over = {}) => ({ kind: 'github', owner: 'o', repo: 'r', ref: null, path: 'skills/pdf', commit: A, ...over })
  const limits = { 'x-ratelimit-remaining': '55', 'x-ratelimit-reset': String(Math.floor(Date.UTC(2026, 9, 15, 13) / 1000)) }
  const newCommitRoutes = () => [
    [/commits\?per_page=1$/, { body: [commit(H, 'Merge')], headers: { etag: 'W/"head1"', ...limits } }],
    [new RegExp(`commits\\?sha=${H}&per_page=30&path=skills%2Fpdf$`), { body: [commit(sha('3'), 'Fix tables\n\nLong body'), commit(sha('2'), 'Add forms'), commit(sha('1'), 'First')], headers: limits }],
    [new RegExp(`commits\\?sha=${A}&per_page=1&path=skills%2Fpdf$`), { body: [commit(sha('1'), 'First')], headers: limits }]
  ]

  it('maps a commit: first line of the message, date, author name', () => {
    expect(mapCommit(commit(sha('1'), 'Fix it\nmore', '2026-10-02T08:30:00Z'))).toEqual({
      sha: sha('1'),
      message: 'Fix it',
      date: Date.parse('2026-10-02T08:30:00Z'),
      author: 'Ada Lovelace'
    })
    expect(mapCommit({ sha: sha('2'), commit: { message: 'x' }, author: { login: 'bob' } })).toMatchObject({ author: 'bob', date: null })
  })

  it('a newer commit touched the folder: update available, with the commits since the installed one', async () => {
    const fetchFn = github(newCommitRoutes())
    const sources = store([[pdfDir(), pdfSource()]])
    const updates = createSkillUpdates(path.join(tmp, 'data', 'skill-updates.json'), { sources, fetchFn, now })
    expect(updates.infoFor(sources.get(pdfDir()))).toBe(null) // not checked yet
    expect(await updates.check()).toMatchObject({ ok: true, checked: true })
    expect(fetchFn.calls).toHaveLength(3)
    expect(fetchFn.calls[0].url).toBe('https://api.github.com/repos/o/r/commits?per_page=1')
    const skills = [{ dir: pdfDir(), source: sources.get(pdfDir()) }]
    updates.annotate(skills)
    expect(skills[0].update).toMatchObject({ available: true, more: false, checkedAt: clock })
    expect(skills[0].update.latest).toMatchObject({ sha: sha('3'), message: 'Fix tables' })
    expect(skills[0].update.commits.map((c) => c.message)).toEqual(['Fix tables', 'Add forms'])
    expect(skills[0].update.commits[0]).toMatchObject({ author: 'Ada Lovelace', date: Date.parse('2026-10-01T10:00:00Z') })
    // Kept in Tessel's data: a new instance knows it without asking.
    const again = createSkillUpdates(path.join(tmp, 'data', 'skill-updates.json'), { sources, fetchFn, now })
    expect(again.infoFor(sources.get(pdfDir()))).toMatchObject({ available: true })
    expect(fetchFn.calls).toHaveLength(3)
  })

  it('installed at the newest commit: no update, one request per repository for all its skills', async () => {
    const fetchFn = github([[/commits\?per_page=1&sha=main$/, { body: [commit(H, 'Head')], headers: limits }]])
    const sources = store([
      [pdfDir(), pdfSource({ ref: 'main', commit: H })],
      [path.join(home, '.claude', 'skills', 'docx'), pdfSource({ ref: 'main', commit: H, path: 'skills/docx' })]
    ])
    const updates = createSkillUpdates(path.join(tmp, 'data', 'skill-updates.json'), { sources, fetchFn, now })
    await updates.check()
    expect(fetchFn.calls).toHaveLength(1)
    expect(updates.infoFor(sources.get(pdfDir()))).toMatchObject({ available: false, commits: [] })
  })

  it('a newer commit elsewhere in the repository: no update for this folder', async () => {
    const routes = newCommitRoutes()
    routes[1][1] = { body: [commit(sha('1'), 'First')], headers: limits }
    const fetchFn = github(routes)
    const sources = store([[pdfDir(), pdfSource()]])
    const updates = createSkillUpdates(path.join(tmp, 'data', 'skill-updates.json'), { sources, fetchFn, now })
    await updates.check()
    expect(updates.infoFor(sources.get(pdfDir()))).toMatchObject({ available: false, commits: [] })
  })

  it('about once a day, and never again within a minute when asked; ETag kept: a 304 reuses the answers', async () => {
    let head = 0
    const routes = newCommitRoutes()
    routes[0][1] = (url, init) => {
      head++
      return init.headers['If-None-Match'] === 'W/"head1"' ? { status: 304, headers: limits } : { body: [commit(H, 'Merge')], headers: { etag: 'W/"head1"', ...limits } }
    }
    const fetchFn = github(routes)
    const sources = store([[pdfDir(), pdfSource()]])
    const updates = createSkillUpdates(path.join(tmp, 'data', 'skill-updates.json'), { sources, fetchFn, now })
    await updates.check()
    expect(fetchFn.calls).toHaveLength(3)
    clock += 3600 * 1000
    expect(await updates.check()).toMatchObject({ checked: false }) // not a day yet
    expect(fetchFn.calls).toHaveLength(3)
    expect(await updates.check({ force: true })).toMatchObject({ checked: true })
    expect(fetchFn.calls).toHaveLength(4) // the repository only: 304, the rest kept
    expect(fetchFn.calls[3].etag).toBe('W/"head1"')
    expect(head).toBe(2)
    expect(updates.infoFor(sources.get(pdfDir()))).toMatchObject({ available: true })
    clock += 10 * 1000
    expect(await updates.check({ force: true })).toMatchObject({ checked: false })
    expect(fetchFn.calls).toHaveLength(4)
    clock += UPDATE_CHECK.every
    expect(await updates.check()).toMatchObject({ checked: true })
    expect(fetchFn.calls).toHaveLength(5)
  })

  it('rate limited (403 with nothing left): stops, and asks nothing until GitHub\'s reset time', async () => {
    const reset = Math.floor(clock / 1000) + 600
    const fetchFn = github([[/commits\?per_page=1$/, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }]])
    const sources = store([[pdfDir(), pdfSource()]])
    const updates = createSkillUpdates(path.join(tmp, 'data', 'skill-updates.json'), { sources, fetchFn, now })
    expect(await updates.check()).toMatchObject({ ok: false, rateLimited: true, until: reset * 1000 })
    clock += 60 * 1000
    expect(await updates.check({ force: true })).toMatchObject({ rateLimited: true, checked: false })
    expect(fetchFn.calls).toHaveLength(1)
    expect(updates.status().until).toBe(reset * 1000)
    clock = reset * 1000 + 1
    await updates.check({ force: true })
    expect(fetchFn.calls).toHaveLength(2)
  })

  it('429 with Retry-After, and a low remaining count: backs off without asking', async () => {
    const fetchFn = github([[/commits\?per_page=1$/, { status: 429, headers: { 'retry-after': '120' } }]])
    const sources = store([[pdfDir(), pdfSource()]])
    const updates = createSkillUpdates(path.join(tmp, 'data', 'skill-updates.json'), { sources, fetchFn, now })
    expect(await updates.check()).toMatchObject({ rateLimited: true, until: clock + 120 * 1000 })

    const low = github([[/commits\?per_page=1$/, { body: [commit(H, 'Merge')], headers: { 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': String(Math.floor(clock / 1000) + 900) } }]])
    const updates2 = createSkillUpdates(path.join(tmp, 'data', 'other.json'), { sources, fetchFn: low, now })
    expect(await updates2.check()).toMatchObject({ rateLimited: true })
    expect(low.calls).toHaveLength(1) // the folder's commits were not asked
  })

  it('a repository gone or private: no update, noted as missing', async () => {
    const fetchFn = github([])
    const sources = store([[pdfDir(), pdfSource()]])
    const updates = createSkillUpdates(path.join(tmp, 'data', 'skill-updates.json'), { sources, fetchFn, now })
    expect(await updates.check()).toMatchObject({ ok: true })
    expect(updates.infoFor(sources.get(pdfDir()))).toMatchObject({ available: false, missing: true })
  })

  it('nothing from GitHub: no request at all', async () => {
    const fetchFn = github([])
    const sources = store([[pdfDir(), { kind: 'folder', path: '/x' }]])
    const updates = createSkillUpdates(path.join(tmp, 'data', 'skill-updates.json'), { sources, fetchFn, now })
    expect(await updates.check({ force: true })).toMatchObject({ ok: true, checked: true })
    expect(fetchFn.calls).toHaveLength(0)
  })

  it('before an update: what changed since the installed copy', async () => {
    const fetchFn = github(newCommitRoutes())
    const sources = store([[pdfDir(), pdfSource()]])
    const updates = createSkillUpdates(path.join(tmp, 'data', 'skill-updates.json'), { sources, fetchFn, now })
    const changes = await updates.changesFor(pdfDir())
    expect(changes.commits.map((c) => c.sha)).toEqual([sha('3'), sha('2')])
  })

  it('speaks French when GitHub cannot be reached', async () => {
    setLanguage('fr')
    const sources = store([[pdfDir(), pdfSource()]])
    const updates = createSkillUpdates(path.join(tmp, 'data', 'skill-updates.json'), {
      sources,
      fetchFn: async () => {
        throw new Error('ENOTFOUND')
      },
      now
    })
    expect((await updates.check()).error).toBe('Impossible de joindre GitHub : ENOTFOUND')
  })
})

// One test per problem found in review (each reproduced first).
describe('review fixes', () => {
  const skillDir = () => path.join(home, '.claude', 'skills', 'mine')
  const historyAt = (caps = {}, skillCaps = {}) =>
    createSkillHistory(path.join(tmp, 'data', 'skill-history'), { now, caps: { ...HISTORY_CAPS, ...caps }, skillCaps: { ...SKILL_CAPS, ...skillCaps } })
  const filesIn = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => String(f).replace(/\\/g, '/')).sort()

  it('1. a name that only changed case: restored into the same file, never deleted after', async () => {
    const dir = skillDir()
    write(path.join(dir, 'skill.md'), skillMd('mine', 'v1 body'))
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return // a file system that tells cases apart
    const history = historyAt()
    await history.track(dir)
    const v1 = history.list(dir).versions[0]
    fs.renameSync(path.join(dir, 'skill.md'), path.join(dir, 'tmpx'))
    fs.renameSync(path.join(dir, 'tmpx'), path.join(dir, 'SKILL.md'))
    write(path.join(dir, 'SKILL.md'), skillMd('mine', 'v2 body, longer'))
    clock += 1000
    expect(await history.restore(dir, v1.id, { home, env })).toMatchObject({ ok: true })
    expect(fs.readdirSync(dir)).toEqual(['skill.md'])
    expect(fs.readFileSync(path.join(dir, 'skill.md'), 'utf8')).toContain('v1 body')
    // The v2 content is in the history: back to it.
    const v2 = history.list(dir).versions[1]
    await history.restore(dir, v2.id, { home, env })
    expect(fs.readdirSync(dir)).toEqual(['SKILL.md'])
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('v2 body, longer')
  })

  it('2. node_modules is left out and untouched; past the file cap the SKILL.md is still read, and restore refuses', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine', 'Original.'))
    write(path.join(dir, 'scripts', 'run.js'), 'console.log(1)\n')
    const history = historyAt({}, { files: 10 })
    await history.track(dir)
    const v1 = history.list(dir).versions[0]
    for (let i = 0; i < 30; i++) write(path.join(dir, 'scripts', 'node_modules', `p${i % 3}`, `f${i}.js`), `module.exports=${i}\n`)
    write(path.join(dir, 'SKILL.md'), skillMd('mine', 'My edits since.'))
    clock += 1000
    expect(await history.track(dir)).toMatchObject({ truncated: false, complete: true, versions: 2 })
    await history.restore(dir, v1.id, { home, env })
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('Original.')
    expect(filesIn(path.join(dir, 'scripts', 'node_modules')).filter((f) => f.endsWith('.js'))).toHaveLength(30)

    // Too many files to read them all (not a skipped folder): the SKILL.md is
    // still read first, the snapshot is incomplete, and restore refuses.
    const other = path.join(home, '.claude', 'skills', 'other')
    write(path.join(other, 'SKILL.md'), skillMd('other', 'v1'))
    write(path.join(other, 'notes.md'), 'n1\n')
    const small = historyAt({}, { files: 5 })
    await small.track(other)
    const o1 = small.list(other).versions[0]
    for (let i = 0; i < 6; i++) write(path.join(other, 'assets', `a${i}.txt`), `asset ${i}\n`)
    write(path.join(other, 'SKILL.md'), skillMd('other', 'v2 my precious edits'))
    clock += 1000
    expect(await small.track(other)).toMatchObject({ saved: true, truncated: true, complete: false })
    expect((await readSkillTree(other, { ...SKILL_CAPS, files: 5 })).files.map((f) => f.rel)).toContain('SKILL.md')
    await expect(small.restore(other, o1.id, { home, env })).rejects.toMatchObject({ code: 'SKILL_HISTORY_INCOMPLETE' })
    expect(filesIn(path.join(other, 'assets'))).toHaveLength(6)
    expect(fs.readFileSync(path.join(other, 'SKILL.md'), 'utf8')).toContain('v2 my precious edits')
  })

  it('2/7. Update refuses to replace a copy that cannot be kept whole, unless it is exactly what was installed', async () => {
    const src = path.join(tmp, 'src', 'helper')
    write(path.join(src, 'SKILL.md'), skillMd('helper'))
    const sources = createSkillSources(path.join(tmp, 'data', 'skill-sources.json'))
    const history = createSkillHistory(path.join(tmp, 'data', 'skill-history'), { now, skillCaps: { ...SKILL_CAPS, files: 3 } })
    const pkg = await packageFromFolder(src)
    await installSkill({ id: pkg.id, agents: ['claude'], scope: 'user', home, env, sources, history })
    const dest = path.join(home, '.claude', 'skills', 'helper')
    for (let i = 0; i < 5; i++) write(path.join(dest, 'assets', `a${i}.txt`), `mine ${i}\n`)
    clock += 1000
    const again = await packageFromFolder(src)
    const res = await installSkill({ id: again.id, replace: dest, home, env, sources, history })
    expect(res.ok).toBe(false)
    expect(res.results[0].error).toMatch(/could not be kept whole/)
    expect(filesIn(path.join(dest, 'assets'))).toHaveLength(5) // untouched
  })

  it('3. never overwrites a file the history does not keep; small binaries are kept and come back', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine'))
    write(path.join(dir, 'ref.md'), 'small\n')
    write(path.join(dir, 'pic.bin'), Buffer.from([0, 1]))
    const history = historyAt({ fileCap: 200 })
    await history.track(dir)
    const v1 = history.list(dir).versions[0]
    write(path.join(dir, 'ref.md'), 'BIG '.repeat(100))
    write(path.join(dir, 'pic.bin'), Buffer.from([0, 1, 2]))
    clock += 1000
    await expect(history.restore(dir, v1.id, { home, env })).rejects.toMatchObject({ code: 'SKILL_HISTORY_NOT_KEPT' })
    expect(fs.readFileSync(path.join(dir, 'ref.md'), 'utf8')).toBe('BIG '.repeat(100))
    expect([...fs.readFileSync(path.join(dir, 'pic.bin'))]).toEqual([0, 1, 2])
    // Small again: the binary goes back and forth.
    write(path.join(dir, 'ref.md'), 'small again\n')
    clock += 1000
    await history.restore(dir, v1.id, { home, env })
    expect([...fs.readFileSync(path.join(dir, 'pic.bin'))]).toEqual([0, 1])
    const before = history.list(dir).versions[1]
    await history.restore(dir, before.id, { home, env })
    expect([...fs.readFileSync(path.join(dir, 'pic.bin'))]).toEqual([0, 1, 2])
  })

  it('4. a skill still there keeps its history, listed or not; only a gone one, long unseen, loses it', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine'))
    const root = path.join(tmp, 'data', 'skill-history')
    await createSkillHistory(root, { now }).track(dir)
    write(path.join(dir, 'SKILL.md'), skillMd('mine', 'edited'))
    clock += 1000
    await createSkillHistory(root, { now }).track(dir)
    clock += 200 * 24 * 3600 * 1000
    await createSkillHistory(root, { now }).annotate([]) // another project's list
    expect(createSkillHistory(root, { now }).list(dir).versions).toHaveLength(2)
    fs.rmSync(dir, { recursive: true })
    await createSkillHistory(root, { now }).annotate([])
    expect(createSkillHistory(root, { now }).list(dir).versions).toHaveLength(0)

    // Gone, but seen not long ago: kept.
    const other = path.join(home, '.claude', 'skills', 'other')
    write(path.join(other, 'SKILL.md'), skillMd('other'))
    await createSkillHistory(root, { now }).track(other)
    fs.rmSync(other, { recursive: true })
    clock += 10 * 24 * 3600 * 1000
    await createSkillHistory(root, { now }).annotate([])
    expect(createSkillHistory(root, { now }).list(other).versions).toHaveLength(1)
  })

  it('5. the size cap never drops the copy kept just before an Update', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine'))
    write(path.join(dir, 'ref.md'), 'A'.repeat(600))
    const history = historyAt({ bytes: 1000 })
    await history.track(dir, { note: { kind: 'install' } })
    write(path.join(dir, 'ref.md'), 'A'.repeat(590) + 'MY EDIT!!')
    clock += 1000
    await history.track(dir) // kept before the update
    write(path.join(dir, 'ref.md'), 'B'.repeat(600))
    clock += 1000
    await history.track(dir, { note: { kind: 'update' } })
    const versions = history.list(dir).versions
    expect(versions).toHaveLength(2)
    expect(versions[0].note).toMatchObject({ kind: 'update' })
    const edited = await history.diff(dir, versions[1].id)
    expect(edited.files.find((f) => f.path === 'ref.md')).toMatchObject({ notKept: false })
    await history.restore(dir, versions[1].id, { home, env })
    expect(fs.readFileSync(path.join(dir, 'ref.md'), 'utf8')).toContain('MY EDIT!!')
  })

  it('6. a damaged index falls back to its last good copy; one that cannot be read stops everything', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine', 'x'))
    const history = historyAt()
    await history.track(dir)
    write(path.join(dir, 'SKILL.md'), skillMd('mine', 'yy'))
    clock += 1000
    await history.track(dir)
    const idx = path.join(history.folderOf(dir), 'index.json')
    fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').slice(0, 10))
    write(path.join(dir, 'SKILL.md'), skillMd('mine', 'zzz'))
    clock += 1000
    expect((await history.track(dir)).versions).toBe(2) // from the backup copy, not from nothing
    expect(blobsOf(history, dir)).toHaveLength(3) // nothing deleted

    const other = path.join(home, '.claude', 'skills', 'other')
    write(path.join(other, 'SKILL.md'), skillMd('other', 'a'))
    await history.track(other)
    const blobs = blobsOf(history, other)
    const otherIdx = path.join(history.folderOf(other), 'index.json')
    fs.rmSync(otherIdx)
    fs.rmSync(`${otherIdx}.bak`, { force: true })
    fs.mkdirSync(otherIdx) // unreadable
    write(path.join(other, 'SKILL.md'), skillMd('other', 'bb'))
    clock += 1000
    await expect(history.track(other)).rejects.toMatchObject({ code: 'SKILL_HISTORY_UNREADABLE' })
    expect(() => history.list(other)).toThrow(/could not be read/)
    expect(blobsOf(history, other)).toEqual(blobs)
    const skills = [{ dir: other, name: 'other', managed: null, source: null }]
    await history.annotate(skills)
    expect(skills[0].history).toBe(null)
  })

  it('7. a failed snapshot stops the Update; the old copy goes without following a link, as does Delete', async () => {
    const src = path.join(tmp, 'src', 'helper')
    write(path.join(src, 'SKILL.md'), skillMd('helper'))
    const sources = createSkillSources(path.join(tmp, 'data', 'skill-sources.json'))
    const history = createSkillHistory(path.join(tmp, 'data', 'skill-history'), { now })
    const pkg = await packageFromFolder(src)
    await installSkill({ id: pkg.id, agents: ['claude'], scope: 'user', home, env, sources, history })
    const dest = path.join(home, '.claude', 'skills', 'helper')
    write(path.join(dest, 'mine.md'), 'my notes\n')
    const idx = path.join(history.folderOf(dest), 'index.json')
    fs.rmSync(idx)
    fs.rmSync(`${idx}.bak`, { force: true })
    fs.mkdirSync(idx)
    const res = await installSkill({ id: (await packageFromFolder(src)).id, replace: dest, home, env, sources, history })
    expect(res.ok).toBe(false)
    expect(res.results[0].error).toMatch(/could not be read/)
    expect(fs.readFileSync(path.join(dest, 'mine.md'), 'utf8')).toBe('my notes\n')
    fs.rmSync(idx, { recursive: true })

    const outside = path.join(tmp, 'outside')
    write(path.join(outside, 'keep.md'), 'keep\n')
    fs.symlinkSync(outside, path.join(dest, 'linked'), 'junction')
    clock += 1000
    const ok = await installSkill({ id: (await packageFromFolder(src)).id, replace: dest, home, env, sources, history })
    expect(ok.ok).toBe(true)
    expect(fs.existsSync(path.join(dest, 'linked'))).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'keep.md'), 'utf8')).toBe('keep\n')
    expect(fs.readdirSync(path.join(home, '.claude', 'skills')).filter((n) => n.includes('tessel'))).toEqual([]) // no copy left behind

    fs.symlinkSync(outside, path.join(dest, 'linked'), 'junction')
    await removeSkill({ dir: dest, mode: 'delete', home, env, sources })
    expect(fs.existsSync(dest)).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'keep.md'), 'utf8')).toBe('keep\n')
  })

  it('9. a file now a folder is restored whole; a link in the way refuses, creating nothing behind it', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine'))
    write(path.join(dir, 'notes'), 'notes as a file\n')
    write(path.join(dir, 'sub', 'deep', 'f.md'), 'f\n')
    const history = historyAt()
    await history.track(dir)
    const v1 = history.list(dir).versions[0]
    fs.rmSync(path.join(dir, 'notes'))
    write(path.join(dir, 'notes', 'a.md'), 'a\n')
    clock += 1000
    expect(await history.restore(dir, v1.id, { home, env })).toMatchObject({ ok: true })
    expect(fs.readFileSync(path.join(dir, 'notes'), 'utf8')).toBe('notes as a file\n')

    fs.rmSync(path.join(dir, 'sub'), { recursive: true })
    const outside = path.join(tmp, 'outside9')
    write(path.join(outside, 'keep.md'), 'keep\n')
    fs.symlinkSync(outside, path.join(dir, 'sub'), 'junction')
    write(path.join(dir, 'SKILL.md'), skillMd('mine', 'edited'))
    clock += 1000
    await expect(history.restore(dir, v1.id, { home, env })).rejects.toMatchObject({ code: 'SKILL_HISTORY_BLOCKED' })
    expect(filesIn(outside)).toEqual(['keep.md'])
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('edited') // nothing changed
  })

  it('10. restoring the oldest of a full history: kept while the current one is added', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine'))
    const history = historyAt({ versions: 3 })
    for (let i = 0; i < 3; i++) {
      write(path.join(dir, 'n.md'), `v${i}\n`)
      clock += 1000
      await history.track(dir)
    }
    const oldest = history.list(dir).versions[2]
    write(path.join(dir, 'n.md'), 'edited\n')
    clock += 1000
    expect(await history.restore(dir, oldest.id, { home, env })).toMatchObject({ ok: true })
    expect(fs.readFileSync(path.join(dir, 'n.md'), 'utf8')).toBe('v0\n')
  })

  it('12. taking the content as installed re-reads the record: an Update that finished meanwhile is kept', async () => {
    const dir = path.join(home, '.claude', 'skills', 'legacy')
    write(path.join(dir, 'SKILL.md'), skillMd('legacy'))
    const sources = createSkillSources(path.join(tmp, 'data', 'skill-sources.json'))
    sources.set(dir, { kind: 'github', owner: 'o', repo: 'r', path: 'legacy', commit: 'a'.repeat(40) })
    const history = createSkillHistory(path.join(tmp, 'data', 'skill-history'), { now })
    const { skills } = await listSkills({ home, env, sources: sources.all() })
    sources.set(dir, { kind: 'github', owner: 'o', repo: 'r', path: 'legacy', commit: 'b'.repeat(40), hash: 'f'.repeat(64) })
    await history.annotate(skills, { sources })
    expect(sources.get(dir)).toMatchObject({ commit: 'b'.repeat(40), hash: 'f'.repeat(64) })
    expect(sources.get(dir).hashAdopted).toBeUndefined()
    expect(skills[0].modified).toBe(true)
  })
})

describe('review fixes: update check', () => {
  const sha = (c) => c.repeat(40)
  const reply = ({ status = 200, body = null, headers = {} } = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body })
  const store = (entries, name = 'skill-sources.json') => {
    const sources = createSkillSources(path.join(tmp, 'data', name))
    for (const [dir, source] of entries) {
      fs.mkdirSync(dir, { recursive: true })
      sources.set(dir, source)
    }
    return sources
  }
  const at = (name) => path.join(home, '.claude', 'skills', name)
  const gh = (owner, over = {}) => ({ kind: 'github', owner, repo: 'r', ref: null, path: '', commit: sha('a'), ...over })

  it('8. a plain 403 is that repository\'s only; the others are checked, nothing is blocked; a failed check waits an hour', async () => {
    const calls = []
    const fetchFn = async (url) => {
      calls.push(url)
      if (url.includes('/blocked/')) return reply({ status: 403, body: { message: 'Repository access blocked' } })
      return reply({ body: [{ sha: sha('a'), commit: { message: 'x' } }], headers: { 'x-ratelimit-remaining': '50' } })
    }
    const sources = store([[at('a'), gh('blocked')], [at('b'), gh('good')]])
    const updates = createSkillUpdates(path.join(tmp, 'data', 'u.json'), { sources, fetchFn, now })
    const res = await updates.check()
    expect(res).toMatchObject({ ok: false, checked: true, error: 'GitHub answered 403.' })
    expect(res.rateLimited).toBeUndefined()
    expect(calls.some((u) => u.includes('/good/'))).toBe(true)
    expect(updates.status().until).toBe(null)
    expect(updates.infoFor(sources.get(at('b')))).toMatchObject({ available: false })

    // Offline: the next check on its own waits an hour; asked, after a minute.
    const off = createSkillUpdates(path.join(tmp, 'data', 'off.json'), {
      sources,
      fetchFn: async () => {
        calls.push('offline')
        throw new Error('ENOTFOUND')
      },
      now
    })
    const before = calls.length
    expect(await off.check()).toMatchObject({ ok: false, checked: true })
    expect(calls.length).toBe(before + 2)
    clock += 10 * 60 * 1000
    expect(await off.check()).toMatchObject({ checked: false })
    expect(calls.length).toBe(before + 2)
    expect(await off.check({ force: true })).toMatchObject({ checked: true })
    clock += 61 * 60 * 1000
    expect(await off.check()).toMatchObject({ checked: true })
  })

  it('11. the Update preview asks only that skill\'s repository; a stalled answer times out without blocking later checks', async () => {
    const calls = []
    const fetchFn = async (url) => {
      calls.push(url)
      return reply({ body: [{ sha: sha('a'), commit: { message: 'x' } }] })
    }
    const sources = store([[at('a'), gh('one')], [at('b'), gh('two')]])
    const updates = createSkillUpdates(path.join(tmp, 'data', 'u.json'), { sources, fetchFn, now })
    await updates.changesFor(at('a'))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/repos/one/r/')

    let stalls = 1
    const stalled = createSkillUpdates(path.join(tmp, 'data', 's.json'), {
      sources: store([[at('c'), gh('slow')]], 'slow-sources.json'),
      fetchFn: async () => ({ ok: true, status: 200, headers: new Headers(), json: () => (stalls-- > 0 ? new Promise(() => {}) : Promise.resolve([{ sha: sha('a') }])) }),
      now,
      opts: { ...UPDATE_CHECK, timeout: 50 }
    })
    const started = Date.now()
    expect(await stalled.check()).toMatchObject({ ok: false, error: 'GitHub did not answer in time.' })
    expect(Date.now() - started).toBeLessThan(5000)
    clock += 2 * 60 * 1000
    expect(await stalled.check({ force: true })).toMatchObject({ ok: true, checked: true })
  })

  it('13. records of skills whose folder is gone are dropped and never asked about; a missing drive is not "gone"', async () => {
    const calls = []
    const fetchFn = async (url) => {
      calls.push(url)
      return reply({ body: [{ sha: sha('a'), commit: { message: 'x' } }] })
    }
    const sources = store([[at('kept'), gh('kept')], [at('gone'), gh('gone')]])
    fs.rmSync(at('gone'), { recursive: true })
    const updates = createSkillUpdates(path.join(tmp, 'data', 'u.json'), { sources, fetchFn, now })
    await updates.check()
    expect(calls.some((u) => u.includes('/gone/'))).toBe(false)
    expect(sources.get(at('gone'))).toBe(null)
    expect(sources.get(at('kept'))).not.toBe(null)
    if (process.platform === 'win32') {
      const letter = 'ZYXWVUTSRQPONM'.split('').find((l) => !fs.existsSync(`${l}:\\`))
      if (letter) {
        sources.set(`${letter}:\\skills\\away`, gh('away'))
        expect(dropStaleSources(sources)).toBe(0)
        expect(sources.get(`${letter}:\\skills\\away`)).not.toBe(null)
      }
    }
  })
})

// The second review (each reproduced first).
describe('second review fixes', () => {
  const skillDir = () => path.join(home, '.claude', 'skills', 'mine')
  const historyAt = (caps = {}, skillCaps = {}) =>
    createSkillHistory(path.join(tmp, 'data', 'skill-history'), { now, caps: { ...HISTORY_CAPS, ...caps }, skillCaps: { ...SKILL_CAPS, ...skillCaps } })
  const filesIn = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => String(f).replace(/\\/g, '/')).sort()
  // A Recycle Bin: the folder moved into tmp/bin.
  const binOf = () => {
    const bin = path.join(tmp, 'bin')
    const moved = []
    const trash = async (p) => {
      fs.mkdirSync(bin, { recursive: true })
      const to = path.join(bin, `${moved.length}-${path.basename(p)}`)
      fs.renameSync(p, to)
      moved.push({ from: p, to })
    }
    return { trash, moved }
  }
  async function installed(name, files = {}) {
    const src = path.join(tmp, 'src', name)
    write(path.join(src, 'SKILL.md'), skillMd(name))
    for (const [rel, text] of Object.entries(files)) write(path.join(src, rel), text)
    const sources = createSkillSources(path.join(tmp, 'data', 'skill-sources.json'))
    const history = createSkillHistory(path.join(tmp, 'data', 'skill-history'), { now })
    const pkg = await packageFromFolder(src)
    await installSkill({ id: pkg.id, agents: ['claude'], scope: 'user', home, env, sources, history })
    const again = async () => (await packageFromFolder(src)).id
    return { sources, history, dest: path.join(home, '.claude', 'skills', name), again }
  }

  it('N1. a name\'s case is changed in one step, tried again while locked, and the SKILL.md never goes missing', async () => {
    const dir = skillDir()
    write(path.join(dir, 'skill.md'), skillMd('mine', 'v1 body'))
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return // a file system that tells cases apart
    const history = historyAt()
    await history.track(dir)
    const v1 = history.list(dir).versions[0]
    fs.renameSync(path.join(dir, 'skill.md'), path.join(dir, 'tmpx'))
    fs.renameSync(path.join(dir, 'tmpx'), path.join(dir, 'SKILL.md'))
    write(path.join(dir, 'SKILL.md'), skillMd('mine', 'v2 body, longer'))
    clock += 1000
    const realRename = fsp.rename
    const tried = []
    fsp.rename = async (a, b) => {
      if (path.basename(String(b)) === 'skill.md' || String(b).includes('.tessel-case-')) {
        tried.push(String(b))
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
      return realRename(a, b)
    }
    let res
    try {
      res = await history.restore(dir, v1.id, { home, env })
    } finally {
      fsp.rename = realRename
    }
    expect(res.ok).toBe(true)
    expect(tried.length).toBeGreaterThan(1) // tried again
    expect(tried.some((t) => t.includes('.tessel-case-'))).toBe(false) // never through a temporary name
    expect(fs.readdirSync(dir)).toEqual(['SKILL.md'])
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('v1 body')
    expect((await listSkills({ home, env })).skills).toHaveLength(1)
  })

  it('N2. Replace onto a leftover folder without SKILL.md goes ahead, the folder to the Recycle Bin; a Bin that refuses changes nothing', async () => {
    const { sources, history, again } = await installed('helper')
    const leftover = path.join(home, '.claude', 'skills', 'leftover')
    write(path.join(leftover, 'notes.txt'), 'leftover\n')
    const { trash, moved } = binOf()
    const res = await installSkill({ id: await again(), replace: leftover, home, env, sources, history, trash })
    expect(res.results[0]).toMatchObject({ ok: true, trashed: true })
    expect(moved.map((m) => m.from)).toEqual([leftover])
    expect(filesIn(moved[0].to)).toEqual(['notes.txt'])
    expect(fs.existsSync(path.join(leftover, 'SKILL.md'))).toBe(true)

    const other = path.join(home, '.claude', 'skills', 'other')
    write(path.join(other, 'notes.txt'), 'mine\n')
    const refused = await installSkill({
      id: await again(),
      replace: other,
      home,
      env,
      sources,
      history,
      trash: async () => {
        throw new Error('in use')
      }
    })
    expect(refused.ok).toBe(false)
    expect(refused.results[0].error).toMatch(/could not be moved to the Recycle Bin \(in use\), so it was not replaced/)
    expect(filesIn(other)).toEqual(['notes.txt'])
    expect(fs.readdirSync(path.join(home, '.claude', 'skills')).filter((n) => n.includes('tessel'))).toEqual([])
  })

  it('N3. Update moves the old copy to the Recycle Bin whole: its .git and node_modules are never deleted for good', async () => {
    const { sources, history, dest, again } = await installed('tool')
    write(path.join(dest, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    write(path.join(dest, 'node_modules', 'x', 'i.js'), 'x\n')
    write(path.join(dest, 'SKILL.md'), skillMd('tool', 'edited'))
    clock += 1000
    const { trash, moved } = binOf()
    const res = await installSkill({ id: await again(), replace: dest, home, env, sources, history, trash })
    expect(res.results[0]).toMatchObject({ ok: true, trashed: true })
    expect(filesIn(moved[0].to)).toEqual(['.git', '.git/HEAD', 'SKILL.md', 'node_modules', 'node_modules/x', 'node_modules/x/i.js'])
    expect(filesIn(dest)).toEqual(['SKILL.md'])
    // The edited SKILL.md is in the history too.
    expect(history.list(dest).versions.some((v) => v.files.includes('SKILL.md') && !v.first && v.note === null)).toBe(true)
  })

  it('N4. the walk stops at the caps, SKILL.md first; tool folders (dist, build, caches, a Python environment) are left out', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine'))
    for (let i = 0; i < 10; i++) write(path.join(dir, `0${i}.md`), `${i}\n`)
    const top = await readSkillTree(dir, { ...SKILL_CAPS, files: 3 })
    expect(top.files.map((f) => f.rel)).toContain('SKILL.md')
    expect(top.truncated).toBe(true)

    for (let i = 0; i < 60; i++) write(path.join(dir, 'assets', `a${i}.txt`), `${i}\n`)
    const realStat = fsp.stat
    let stats = 0
    fsp.stat = async (...args) => {
      stats++
      return realStat(...args)
    }
    try {
      await readSkillTree(dir, { ...SKILL_CAPS, files: 5 })
    } finally {
      fsp.stat = realStat
    }
    expect(stats).toBeLessThanOrEqual(5)
    for (let i = 0; i < 20; i++) fs.mkdirSync(path.join(dir, 'deep', `d${i}`), { recursive: true })
    expect((await readSkillTree(dir, { ...SKILL_CAPS, dirs: 5 })).truncated).toBe(true)

    const tool = path.join(home, '.claude', 'skills', 'tool')
    write(path.join(tool, 'SKILL.md'), skillMd('tool'))
    write(path.join(tool, 'run.py'), 'print(1)\n')
    for (const sub of ['dist', 'build', '.cache', 'coverage', 'target']) for (let i = 0; i < 5; i++) write(path.join(tool, sub, `f${i}`), 'x\n')
    write(path.join(tool, 'myenv', 'pyvenv.cfg'), 'home = /usr\n')
    for (let i = 0; i < 5; i++) write(path.join(tool, 'myenv', 'lib', `m${i}.py`), 'x\n')
    const tree = await readSkillTree(tool, { ...SKILL_CAPS, files: 3 })
    expect(tree).toMatchObject({ truncated: false })
    expect(tree.files.map((f) => f.rel)).toEqual(['SKILL.md', 'run.py'])
    // The installed content's hash leaves them out the same way.
    const md = { rel: 'SKILL.md', data: Buffer.from('x') }
    expect(contentHash([md, { rel: 'myenv/pyvenv.cfg', data: Buffer.from('h') }, { rel: 'myenv/lib/m.py', data: Buffer.from('m') }, { rel: 'dist/a.js', data: Buffer.from('a') }])).toBe(contentHash([md]))
  })

  it('N4. a quiet list reuses the last walk for a minute; opening, an edit to SKILL.md or the minute passing walks again', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine'))
    write(path.join(dir, 'docs', 'a.md'), 'a\n')
    const history = historyAt()
    const skills = () => [{ dir, name: 'mine', managed: null, source: null }]
    await history.annotate(skills())
    const realStat = fsp.stat
    let stats = 0
    fsp.stat = async (...args) => {
      stats++
      return realStat(...args)
    }
    try {
      await history.annotate(skills(), { cached: true })
      expect(stats).toBeLessThanOrEqual(2) // the folder and its SKILL.md
    } finally {
      fsp.stat = realStat
    }
    write(path.join(dir, 'docs', 'a.md'), 'a, edited\n')
    clock += 1000
    let list = skills()
    await history.annotate(list, { cached: true })
    expect(list[0].history.versions).toBe(1) // within the minute: the last walk
    list = skills()
    await history.annotate(list)
    expect(list[0].history.versions).toBe(2) // opening the list: walked again
    write(path.join(dir, 'SKILL.md'), skillMd('mine', 'edited too, longer'))
    list = skills()
    await history.annotate(list, { cached: true })
    expect(list[0].history.versions).toBe(3) // SKILL.md changed: walked again
    write(path.join(dir, 'docs', 'a.md'), 'a, edited again\n')
    clock += 61 * 1000
    list = skills()
    await history.annotate(list, { cached: true })
    expect(list[0].history.versions).toBe(4) // a minute later
  })

  it('N4. a skill with too many files is flagged as partly kept', async () => {
    const dir = skillDir()
    write(path.join(dir, 'SKILL.md'), skillMd('mine'))
    for (let i = 0; i < 6; i++) write(path.join(dir, 'assets', `a${i}.txt`), `${i}\n`)
    const history = historyAt({}, { files: 3 })
    const skills = [{ dir, name: 'mine', managed: null, source: null }]
    await history.annotate(skills)
    expect(skills[0].history).toMatchObject({ partial: true, versions: 1 })
  })

  it('N5. a record is never taken for stale while its folder is being updated', async () => {
    const { sources, history, dest, again } = await installed('helper')
    let during
    const trash = async (p) => {
      fs.renameSync(p, path.join(tmp, 'bin-n5'))
      dropStaleSources(sources) // a list at that moment
      during = sources.get(dest)
    }
    const res = await installSkill({ id: await again(), replace: dest, home, env, sources, history, trash })
    expect(during).not.toBe(null)
    expect(res.ok).toBe(true)
    fs.rmSync(dest, { recursive: true })
    expect(dropStaleSources(sources)).toBe(1) // once done, a folder really gone is dropped
  })
})
