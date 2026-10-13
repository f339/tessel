import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import {
  skillRoots,
  targetRoots,
  listSkills,
  packageFromFolder,
  packageFromGithub,
  packageForUpdate,
  parseGithubSpec,
  installSkill,
  removeSkill,
  createSkillSources,
  findSetupCommands,
  safeRelPath,
  isSafeSkillName,
  SKILL_CAPS
} from '../skillsManager'
import { readTar } from '../skillsTar'
import { setLanguage } from '../i18n'

// A tar archive like git archive's: a pax global header with the commit, a
// top folder, then the entries. kind: file (default) | dir | symlink.
function tarGz(entries, { commit = 'a'.repeat(40), top = 'repo-main' } = {}) {
  const blocks = []
  const header = (name, type, size, linkname = '') => {
    const h = Buffer.alloc(512)
    h.write(name, 0, 100, 'utf8')
    h.write('0000644\0', 100)
    h.write('0000000\0', 108)
    h.write('0000000\0', 116)
    h.write(size.toString(8).padStart(11, '0') + '\0', 124)
    h.write('00000000000\0', 136)
    h.write(type, 156)
    h.write(linkname, 157, 100, 'utf8')
    h.write('ustar\0', 257)
    h.write('00', 263)
    h.fill(32, 148, 156)
    let sum = 0
    for (const b of h) sum += b
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    return h
  }
  const push = (name, type, data = Buffer.alloc(0), linkname = '') => {
    blocks.push(header(name, type, data.length, linkname))
    if (data.length) {
      blocks.push(data)
      const pad = (512 - (data.length % 512)) % 512
      if (pad) blocks.push(Buffer.alloc(pad))
    }
  }
  const record = `comment=${commit}\n`
  const paxData = Buffer.from(`${record.length + 3} ${record}`)
  push('pax_global_header', 'g', paxData)
  push(`${top}/`, '5')
  for (const e of entries) {
    if (e.kind === 'dir') push(`${top}/${e.path}/`, '5')
    else if (e.kind === 'symlink') push(`${top}/${e.path}`, '2', Buffer.alloc(0), e.target)
    else push(e.raw ? e.path : `${top}/${e.path}`, '0', Buffer.from(e.text || ''))
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

function fakeFetch(gz, { url = 'https://codeload.github.com/o/r/tar.gz/HEAD', status = 200 } = {}) {
  const calls = []
  const fn = async (u) => {
    calls.push(u)
    return {
      ok: status >= 200 && status < 300,
      status,
      url,
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.length)
    }
  }
  fn.calls = calls
  return fn
}

const skillMd = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo things.\n`

let tmp, home, cwd, env
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-skills-'))
  home = path.join(tmp, 'home')
  cwd = path.join(tmp, 'project')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  env = {}
})
afterEach(() => {
  setLanguage('en')
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('skill folders per agent and scope', () => {
  it('lists user and project folders with the agents that read them', () => {
    const roots = skillRoots({ home, env: { CODEX_HOME: path.join(tmp, 'codexhome') }, cwd })
    const at = (p) => roots.find((r) => r.path === path.resolve(p))
    expect(at(path.join(home, '.claude', 'skills'))).toMatchObject({ scope: 'user', installFor: ['claude'] })
    expect(at(path.join(home, '.claude', 'skills')).seenBy).toContain('claude')
    expect(at(path.join(tmp, 'codexhome', 'skills'))).toMatchObject({ scope: 'user', seenBy: ['codex'] })
    expect(at(path.join(home, '.agents', 'skills')).seenBy).toContain('codex')
    expect(at(path.join(cwd, '.agents', 'skills'))).toMatchObject({ scope: 'project' })
    expect(at(path.join(cwd, '.codex', 'skills'))).toMatchObject({ scope: 'project', seenBy: ['codex'] })
    expect(at(path.join(cwd, '.github', 'skills')).seenBy).toEqual(['copilot'])
  })

  it('without a project, only the user folders', () => {
    expect(skillRoots({ home, env }).every((r) => r.scope === 'user')).toBe(true)
  })

  it('picks one folder per agent for the chosen scope', () => {
    const user = targetRoots(['claude', 'codex'], 'user', { home, env, cwd }).map((r) => r.path)
    expect(user).toEqual([path.join(home, '.claude', 'skills'), path.join(home, '.agents', 'skills')])
    const project = targetRoots(['claude', 'codex', 'copilot', 'opencode', 'gemini'], 'project', { home, env, cwd }).map((r) => r.path)
    expect(project).toEqual([
      path.join(cwd, '.claude', 'skills'),
      path.join(cwd, '.agents', 'skills'),
      path.join(cwd, '.github', 'skills'),
      path.join(cwd, '.opencode', 'skills'),
      path.join(cwd, '.gemini', 'skills')
    ])
    expect(targetRoots(['nope'], 'user', { home, env })).toEqual([])
  })
})

describe('listing', () => {
  it('reads the name and description from the SKILL.md frontmatter', async () => {
    write(path.join(home, '.claude', 'skills', 'pdf', 'SKILL.md'), skillMd('pdf', 'Fill PDF forms.'))
    write(
      path.join(home, '.claude', 'skills', 'folded', 'SKILL.md'),
      '---\nname: folded-skill\ndescription: >-\n  Long text\n  on two lines.\n---\n'
    )
    write(path.join(home, '.claude', 'skills', 'plain', 'SKILL.md'), '# No frontmatter\n')
    write(path.join(home, '.claude', 'skills', 'synced', 'acct', 'docx', 'SKILL.md'), skillMd('docx', 'Word.'))
    write(path.join(tmp, 'ch', 'skills', '.system', 'imagegen', 'SKILL.md'), skillMd('imagegen', 'Images.'))
    write(path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md'), skillMd('review', 'Review code.'))
    write(path.join(home, '.claude', 'skills', 'notes.txt'), 'not a skill')
    const { skills, roots } = await listSkills({ home, env: { CODEX_HOME: path.join(tmp, 'ch') }, cwd })
    const by = (name) => skills.find((s) => s.name === name)
    expect(by('pdf')).toMatchObject({ description: 'Fill PDF forms.', scope: 'user', removable: true, managed: null, folder: 'pdf' })
    expect(by('pdf').seenBy).toContain('claude')
    expect(by('folded-skill')).toMatchObject({ description: 'Long text on two lines.', folder: 'folded' })
    expect(by('plain')).toMatchObject({ description: null })
    expect(by('docx')).toMatchObject({ managed: 'synced', removable: false })
    expect(by('imagegen')).toMatchObject({ managed: 'system', removable: false, seenBy: ['codex'] })
    expect(by('review')).toMatchObject({ scope: 'project', removable: true })
    expect(by('review').seenBy).toContain('codex')
    expect(roots.find((r) => r.path === path.join(home, '.claude', 'skills')).exists).toBe(true)
    expect(roots.find((r) => r.path === path.join(home, '.gemini', 'skills')).exists).toBe(false)
  })

  it('shows where a skill was added from', async () => {
    write(path.join(home, '.claude', 'skills', 'pdf', 'SKILL.md'), skillMd('pdf', 'x'))
    const sources = createSkillSources(path.join(tmp, 'data', 'skill-sources.json'))
    sources.set(path.join(home, '.claude', 'skills', 'pdf'), { kind: 'github', owner: 'o', repo: 'r', path: 'skills/pdf' })
    const again = createSkillSources(path.join(tmp, 'data', 'skill-sources.json'))
    const { skills } = await listSkills({ home, env, sources: again.all() })
    expect(skills[0].source).toMatchObject({ kind: 'github', repo: 'r' })
  })
})

describe('install from a folder', () => {
  it('shows the skill, then copies it to each chosen agent', async () => {
    const src = path.join(tmp, 'src', 'my-skill')
    write(path.join(src, 'SKILL.md'), skillMd('my-skill', 'Does it.') + '\nRun `npx my-skill-pkg setup` once.\n')
    write(path.join(src, 'scripts', 'run.py'), 'print(1)')
    write(path.join(src, '.git', 'HEAD'), 'ref')
    const pkg = await packageFromFolder(src)
    expect(pkg).toMatchObject({ name: 'my-skill', description: 'Does it.', scripts: ['scripts/run.py'], setup: ['npx my-skill-pkg setup'] })
    expect(pkg.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'scripts/run.py'])
    expect(pkg.skillMd).toContain('Does it.')

    const res = await installSkill({ id: pkg.id, agents: ['claude', 'codex'], scope: 'user', home, env })
    expect(res.ok).toBe(true)
    for (const dir of [path.join(home, '.claude', 'skills', 'my-skill'), path.join(home, '.agents', 'skills', 'my-skill')]) {
      expect(fs.readFileSync(path.join(dir, 'scripts', 'run.py'), 'utf8')).toBe('print(1)')
      expect(fs.existsSync(path.join(dir, '.git'))).toBe(false)
    }
    // Already there: kept, not overwritten.
    const again = await installSkill({ id: pkg.id, agents: ['claude'], scope: 'user', home, env })
    expect(again.ok).toBe(false)
    expect(again.results[0].exists).toBe(true)
  })

  it('installs into the project folders', async () => {
    const src = path.join(tmp, 'src', 'p')
    write(path.join(src, 'SKILL.md'), skillMd('p', 'x'))
    const pkg = await packageFromFolder(src)
    const res = await installSkill({ id: pkg.id, agents: ['claude', 'codex', 'copilot'], scope: 'project', cwd, home, env })
    expect(res.ok).toBe(true)
    expect(fs.existsSync(path.join(cwd, '.claude', 'skills', 'p', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(cwd, '.agents', 'skills', 'p', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(cwd, '.github', 'skills', 'p', 'SKILL.md'))).toBe(true)
    await expect(installSkill({ id: pkg.id, agents: ['claude'], scope: 'project', cwd: null, home, env })).rejects.toThrow(/project/)
  })

  it('refuses a folder without SKILL.md, with a link, or too large', async () => {
    const empty = path.join(tmp, 'src', 'empty')
    write(path.join(empty, 'README.md'), 'x')
    await expect(packageFromFolder(empty)).rejects.toThrow(/SKILL\.md/)

    const linked = path.join(tmp, 'src', 'linked')
    write(path.join(linked, 'SKILL.md'), skillMd('linked', 'x'))
    fs.mkdirSync(path.join(tmp, 'elsewhere'))
    fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(linked, 'out'), 'junction')
    await expect(packageFromFolder(linked)).rejects.toMatchObject({ code: 'SKILL_LINK' })

    const big = path.join(tmp, 'src', 'big')
    write(path.join(big, 'SKILL.md'), skillMd('big', 'x'))
    write(path.join(big, 'data.bin'), 'x'.repeat(2000))
    await expect(packageFromFolder(big, { ...SKILL_CAPS, bytes: 1000 })).rejects.toMatchObject({ code: 'SKILL_TOO_BIG' })
  })
})

describe('install from GitHub', () => {
  it('parses repository addresses', () => {
    expect(parseGithubSpec('anthropics/skills')).toEqual({ owner: 'anthropics', repo: 'skills', ref: null, path: '' })
    expect(parseGithubSpec('anthropics/skills/skills/pdf')).toMatchObject({ path: 'skills/pdf' })
    expect(parseGithubSpec('o/r@v1.2')).toMatchObject({ ref: 'v1.2', path: '' })
    expect(parseGithubSpec('https://github.com/o/r.git')).toMatchObject({ owner: 'o', repo: 'r' })
    expect(parseGithubSpec('https://github.com/o/r/tree/main/skills/pdf')).toEqual({ owner: 'o', repo: 'r', ref: 'main', path: 'skills/pdf' })
    expect(parseGithubSpec('https://github.com/o/r/blob/main/skills/pdf/SKILL.md')).toMatchObject({ path: 'skills/pdf' })
    expect(parseGithubSpec('o/r/../x')).toBeNull()
    expect(parseGithubSpec('https://evil.com/o/r')).toBeNull()
    expect(parseGithubSpec('file:///c/x')).toBeNull()
    expect(parseGithubSpec('o')).toBeNull()
  })

  it('downloads the tarball, offers the skills in it, keeps only the chosen folder', async () => {
    const gz = tarGz([
      { path: 'README.md', text: 'repo readme' },
      { path: 'skills', kind: 'dir' },
      { path: 'skills/pdf/SKILL.md', text: skillMd('pdf', 'PDF things.') },
      { path: 'skills/pdf/forms/fill.py', text: 'print(2)' },
      { path: 'skills/docx/SKILL.md', text: skillMd('docx', 'Word things.') },
      { path: 'link-elsewhere', kind: 'symlink', target: '/etc/passwd' }
    ])
    const fetchFn = fakeFetch(gz)
    const list = await packageFromGithub('o/r', { fetchFn })
    expect(fetchFn.calls[0]).toBe('https://github.com/o/r/archive/HEAD.tar.gz')
    expect(list.candidates.map((c) => c.name).sort()).toEqual(['docx', 'pdf'])
    const pkg = await packageFromGithub('o/r', { fetchFn, pick: 'skills/pdf' })
    expect(fetchFn.calls).toHaveLength(1) // the archive is kept while choosing
    expect(pkg.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'forms/fill.py'])
    expect(pkg.source).toMatchObject({ kind: 'github', owner: 'o', repo: 'r', path: 'skills/pdf', commit: 'a'.repeat(40) })

    const sources = createSkillSources(path.join(tmp, 'sources.json'))
    const res = await installSkill({ id: pkg.id, agents: ['codex'], scope: 'user', home, env, sources })
    expect(res.ok).toBe(true)
    const dest = path.join(home, '.agents', 'skills', 'pdf')
    expect(fs.readFileSync(path.join(dest, 'forms', 'fill.py'), 'utf8')).toBe('print(2)')
    expect(sources.get(dest)).toMatchObject({ kind: 'github', repo: 'r', path: 'skills/pdf' })
  })

  it('uses the path given, and updates a skill in place', async () => {
    const v1 = tarGz([{ path: 'skills/pdf/SKILL.md', text: skillMd('pdf', 'v1') }, { path: 'skills/pdf/old.txt', text: 'old' }], { top: 'r-1' })
    const pkg = await packageFromGithub('https://github.com/o2/r/tree/main/skills/pdf', { fetchFn: fakeFetch(v1) })
    expect(pkg.description).toBe('v1')
    await installSkill({ id: pkg.id, agents: ['claude'], scope: 'user', home, env })
    const dest = path.join(home, '.claude', 'skills', 'pdf')
    const v2 = tarGz([{ path: 'skills/pdf/SKILL.md', text: skillMd('pdf', 'v2') }], { top: 'r-2' })
    const next = await packageFromGithub({ owner: 'o2', repo: 'r', ref: 'v2', path: 'skills/pdf' }, { fetchFn: fakeFetch(v2) })
    const res = await installSkill({ id: next.id, replace: dest, home, env })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toContain('v2')
    expect(fs.existsSync(path.join(dest, 'old.txt'))).toBe(false)
    expect(fs.readdirSync(path.dirname(dest))).toEqual(['pdf'])
    // Only a skill folder Tessel knows can be replaced.
    await expect(installSkill({ id: next.id, replace: path.join(tmp, 'x', 'pdf'), home, env })).rejects.toThrow(/Tessel/)
  })

  it('Update downloads again from the recorded source', async () => {
    const sources = createSkillSources(path.join(tmp, 'sources.json'))
    const dest = path.join(home, '.claude', 'skills', 'pdf')
    await expect(packageForUpdate(dest, sources, {})).rejects.toThrow(/GitHub/)
    sources.set(dest, { kind: 'github', owner: 'up', repo: 'r', ref: null, path: 'skills/pdf' })
    const gz = tarGz([{ path: 'skills/pdf/SKILL.md', text: skillMd('pdf', 'newer') }, { path: 'skills/other/SKILL.md', text: skillMd('other', 'x') }], { top: 'up' })
    const fetchFn = fakeFetch(gz)
    const pkg = await packageForUpdate(dest, sources, { fetchFn })
    expect(pkg).toMatchObject({ name: 'pdf', description: 'newer' })
    await packageForUpdate(dest, sources, { fetchFn })
    expect(fetchFn.calls).toHaveLength(2) // never the kept archive
  })

  it('refuses a path that escapes the skill folder', async () => {
    for (const [i, bad] of ['skills/pdf/../../evil.txt', 'skills/pdf/a/../../../x', 'skills/pdf/C:evil', 'skills/pdf/con.txt'].entries()) {
      const gz = tarGz([{ path: 'skills/pdf/SKILL.md', text: skillMd('pdf', 'x') }, { path: bad, text: 'evil' }], { top: 'esc-' + bad.length })
      await expect(packageFromGithub(`esc${i}/r/skills/pdf`, { fetchFn: fakeFetch(gz) })).rejects.toMatchObject({ code: 'SKILL_PATH' })
    }
    expect(fs.existsSync(path.join(tmp, 'evil.txt'))).toBe(false)
  })

  it('refuses a link inside the skill', async () => {
    const gz = tarGz([
      { path: 'SKILL.md', text: skillMd('linky', 'x') },
      { path: 'secrets', kind: 'symlink', target: '../../.ssh/id_rsa' }
    ], { top: 'lnk' })
    await expect(packageFromGithub('lnk/r', { fetchFn: fakeFetch(gz) })).rejects.toMatchObject({ code: 'SKILL_LINK' })
  })

  it('caps the size and checks where the download came from', async () => {
    const gz = tarGz([{ path: 'SKILL.md', text: skillMd('big', 'x') }, { path: 'big.bin', text: 'x'.repeat(5000) }], { top: 'big' })
    await expect(packageFromGithub('big/r', { fetchFn: fakeFetch(gz), caps: { ...SKILL_CAPS, bytes: 1000 } })).rejects.toMatchObject({ code: 'SKILL_TOO_BIG' })
    await expect(packageFromGithub('big2/r', { fetchFn: fakeFetch(gz), caps: { ...SKILL_CAPS, download: 10 } })).rejects.toMatchObject({ code: 'SKILL_TOO_BIG' })
    await expect(packageFromGithub('big3/r', { fetchFn: fakeFetch(gz, { url: 'https://evil.example/x.tgz' }) })).rejects.toThrow(/somewhere else/)
    await expect(packageFromGithub('big4/r', { fetchFn: fakeFetch(gz, { status: 404 }) })).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' })
  })

  it('reads the tar fixture as tar', () => {
    const gz = tarGz([{ path: 'a.txt', text: 'hi' }])
    const { entries, comment } = readTar(zlib.gunzipSync(gz))
    expect(comment).toBe('a'.repeat(40))
    expect(entries.map((e) => [e.path, e.kind])).toEqual([['repo-main/', 'dir'], ['repo-main/a.txt', 'file']])
  })
})

describe('remove', () => {
  it('to the Recycle Bin, or deleted, only for a skill folder Tessel knows', async () => {
    const a = path.join(home, '.claude', 'skills', 'a')
    const b = path.join(cwd, '.agents', 'skills', 'b')
    write(path.join(a, 'SKILL.md'), skillMd('a', 'x'))
    write(path.join(b, 'SKILL.md'), skillMd('b', 'x'))
    const trashed = []
    const sources = createSkillSources(path.join(tmp, 'sources.json'))
    sources.set(a, { kind: 'github' })
    await removeSkill({ dir: a, mode: 'trash', home, env, trash: async (p) => trashed.push(p), sources })
    expect(trashed).toEqual([a])
    expect(sources.get(a)).toBeNull()
    await removeSkill({ dir: b, mode: 'delete', cwd, home, env })
    expect(fs.existsSync(b)).toBe(false)

    // Outside the skill folders, nested (the agent's own), or without SKILL.md.
    const outside = path.join(tmp, 'other', 'c')
    write(path.join(outside, 'SKILL.md'), 'x')
    await expect(removeSkill({ dir: outside, mode: 'delete', home, env })).rejects.toThrow()
    const synced = path.join(home, '.claude', 'skills', 'synced', 'acct', 'docx')
    write(path.join(synced, 'SKILL.md'), 'x')
    await expect(removeSkill({ dir: synced, mode: 'delete', home, env })).rejects.toThrow()
    const noMd = path.join(home, '.claude', 'skills', 'nomd')
    fs.mkdirSync(noMd, { recursive: true })
    await expect(removeSkill({ dir: noMd, mode: 'delete', home, env })).rejects.toThrow(/SKILL\.md/)
    expect(fs.existsSync(outside) && fs.existsSync(synced) && fs.existsSync(noMd)).toBe(true)
  })
})

describe('helpers', () => {
  it('finds a setup command, rebuilt from its parts', () => {
    expect(findSetupCommands('First run: npx -y @acme/tool@1.2 setup && rm -rf /')).toEqual(['npx @acme/tool@1.2 setup'])
    expect(findSetupCommands('npx skills add x; npx foo init; npx foo init')).toEqual(['npx foo init'])
    expect(findSetupCommands('nothing here')).toEqual([])
  })

  it('checks names and paths', () => {
    expect(isSafeSkillName('pdf-tools_2')).toBe(true)
    expect(isSafeSkillName('..')).toBe(false)
    expect(isSafeSkillName('nul')).toBe(false)
    expect(isSafeSkillName('a/b')).toBe(false)
    expect(safeRelPath('a/b.txt')).toBe('a/b.txt')
    expect(safeRelPath('dir/')).toBe('dir')
    expect(safeRelPath('/abs')).toBeNull()
    expect(safeRelPath('a//b')).toBeNull()
    expect(safeRelPath('a\\b')).toBeNull()
    expect(safeRelPath('a./b')).toBeNull()
  })

  it('speaks French', async () => {
    setLanguage('fr')
    const empty = path.join(tmp, 'src', 'vide')
    write(path.join(empty, 'x.txt'), 'x')
    await expect(packageFromFolder(empty)).rejects.toThrow(/Il n'y a pas de SKILL\.md/)
  })
})
