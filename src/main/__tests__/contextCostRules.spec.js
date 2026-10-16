// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import { join, sep } from 'path'
import { rulesCandidates, readRules, createFileReader, claudeImports, splitTesselBlock, claudeProjectSlug, foldersUp } from '../contextCost/rulesFiles'
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
    write(join(claudeDir, 'CLAUDE.md'), `Be brief.\n@~/shared/team.md\n\`@not/an/import.md\`\n${RULE_START}\nBoard rule.\n${RULE_END}\n`)
    write(join(home, 'shared', 'team.md'), 'Team conventions.')
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

  it('finds "@path" imports outside code only', () => {
    const file = join(home, 'CLAUDE.md')
    expect(claudeImports('See @docs/a.md and @~/b.md, ask @someone.\n```\n@c.md\n```', file, home)).toEqual([join(home, 'docs', 'a.md'), join(home, 'b.md')])
    expect(splitTesselBlock('only mine')).toEqual({ own: 'only mine', tessel: '' })
    expect(splitTesselBlock(`${RULE_START}\nx\n${RULE_END}`).own).toBe('')
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
})
