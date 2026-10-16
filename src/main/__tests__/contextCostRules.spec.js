// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import { join, sep } from 'path'
import { rulesCandidates, readRules, createFileReader, claudeImports, splitTesselBlock, claudeProjectSlug, foldersUp, importProblem, isSensitivePath, readBudget } from '../contextCost/rulesFiles'
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
