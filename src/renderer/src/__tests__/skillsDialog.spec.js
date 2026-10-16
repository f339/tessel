import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { mount, flushPromises } from '@vue/test-utils'
import SkillsDialog from '../components/SkillsDialog.vue'
import { setMessages } from '../i18n'
import fr from '../i18n/locales/fr/skills.json'

const skill = (over) => ({
  id: over.dir + '/SKILL.md',
  name: 'pdf',
  description: 'Fill PDF forms.',
  folder: 'pdf',
  scope: 'user',
  seenBy: ['claude', 'opencode', 'copilot'],
  managed: null,
  link: false,
  removable: true,
  source: null,
  ...over
})

const pkg = {
  id: 'p1',
  name: 'pdf',
  description: 'Fill PDF forms.',
  skillMd: '---\nname: pdf\n---\nUse pdftk.',
  files: [{ path: 'SKILL.md', size: 30 }, { path: 'fill.py', size: 2048 }],
  totalBytes: 2078,
  scripts: ['fill.py'],
  setup: ['npx pdf-helper setup'],
  source: { kind: 'github', owner: 'o', repo: 'r', path: 'skills/pdf', commit: 'abcdef1234' }
}

// The rows, a row by its skill's name, and its details opened by a click.
const names = (w) => w.findAll('.skills-row-name').map((n) => n.text())
const rowOf = (w, name) => w.findAll('.skills-item').find((r) => r.find('.skills-row-name').text() === name)
async function open(w, name) {
  await rowOf(w, name).get('.skills-row').trigger('click')
  await flushPromises()
  return rowOf(w, name)
}
const copyOf = (w, dir) => w.findAll('.skills-copy').find((c) => c.attributes('data-dir') === dir)
const button = (el, text) => el.findAll('button').find((b) => b.text() === text)

describe('Skills dialog', () => {
  let previousApi
  afterEach(() => {
    window.shellApi = previousApi
    setMessages('en', {})
  })

  function api(over = {}) {
    previousApi = window.shellApi
    const calls = { install: [], remove: [], github: [], open: [], clipboard: [] }
    window.shellApi = {
      skillsList: async () => ({
        roots: [],
        skills: [
          skill({ dir: '/h/.claude/skills/pdf', source: { kind: 'github', owner: 'o', repo: 'r', path: 'skills/pdf' } }),
          skill({ dir: '/p/.agents/skills/pdf', scope: 'project', seenBy: ['codex', 'opencode', 'copilot', 'gemini'], source: { kind: 'github', owner: 'o', repo: 'r', path: 'skills/pdf' } }),
          skill({ dir: '/h/.claude/skills/synced/a/docx', name: 'docx', description: null, managed: 'synced', removable: false })
        ]
      }),
      skillsFromGithub: async (q) => {
        calls.github.push(q)
        return q.pick ? pkg : { repo: 'o/r', candidates: [{ path: 'skills/pdf', name: 'pdf' }, { path: 'skills/docx', name: 'docx' }] }
      },
      skillsInstall: async (q) => {
        calls.install.push(q)
        return { ok: true, name: 'pdf', results: [{ dir: '/h/.claude/skills/pdf', ok: true, seenBy: ['claude'] }, { dir: '/h/.agents/skills/pdf', ok: false, exists: true, seenBy: ['codex'] }] }
      },
      skillsRemove: async (q) => {
        calls.remove.push(q)
        return { ok: true }
      },
      skillsForUpdate: async () => pkg,
      skillsOpen: async (q) => (calls.open.push(q), { ok: true }),
      writeClipboard: async (text) => calls.clipboard.push(text),
      ...over
    }
    return calls
  }

  it("one row per skill; its details list each copy: agents, scope, folder; only the user's own can be removed", async () => {
    api()
    const agents = ['claude', 'codex'].map((id) => ({ id, available: true }))
    const wrapper = mount(SkillsDialog, { props: { agents, cwd: '/p' }, attachTo: document.body })
    await flushPromises()
    expect(names(wrapper)).toEqual(['docx', 'pdf'])
    // Collapsed: no copy, no folder shown, the agents once.
    expect(wrapper.find('.skills-copy').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('/h/.claude/skills/pdf')
    const pdfRow = rowOf(wrapper, 'pdf')
    expect(pdfRow.findAll('.skills-row-meta .brand-icon')).toHaveLength(2) // Claude Code and Codex, once each
    expect(pdfRow.get('.skills-agents').attributes('aria-label')).toBe('Seen by Claude Code and Codex')
    expect(pdfRow.findAll('.skills-scope').map((s) => s.text())).toEqual(['All projects', 'This project'])
    expect(pdfRow.get('.skills-row').attributes('aria-expanded')).toBe('false')

    const pdf = await open(wrapper, 'pdf')
    expect(pdf.get('.skills-row').attributes('aria-expanded')).toBe('true')
    expect(pdf.get('.skills-row').attributes('aria-controls')).toBe(pdf.get('.skills-details').attributes('id'))
    const user = copyOf(wrapper, '/h/.claude/skills/pdf')
    expect(user.find('.skills-copy-agents').text()).toBe('Claude Code')
    expect(user.text()).toContain('All projects')
    expect(user.get('.skills-path').attributes('title')).toBe('/h/.claude/skills/pdf')
    expect(button(user, 'Update')).toBeTruthy() // added from GitHub
    const proj = copyOf(wrapper, '/p/.agents/skills/pdf')
    expect(proj.text()).toContain('This project')
    expect(proj.find('.skills-copy-agents').text()).toBe('Codex')
    expect(proj.get('.skills-path').text()).toBe('p/.agents/skills/pdf') // the project by its name
    expect(button(proj, 'Update')).toBeTruthy()

    const docx = await open(wrapper, 'docx')
    expect(rowOf(wrapper, 'pdf').find('.skills-details').exists()).toBe(false) // one open at a time
    expect(docx.text()).toContain('Synced from your Claude account')
    expect(docx.find('.danger').exists()).toBe(false)
    wrapper.unmount()
  })

  // This computer's skills, as listed: Claude's synced copies twice (two
  // account folders), a skill both in Claude's and the shared .agents folder
  // (edited apart), Codex's built-in skills, one of them named like a synced one.
  const SYNCED = ['8fdc980f-8019-47a0-aff7-9f3632317fb9_c00fdf98-9054-427c-ae1b-73fe75f735c0', 'eb653360-5abe-4405-a68a-23f5fb88e822_63192401-a54e-4511-9335-0712b63db3d0']
  const realList = () => [
    ...['docs', 'pdf', 'skill-creator'].flatMap((name) =>
      SYNCED.map((acct) =>
        skill({ dir: `C:\\Users\\me\\.claude\\skills\\synced\\${acct}\\${name}`, name, description: `${name} help.`, managed: 'synced', removable: false, origin: 'agent', mdHash: `md-${name}` })
      )
    ),
    ...['.claude', '.agents'].map((root, i) =>
      skill({
        dir: `C:\\Users\\me\\${root}\\skills\\reverse-engineer-anything`,
        name: 'reverse-engineer-anything',
        description: 'Reverse engineer anything.',
        origin: 'own',
        hash: `h${i}`,
        mdHash: `m${i}`,
        seenBy: i ? ['codex', 'opencode', 'copilot', 'gemini'] : ['claude', 'opencode', 'copilot']
      })
    ),
    ...['imagegen', 'skill-creator'].map((name) =>
      skill({ dir: `C:\\Users\\me\\.codex\\skills\\.system\\${name}`, name, description: `${name} (Codex).`, managed: 'system', removable: false, origin: 'agent', seenBy: ['codex'], mdHash: `codex-${name}` })
    )
  ]

  it('counts agree: the tab, the All filter and the count above the list count the same rows, one per skill', async () => {
    api({ skillsList: async () => ({ roots: [], skills: realList(), home: 'C:\\Users\\me' }) })
    const agents = ['claude', 'codex', 'opencode', 'copilot'].map((id) => ({ id, available: true }))
    const wrapper = mount(SkillsDialog, { props: { agents }, attachTo: document.body })
    await flushPromises()
    // Codex's built-in skill-creator is not Claude's synced one: two rows.
    expect(names(wrapper)).toEqual(['docs', 'imagegen', 'pdf', 'reverse-engineer-anything', 'skill-creator', 'skill-creator'])
    const tab = wrapper.findAll('.launch-seg-btn').find((b) => b.text().startsWith('Installed'))
    expect(tab.get('.mcp-count').text()).toBe('6')
    expect(wrapper.get('.skills-count').text()).toBe('6 skills')
    const chips = wrapper.findAll('.skills-chip')
    expect(chips.map((c) => c.text())).toEqual(['All6', 'Yours1', 'Synced3', 'Built-in2'])
    // Each row has one origin: the filters add up to All, and each shows its count.
    const count = (c) => Number(c.get('.skills-chip-count').text())
    expect(chips.slice(1).reduce((n, c) => n + count(c), 0)).toBe(count(chips[0]))
    for (const chip of chips.slice(1)) {
      await chip.trigger('click')
      expect(wrapper.findAll('.skills-item')).toHaveLength(count(chip))
    }
    await chips[0].trigger('click')
    // A search shows part of the list; the tab and the filters still count all of it.
    await wrapper.get('input.skills-search').setValue('pdf')
    expect(names(wrapper)).toEqual(['pdf'])
    expect(wrapper.get('.skills-count').text()).toBe('1 of 6 skills')
    expect(tab.get('.mcp-count').text()).toBe('6')
    expect(wrapper.findAll('.skills-chip')[0].text()).toBe('All6')
    wrapper.unmount()
  })

  it("Claude's synced copies are one skill, Synced from your Claude account; the folder shortened, never the raw id", async () => {
    api({ skillsList: async () => ({ roots: [], skills: realList(), home: 'C:\\Users\\me' }) })
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }, { id: 'codex', available: true }] }, attachTo: document.body })
    await flushPromises()
    const pdf = rowOf(wrapper, 'pdf')
    expect(pdf.findAll('.skills-origin').map((b) => b.text())).toEqual(['Synced'])
    expect(pdf.get('.skills-origin').attributes('title')).toBe('Synced from your Claude account')
    await open(wrapper, 'pdf')
    const copies = rowOf(wrapper, 'pdf').findAll('.skills-copy')
    expect(copies).toHaveLength(2)
    expect(copies[0].get('.skills-origin').text()).toBe('Synced from your Claude account')
    const shown = copies.map((c) => c.get('.skills-path').text())
    expect(shown).toEqual(['~\\.claude\\skills\\synced\\8fdc980f…\\pdf', '~\\.claude\\skills\\synced\\eb653360…\\pdf'])
    expect(copies[0].get('.skills-path').attributes('title')).toBe(`C:\\Users\\me\\.claude\\skills\\synced\\${SYNCED[0]}\\pdf`)
    expect(rowOf(wrapper, 'pdf').text()).not.toContain(SYNCED[0])
    // The same SKILL.md in both: no word of different versions.
    expect(rowOf(wrapper, 'pdf').find('.skills-versions-note').exists()).toBe(false)

    // Named alike, not the same: Claude's synced one and Codex's built-in one.
    const creators = () => wrapper.findAll('.skills-item').filter((r) => r.find('.skills-row-name').text() === 'skill-creator')
    expect(creators().map((r) => r.get('.skills-origin').text())).toEqual(['Synced', 'Built-in'])
    expect(creators()[1].get('.skills-origin').attributes('title')).toBe('Built into the agent')
    await creators()[0].get('.skills-row').trigger('click')
    expect(creators()[0].findAll('.skills-copy')).toHaveLength(2)
    expect(creators()[1].find('.skills-details').exists()).toBe(false)
    wrapper.unmount()
  })

  it('the details: the whole description, each copy with its actions: open folder, copy the path, remove one, remove all', async () => {
    const long = 'Reverse engineer native, managed, Electron and packaged targets. '.repeat(4).trim()
    const list = realList().map((s) => (s.name === 'reverse-engineer-anything' ? { ...s, description: long } : s))
    const calls = api({ skillsList: async () => ({ roots: [], skills: list, home: 'C:\\Users\\me' }) })
    const asked = []
    const answers = [true]
    const wrapper = mount(SkillsDialog, {
      props: { agents: [{ id: 'claude', available: true }, { id: 'codex', available: true }] },
      global: { provide: { askConfirm: (o) => (asked.push(o), Promise.resolve(answers.shift())) } },
      attachTo: document.body
    })
    await flushPromises()
    const row = rowOf(wrapper, 'reverse-engineer-anything')
    // One line in the row, the whole text in its tooltip and in the details.
    expect(row.get('.skills-row-desc').attributes('title')).toBe(long)
    await open(wrapper, 'reverse-engineer-anything')
    const details = rowOf(wrapper, 'reverse-engineer-anything').get('.skills-details')
    expect(details.get('.skills-details-desc').text()).toBe(long)
    expect(details.get('.skills-versions-note').text()).toContain('2 different versions')
    const claudeDir = 'C:\\Users\\me\\.claude\\skills\\reverse-engineer-anything'
    const agentsDir = 'C:\\Users\\me\\.agents\\skills\\reverse-engineer-anything'
    expect(details.findAll('.skills-copy').map((c) => c.attributes('data-dir'))).toEqual([agentsDir, claudeDir])
    expect(copyOf(wrapper, claudeDir).get('.skills-path').text()).toBe('~\\.claude\\skills\\reverse-engineer-anything')

    await button(copyOf(wrapper, agentsDir), 'Open folder').trigger('click')
    expect(calls.open).toEqual([{ dir: agentsDir, cwd: null }])
    await copyOf(wrapper, claudeDir).get('.skills-copy-btn').trigger('click')
    await flushPromises()
    expect(calls.clipboard).toEqual([claudeDir])
    expect(copyOf(wrapper, claudeDir).get('.skills-copy-btn').classes()).toContain('on')
    expect(copyOf(wrapper, claudeDir).get('.skills-copy-btn').attributes('aria-label')).toBe('Copy the path')
    expect(wrapper.find('.mcp-notice').exists()).toBe(false) // no line pushed above the list

    // Remove all: both folders, after one confirmation that lists them.
    await details.get('.skills-remove-all').trigger('click')
    await flushPromises()
    expect(asked[0].title).toBe('Remove every copy of "reverse-engineer-anything"?')
    expect(asked[0].code).toBe(`${agentsDir}\n${claudeDir}`)
    expect(asked[0].text).toBe('Codex and Claude Code will no longer have it. Running agents notice at their next session.')
    expect(calls.remove.map((r) => r.dir)).toEqual([agentsDir, claudeDir])
    expect(calls.remove.every((r) => r.mode === 'trash')).toBe(true)
    expect(wrapper.get('.mcp-notice').text()).toBe('Moved every copy of "reverse-engineer-anything" to the Recycle Bin.')

    // Synced and built-in copies: nothing to remove, so no Remove all.
    await open(wrapper, 'skill-creator')
    expect(rowOf(wrapper, 'skill-creator').find('.skills-remove-all').exists()).toBe(false)
    expect(rowOf(wrapper, 'skill-creator').find('.danger').exists()).toBe(false)
    wrapper.unmount()
  })

  it('removes one copy to the Recycle Bin, or deletes it after a second confirmation', async () => {
    const calls = api()
    const answers = [true, 'alt', true]
    const asked = []
    const wrapper = mount(SkillsDialog, {
      props: { agents: [{ id: 'claude', available: true }] },
      global: { provide: { askConfirm: (o) => (asked.push(o), Promise.resolve(answers.shift())) } },
      attachTo: document.body
    })
    await flushPromises()
    await open(wrapper, 'pdf')
    const removeBtn = () => copyOf(wrapper, '/h/.claude/skills/pdf').get('.danger')
    expect(removeBtn().attributes('aria-label')).toBe('Remove this copy')
    await removeBtn().trigger('click')
    await flushPromises()
    expect(calls.remove[0]).toMatchObject({ dir: '/h/.claude/skills/pdf', mode: 'trash' })
    expect(asked[0]).toMatchObject({ confirmLabel: 'Move to the Recycle Bin', altLabel: 'Delete permanently', code: '/h/.claude/skills/pdf' })
    await removeBtn().trigger('click')
    await flushPromises()
    expect(calls.remove[1]).toMatchObject({ mode: 'delete' })
    expect(asked[2].title).toContain('permanently')
    wrapper.unmount()
  })

  it('keyboard: arrows move between rows, Enter opens the details, Escape closes them (not the window)', async () => {
    api({ skillsList: async () => ({ roots: [], skills: realList() }) })
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    const rows = () => wrapper.findAll('.skills-row')
    rows()[0].element.focus()
    await rows()[0].trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows()[1].element)
    await rows()[1].trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(rows()[5].element)
    await rows()[5].trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows()[5].element) // the last stays
    await rows()[5].trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(rows()[0].element)
    await rows()[0].trigger('keydown', { key: 'ArrowDown' })
    // Enter on a button is its click.
    await rows()[1].trigger('keydown', { key: 'Enter' })
    await rows()[1].trigger('click')
    expect(rows()[1].attributes('aria-expanded')).toBe('true')
    const details = rowOf(wrapper, 'imagegen').get('.skills-details')
    expect(details.attributes('role')).toBe('region')
    expect(details.attributes('aria-labelledby')).toBe(rows()[1].attributes('id'))
    // Escape from inside the details: closed, back on the row, the window stays.
    await details.get('.skills-btn').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(rowOf(wrapper, 'imagegen').find('.skills-details').exists()).toBe(false)
    expect(document.activeElement).toBe(rows()[1].element)
    expect(wrapper.emitted('close')).toBeUndefined()
    // Arrow right opens, left closes; Escape with nothing open closes the window.
    await rows()[1].trigger('keydown', { key: 'ArrowRight' })
    expect(rows()[1].attributes('aria-expanded')).toBe('true')
    await rows()[1].trigger('keydown', { key: 'ArrowLeft' })
    expect(rows()[1].attributes('aria-expanded')).toBe('false')
    await rows()[1].trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('buttons never wrap: every button of the list has a class that keeps it on one line', async () => {
    const list = [...tracked(), ...realList()]
    api({
      skillsList: async () => ({ roots: [], skills: list }),
      skillsHistory: async () => ({ versions: [{ id: 'v2', changedAt: 2, stats: { plus: 1, minus: 0 }, first: false, latest: true, files: [], fileCount: 0 }, { id: 'v1', changedAt: 1, stats: { plus: 1, minus: 0 }, first: true, latest: false, files: [], fileCount: 0 }] }),
      skillsHistoryDiff: async (q) => ({ id: q.id, files: [] })
    })
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }, { id: 'codex', available: true }] }, attachTo: document.body })
    await flushPromises()
    // Text buttons on one line, icon buttons, and the rows (laid out piece by piece).
    const KEPT = ['skills-btn', 'skills-chip', 'skills-link', 'ws-icon-btn', 'tb-icon', 'launch-seg-btn', 'skills-row', 'skills-version-pick']
    const loose = () => wrapper.findAll('button').filter((b) => !KEPT.some((c) => b.classes().includes(c))).map((b) => b.html().slice(0, 80))
    let seen = 0
    const check = () => {
      seen += wrapper.findAll('button').length
      expect(loose()).toEqual([])
    }
    check()
    await open(wrapper, 'pdf') // a copy from GitHub (Update) and synced ones
    await rowOf(wrapper, 'pdf').get('.skills-link').trigger('click')
    await flushPromises()
    expect(rowOf(wrapper, 'pdf').findAll('.skills-version')).toHaveLength(2) // a Restore button
    check()
    await open(wrapper, 'reverse-engineer-anything') // Remove all
    check()
    expect(seen).toBeGreaterThan(40)
    // Those classes keep their text on one line (or are icons only).
    const css = fs.readFileSync(join(process.cwd(), 'src/renderer/src/components/SkillsDialog.vue'), 'utf8')
    const rule = (sel) => {
      const at = css.indexOf(`\n${sel} {`)
      return at < 0 ? '' : css.slice(at, css.indexOf('}', at))
    }
    for (const sel of ['.skills-btn', '.skills-chip', '.skills-link', '.skills-tag', '.skills-row-name', '.skills-row-desc', '.skills-path']) expect(rule(sel), sel).toContain('white-space: nowrap')
    for (const sel of ['.skills-btn', '.skills-chip', '.skills-actions', '.skills-tag']) expect(rule(sel), sel).toContain('flex: 0 0 auto')
    expect(rule('.skills-actions')).toContain('flex-wrap: nowrap')
    // The list follows its own width (a narrow page, or zoomed in).
    expect(rule('.skills-list')).toContain('container-type: inline-size')
    expect(css).toContain('@container (max-width: 460px)')
    expect(css).not.toMatch(/codicon/)
    wrapper.unmount()
  })

  it('adds from GitHub: picks a skill, shows SKILL.md and files, installs for the chosen agents and scope', async () => {
    const calls = api()
    const agents = ['claude', 'codex'].map((id) => ({ id, available: true }))
    const asked = []
    const wrapper = mount(SkillsDialog, {
      props: { agents, cwd: '/p' },
      global: { provide: { askConfirm: (o) => (asked.push(o), Promise.resolve(true)) } },
      attachTo: document.body
    })
    await flushPromises()
    await wrapper.findAll('.launch-seg-btn').find((b) => b.text() === 'Add').trigger('click')
    await wrapper.find('input.mcp-input').setValue('o/r')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('several skills')
    await wrapper.findAll('.skills-candidates .exit-btn')[0].trigger('click')
    await flushPromises()
    expect(calls.github[1]).toEqual({ input: 'o/r', pick: 'skills/pdf' })
    expect(wrapper.find('.skills-md').text()).toContain('Use pdftk.')
    expect(wrapper.text()).toContain('2 files')
    expect(wrapper.text()).toContain('fill.py')
    expect(wrapper.text()).toContain('Tessel never runs them')

    // The setup command is offered, never run on its own.
    await wrapper.findAll('.skills-setup .exit-btn')[0].trigger('click')
    await flushPromises()
    expect(asked[0].code).toBe('npx pdf-helper setup')
    expect(wrapper.emitted('run')[0][0]).toMatchObject({ command: 'npx pdf-helper setup' })

    await wrapper.findAll('.set-seg .launch-seg-btn').find((b) => b.text() === 'This project').trigger('click')
    await wrapper.find('.skills-preview form').trigger('submit')
    await flushPromises()
    expect(calls.install[0]).toMatchObject({ id: 'p1', agents: ['claude', 'codex'], scope: 'project', cwd: '/p', replace: null })
    const results = wrapper.findAll('.mcp-add-results .mcp-agent')
    expect(results.map((r) => r.find('.mcp-status').text())).toEqual(['Installed', 'Already there'])
    await results[1].find('button').trigger('click')
    await flushPromises()
    expect(calls.install[1]).toMatchObject({ replace: '/h/.agents/skills/pdf' })
    wrapper.unmount()
  })

  it('Update shows the new version, then replaces that copy only', async () => {
    const calls = api()
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    await open(wrapper, 'pdf')
    await button(copyOf(wrapper, '/h/.claude/skills/pdf'), 'Update').trigger('click')
    await flushPromises()
    expect(wrapper.find('.skills-md').exists()).toBe(true)
    expect(wrapper.find('.mcp-targets').exists()).toBe(false)
    await wrapper.find('.skills-preview form').trigger('submit')
    await flushPromises()
    expect(calls.install[0]).toMatchObject({ id: 'p1', replace: '/h/.claude/skills/pdf' })
    wrapper.unmount()
  })

  // A list with each origin, an edited copy and one with an update.
  const tracked = () => [
    skill({
      dir: '/h/.claude/skills/pdf',
      origin: 'github',
      source: { kind: 'github', owner: 'o', repo: 'r', path: 'skills/pdf', commit: 'a'.repeat(40) },
      modified: true,
      update: { available: true, latest: { sha: 'c'.repeat(40), message: 'Fix tables', date: Date.UTC(2026, 9, 1), author: 'Ada' }, commits: [], more: false },
      history: { versions: 3, changedAt: Date.now() - 3 * 86400000, firstAt: 1 }
    }),
    skill({ dir: '/h/.claude/skills/mine', name: 'mine', origin: 'own', history: { versions: 1, changedAt: Date.now() - 3600000, firstAt: 1 } }),
    skill({ dir: '/h/.agents/skills/copied', name: 'copied', origin: 'folder', source: { kind: 'folder', path: '/src/copied' }, seenBy: ['codex'] }),
    skill({ dir: '/h/.claude/skills/synced/a/docx', name: 'docx', description: null, origin: 'agent', managed: 'synced', removable: false })
  ]

  it('badges: where each skill comes from, if it was edited, if GitHub has an update; the same on each copy', async () => {
    api({ skillsList: async () => ({ roots: [], skills: tracked() }) })
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }, { id: 'codex', available: true }] }, attachTo: document.body })
    await flushPromises()
    const badges = (name) => rowOf(wrapper, name).findAll('.skills-row-top .skills-tag').map((b) => b.text())
    expect(badges('mine')).toEqual(['Yours'])
    expect(rowOf(wrapper, 'mine').get('.skills-origin').classes()).toContain('origin-own')
    expect(rowOf(wrapper, 'mine').get('.skills-origin').attributes('title')).toContain('no record of adding it')
    expect(badges('pdf')).toEqual(['GitHub', 'Modified locally', 'Update available'])
    expect(rowOf(wrapper, 'pdf').get('.skills-origin').attributes('title')).toContain('o/r/skills/pdf @ aaaaaaa')
    expect(rowOf(wrapper, 'pdf').get('.skills-update').attributes('title')).toContain('Fix tables')
    expect(badges('copied')).toEqual(['Folder'])
    expect(badges('docx')).toEqual(['Synced'])
    expect(rowOf(wrapper, 'docx').get('.skills-row-desc').text()).toBe('No description.')
    // Partly kept only when relevant.
    expect(wrapper.find('.skills-partial').exists()).toBe(false)

    await open(wrapper, 'pdf')
    const copy = copyOf(wrapper, '/h/.claude/skills/pdf')
    expect(copy.get('.skills-origin').text()).toBe('From GitHub — o/r')
    expect(copy.get('.skills-modified').text()).toBe('Modified locally')
    expect(copy.get('.skills-update').text()).toBe('Update available')
    expect(copy.get('.skills-update-line').text()).toContain('Newest change: Fix tables')
    expect(button(copy, 'Update').classes()).toContain('primary')
    expect(copy.get('.skills-history-line').text()).toContain('Changed 3 days ago · 3 versions')
    await open(wrapper, 'mine')
    expect(copyOf(wrapper, '/h/.claude/skills/mine').get('.skills-origin').text()).toBe('Your skill')
    expect(copyOf(wrapper, '/h/.claude/skills/mine').get('.skills-history-line').text()).toContain('Changed 1 hour ago · 1 version')
    expect(button(copyOf(wrapper, '/h/.claude/skills/mine'), 'Update')).toBeUndefined() // only one added from GitHub
    await open(wrapper, 'copied')
    expect(copyOf(wrapper, '/h/.agents/skills/copied').get('.skills-origin').text()).toBe('Copied from a folder')
    expect(copyOf(wrapper, '/h/.agents/skills/copied').find('.skills-history-line').exists()).toBe(false)
    wrapper.unmount()
  })

  it('filters: compact chips with their counts, only for the origins in the list', async () => {
    const many = [...tracked(), ...['a', 'b', 'c', 'd'].map((n) => skill({ dir: `/h/.claude/skills/${n}`, name: n, origin: 'own' }))]
    api({ skillsList: async () => ({ roots: [], skills: many }) })
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    const filter = wrapper.get('.skills-filter')
    expect(filter.attributes('role')).toBe('group')
    expect(filter.findAll('button').map((b) => b.text())).toEqual(['All8', 'Yours5', 'GitHub1', 'Folders1', 'Synced1'])
    expect(filter.findAll('button')[0].attributes('aria-pressed')).toBe('true')
    await filter.findAll('button')[1].trigger('click')
    expect(filter.findAll('button')[1].attributes('aria-pressed')).toBe('true')
    expect(names(wrapper)).toEqual(['a', 'b', 'c', 'd', 'mine'])
    expect(wrapper.get('.skills-count').text()).toBe('5 of 8 skills')
    await filter.findAll('button')[2].trigger('click')
    expect(names(wrapper)).toEqual(['pdf'])
    // Nothing found: says so, and shows everything again on a click.
    await wrapper.get('input.skills-search').setValue('zzz')
    expect(wrapper.get('.skills-nomatch').text()).toContain('No skill matches this search or filter.')
    await button(wrapper.get('.skills-nomatch'), 'Show every skill').trigger('click')
    expect(names(wrapper)).toHaveLength(8)
    expect(wrapper.get('input.skills-search').element.value).toBe('')
    wrapper.unmount()

    // Skills from one place only: no filters.
    api({ skillsList: async () => ({ roots: [], skills: many.filter((s) => s.origin === 'own') }) })
    const plain = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    expect(plain.find('.skills-filter').exists()).toBe(false)
    plain.unmount()
  })

  it('loading, then empty: placeholder rows the first time, then a way to add one', async () => {
    let answer
    api({ skillsList: () => new Promise((resolve) => (answer = resolve)) })
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.findAll('.skills-skeleton')).toHaveLength(3)
    expect(wrapper.get('.skills-list').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('.skills-count').text()).toBe('Loading…')
    answer({ roots: [], skills: [] })
    await flushPromises()
    expect(wrapper.find('.skills-skeleton').exists()).toBe(false)
    expect(wrapper.get('.mcp-empty').text()).toContain('No skills yet.')
    await button(wrapper.get('.mcp-empty'), 'Add a skill').trigger('click')
    expect(wrapper.find('.skills-preview, input.mcp-input').exists()).toBe(true)
    wrapper.unmount()
  })

  it('History: the versions, one against the one before, and Restore after a confirmation', async () => {
    const asked = []
    const got = { history: [], diff: [], restore: [] }
    const versions = [
      { id: 'v3', changedAt: Date.UTC(2026, 9, 14, 9), stats: { plus: 4, minus: 1 }, first: false, latest: true, note: null, files: ['SKILL.md'], fileCount: 1 },
      { id: 'v2', changedAt: Date.UTC(2026, 9, 12, 9), stats: { plus: 2, minus: 0 }, first: false, latest: false, note: { kind: 'update', commit: 'b'.repeat(40) }, files: ['a.md', 'b.md'], fileCount: 2 },
      { id: 'v1', changedAt: Date.UTC(2026, 9, 10, 9), stats: { plus: 9, minus: 0 }, first: true, latest: false, note: null, files: ['SKILL.md'], fileCount: 1 }
    ]
    api({
      skillsList: async () => ({ roots: [], skills: tracked() }),
      skillsHistory: async (q) => (got.history.push(q), { dir: q.dir, versions }),
      skillsHistoryDiff: async (q) => {
        got.diff.push(q)
        return {
          id: q.id,
          files: [
            {
              path: 'SKILL.md',
              status: 'M',
              binary: false,
              added: 1,
              removed: 1,
              truncated: false,
              hunks: [{ header: '@@ -1,2 +1,2 @@', lines: [{ kind: 'ctx', text: '# pdf', old: 1, new: 1 }, { kind: 'del', text: 'Old rule.', old: 2, new: '' }, { kind: 'add', text: 'New rule.', old: '', new: 2 }] }]
            },
            { path: 'logo.png', status: 'A', binary: true, added: 0, removed: 0, hunks: [] },
            { path: 'video.mp4', status: 'A', binary: true, notKept: true, added: 0, removed: 0, hunks: [] }
          ]
        }
      },
      skillsRestore: async (q) => (got.restore.push(q), { ok: true, kept: [] })
    })
    const wrapper = mount(SkillsDialog, {
      props: { agents: [{ id: 'claude', available: true }], cwd: '/p' },
      global: { provide: { askConfirm: (o) => (asked.push(o), Promise.resolve(true)) } },
      attachTo: document.body
    })
    await flushPromises()
    await open(wrapper, 'pdf')
    const pdf = () => rowOf(wrapper, 'pdf')
    await pdf().find('.skills-link').trigger('click')
    await flushPromises()
    expect(got.history[0]).toEqual({ dir: '/h/.claude/skills/pdf', cwd: '/p' })
    const items = pdf().findAll('.skills-version')
    expect(items).toHaveLength(3)
    expect(items[0].text()).toContain('1 file changed')
    expect(items[0].text()).toContain('+4')
    expect(items[0].text()).toContain('−1')
    expect(items[0].text()).toContain('Current')
    expect(items[1].text()).toContain('2 files changed')
    expect(items[1].text()).toContain('Updated from GitHub @ bbbbbbb')
    expect(items[2].text()).toContain('First version kept')
    expect(items[0].find('.exit-btn').exists()).toBe(false) // the current one: nothing to restore
    // The newest is shown first, against the one before.
    expect(got.diff[0]).toMatchObject({ dir: '/h/.claude/skills/pdf', id: 'v3' })
    const diff = pdf().find('.skills-diff')
    expect(diff.findAll('.rv-line.del').map((l) => l.text())).toEqual(['2−Old rule.'])
    expect(diff.findAll('.rv-line.add').map((l) => l.text())).toEqual(['2+New rule.'])
    expect(diff.text()).toContain('Binary file: no text diff.')
    expect(diff.text()).toContain('Too large to keep in the history')
    await items[2].find('.skills-version-pick').trigger('click')
    await flushPromises()
    expect(got.diff[1]).toMatchObject({ id: 'v1' })
    expect(pdf().find('.skills-diff').text()).toContain('The first version Tessel kept')

    await items[1].findAll('.exit-btn').find((b) => b.text() === 'Restore this version').trigger('click')
    await flushPromises()
    expect(asked[0].title).toContain('Restore "pdf"')
    expect(asked[0].text).toContain('kept in the history first')
    expect(got.restore[0]).toEqual({ dir: '/h/.claude/skills/pdf', id: 'v2', cwd: '/p' })
    expect(wrapper.find('.mcp-notice').text()).toContain('Restored "pdf"')
    expect(got.history).toHaveLength(2) // shown again, with the new version
    expect(pdf().find('.skills-details').exists()).toBe(true) // still open

    await pdf().find('.skills-link').trigger('click')
    expect(pdf().find('.skills-history').exists()).toBe(false)
    wrapper.unmount()
  })

  it('Update of an edited copy: what changed on GitHub, a warning, and a confirmation before replacing', async () => {
    const asked = []
    const answers = [false, true]
    const changes = {
      available: true,
      commits: [
        { sha: '3'.repeat(40), message: 'Fix tables', date: Date.UTC(2026, 9, 3), author: 'Ada' },
        { sha: '2'.repeat(40), message: 'Add forms', date: Date.UTC(2026, 9, 2), author: 'Bob' }
      ],
      more: true
    }
    const calls = api({ skillsList: async () => ({ roots: [], skills: tracked() }), skillsForUpdate: async () => ({ ...pkg, changes }) })
    const wrapper = mount(SkillsDialog, {
      props: { agents: [{ id: 'claude', available: true }] },
      global: { provide: { askConfirm: (o) => (asked.push(o), Promise.resolve(answers.shift())) } },
      attachTo: document.body
    })
    await flushPromises()
    await open(wrapper, 'pdf')
    await button(copyOf(wrapper, '/h/.claude/skills/pdf'), 'Update').trigger('click')
    await flushPromises()
    expect(wrapper.find('.skills-warn').text()).toContain('You changed this copy')
    const box = wrapper.find('.skills-changes')
    expect(box.text()).toContain('What changed since your version (2 commits)')
    expect(box.findAll('li').map((li) => li.find('.skills-commit-msg').text())).toEqual(['Fix tables', 'Add forms'])
    expect(box.findAll('li')[1].text()).toContain('Bob')
    expect(box.text()).toContain('only the 30 newest')
    await wrapper.find('.skills-preview form').trigger('submit')
    await flushPromises()
    expect(asked[0]).toMatchObject({ confirmLabel: 'Update anyway', danger: true })
    expect(calls.install).toHaveLength(0) // declined
    await wrapper.find('.skills-preview form').trigger('submit')
    await flushPromises()
    expect(calls.install[0]).toMatchObject({ replace: '/h/.claude/skills/pdf' })
    wrapper.unmount()
  })

  it('checks GitHub for updates when it opens (only when due) and on Refresh (asked), then lists again', async () => {
    const checks = []
    let lists = 0
    api({
      skillsList: async () => (lists++, { roots: [], skills: tracked(), updates: { checkedAt: Date.now() - 2 * 3600000 } }),
      skillsCheckUpdates: async (q) => (checks.push(q), q.force ? { ok: false, checked: false, rateLimited: true, until: Date.UTC(2026, 9, 15, 14) } : { ok: true, checked: true })
    })
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    expect(checks).toEqual([{ force: false }])
    expect(lists).toBe(2) // listed again after the check
    expect(wrapper.find('.skills-checked').text()).toContain('Updates checked 2 hours ago')
    await wrapper.findAll('.exit-btn').find((b) => b.text() === 'Refresh').trigger('click')
    await flushPromises()
    expect(checks[1]).toEqual({ force: true })
    expect(wrapper.find('.mcp-error').text()).toContain("GitHub's limit for update checks is reached")
    wrapper.unmount()

    // Nothing from GitHub: GitHub is never asked.
    checks.length = 0
    window.shellApi = { ...window.shellApi, skillsList: async () => ({ roots: [], skills: [skill({ dir: '/h/.claude/skills/mine', name: 'mine' })] }) }
    const other = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    await other.findAll('.exit-btn').find((b) => b.text() === 'Refresh').trigger('click')
    await flushPromises()
    expect(checks).toEqual([])
    other.unmount()
  })

  it('a copy with too many files to keep says so, and its history offers no Restore', async () => {
    const list = tracked()
    list[1].history = { versions: 2, changedAt: Date.now() - 3600000, firstAt: 1, partial: true }
    const versions = [
      { id: 'v2', changedAt: Date.UTC(2026, 9, 14), stats: { plus: 1, minus: 0 }, first: false, latest: true, note: null, files: ['a.md'], fileCount: 1 },
      { id: 'v1', changedAt: Date.UTC(2026, 9, 10), stats: { plus: 3, minus: 0 }, first: true, latest: false, note: null, files: ['SKILL.md'], fileCount: 1 }
    ]
    api({
      skillsList: async () => ({ roots: [], skills: list }),
      skillsHistory: async () => ({ versions }),
      skillsHistoryDiff: async (q) => ({ id: q.id, files: [] })
    })
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    const mine = () => rowOf(wrapper, 'mine')
    expect(mine().get('.skills-row-top .skills-partial').text()).toBe('Partly kept')
    expect(mine().get('.skills-partial').attributes('title')).toContain('cannot be restored')
    await open(wrapper, 'mine')
    expect(copyOf(wrapper, '/h/.claude/skills/mine').get('.skills-partial').text()).toBe('Partly kept')
    await mine().find('.skills-link').trigger('click')
    await flushPromises()
    expect(mine().find('.skills-history').text()).toContain('Too many files')
    expect(mine().findAll('.skills-version .exit-btn')).toHaveLength(0)
    wrapper.unmount()
  })

  it('after an Update, says the old copy is in the Recycle Bin', async () => {
    api({
      skillsInstall: async () => ({ ok: true, name: 'pdf', results: [{ dir: '/h/.claude/skills/pdf', ok: true, trashed: true, seenBy: ['claude'] }] })
    })
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    await open(wrapper, 'pdf')
    await button(copyOf(wrapper, '/h/.claude/skills/pdf'), 'Update').trigger('click')
    await flushPromises()
    await wrapper.find('.skills-preview form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('.mcp-notice').text()).toBe('Updated "pdf". The old copy is in the Recycle Bin. Agents use it from their next session.')
    wrapper.unmount()
  })

  it('speaks French: origins, badges, filters, details, history', async () => {
    api({ skillsList: async () => ({ roots: [], skills: [...tracked(), ...realList()] }) })
    setMessages('fr', fr)
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }, { id: 'codex', available: true }] }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.findAll('.skills-chip').map((c) => c.text())).toEqual(['Toutes10', 'Les vôtres2', 'GitHub1', 'Dossiers1', 'Synchronisées4', 'Intégrées2'])
    expect(wrapper.get('.skills-count').text()).toBe('10 compétences')
    expect(rowOf(wrapper, 'mine').get('.skills-origin').text()).toBe('À vous')
    expect(rowOf(wrapper, 'docx').get('.skills-origin').text()).toBe('Synchronisée')
    expect(rowOf(wrapper, 'imagegen').get('.skills-origin').text()).toBe('Intégrée')
    expect(rowOf(wrapper, 'pdf').text()).toContain('Modifiée localement')
    expect(rowOf(wrapper, 'pdf').text()).toContain('Mise à jour disponible')
    expect(rowOf(wrapper, 'pdf').text()).toContain('Tous les projets')
    await open(wrapper, 'pdf')
    const text = rowOf(wrapper, 'pdf').text()
    expect(text).toContain('Où elle est installée')
    expect(text).toContain('Depuis GitHub — o/r')
    expect(text).toContain('Modifiée il y a 3 jours · 3 versions')
    expect(text).toContain('Historique')
    expect(text).toContain('Ouvrir le dossier')
    expect(rowOf(wrapper, 'pdf').get('.skills-copy-btn').attributes('aria-label')).toBe('Copier le chemin')
    await open(wrapper, 'docx')
    expect(rowOf(wrapper, 'docx').get('.skills-copy .skills-origin').text()).toBe('Synchronisée depuis votre compte Claude')
    await open(wrapper, 'reverse-engineer-anything')
    expect(rowOf(wrapper, 'reverse-engineer-anything').text()).toContain('Tout retirer')
    expect(rowOf(wrapper, 'reverse-engineer-anything').text()).toContain('Ces copies ne sont pas toutes identiques : 2 versions différentes.')
    await wrapper.get('input.skills-search').setValue('imagegen')
    expect(wrapper.get('.skills-count').text()).toBe('1 sur 10 compétences')
    wrapper.unmount()
  })

  it('speaks French', async () => {
    api()
    setMessages('fr', fr)
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.text()).toContain('Les compétences sont des dossiers')
    expect(wrapper.text()).toContain('Tous les projets')
    expect(rowOf(wrapper, 'docx').get('.skills-origin').attributes('title')).toBe('Synchronisée depuis votre compte Claude')
    wrapper.unmount()
  })

  it('as a window: Escape and a click on the backdrop close it', async () => {
    api()
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(wrapper.find('.help-head').exists()).toBe(true)
    await wrapper.get('input.skills-search').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
    await wrapper.trigger('pointerdown')
    expect(wrapper.emitted('close')).toHaveLength(2)
    wrapper.unmount()
  })

  it('embedded (a Settings page): the same content, without backdrop, card, title bar or a way to close it', async () => {
    api()
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }], embedded: true }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('.help-backdrop').exists()).toBe(false)
    expect(wrapper.find('.help-card').exists()).toBe(false)
    expect(wrapper.find('.help-head').exists()).toBe(false)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.find('.mcp-intro').exists()).toBe(true)
    expect(names(wrapper)).toEqual(['docx', 'pdf'])
    expect(document.activeElement).toBe(document.body)
    await wrapper.get('input.skills-search').trigger('keydown', { key: 'Escape' })
    await wrapper.trigger('pointerdown')
    expect(wrapper.emitted('close')).toBeUndefined()
    wrapper.unmount()
  })

  it('Antigravity plugins: only with the Antigravity CLI installed; listed, turned off, uninstalled, installed in a pane', async () => {
    const calls = api()
    calls.set = []
    calls.rm = []
    let list = [
      { name: 'figma', enabled: true, version: '1.2.0', source: 'antigravity-plugins-official', counts: { skills: 2, mcpServers: 1 } },
      { name: 'old-kit', enabled: false, version: '', source: 'antigravity', counts: {} }
    ]
    Object.assign(window.shellApi, {
      agyPluginsList: async () => ({ plugins: list }),
      agyPluginsSet: async (q) => {
        calls.set.push(q)
        list = list.map((p) => (p.name === q.name ? { ...p, enabled: q.enabled } : p))
        return { ok: true }
      },
      agyPluginsRemove: async (q) => {
        calls.rm.push(q)
        list = list.filter((p) => p.name !== q.name)
        return { ok: true }
      }
    })
    const without = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    expect(without.find('[data-test="skills-tab-plugins"]').exists()).toBe(false)
    without.unmount()

    const agents = [{ id: 'claude', available: true }, { id: 'antigravity', available: true }]
    const wrapper = mount(SkillsDialog, { props: { agents }, attachTo: document.body, global: { provide: { askConfirm: () => Promise.resolve(true) } } })
    await flushPromises()
    await wrapper.get('[data-test="skills-tab-plugins"]').trigger('click')
    await flushPromises()
    const figma = wrapper.get('[data-test="agy-plugin-figma"]')
    expect(figma.text()).toContain('1.2.0')
    expect(figma.text()).toContain('2 skills · 1 MCP server')
    expect(wrapper.get('[data-test="agy-plugin-old-kit"]').text()).toContain('Turned off')
    await figma.findAll('button')[0].trigger('click')
    await flushPromises()
    expect(calls.set).toEqual([{ name: 'figma', enabled: false }])
    expect(wrapper.get('[data-test="agy-plugin-figma"]').text()).toContain('Turned off')
    await wrapper.get('[data-test="agy-plugin-old-kit"]').find('button.danger').trigger('click')
    await flushPromises()
    expect(calls.rm).toEqual([{ name: 'old-kit' }])
    expect(wrapper.find('[data-test="agy-plugin-old-kit"]').exists()).toBe(false)
    // Installing runs in a pane the user sees; nothing a shell would read as more.
    await wrapper.get('[data-test="agy-plugin-target"]').setValue('figma@antigravity-plugins-official')
    await wrapper.get('form.mcp-toolbar').trigger('submit')
    expect(wrapper.emitted('run').at(-1)[0].command).toBe('agy plugin install "figma@antigravity-plugins-official"')
    await wrapper.get('[data-test="agy-plugin-target"]').setValue('x; rm -rf /')
    await wrapper.get('form.mcp-toolbar').trigger('submit')
    expect(wrapper.emitted('run')).toHaveLength(1)
    expect(wrapper.text()).toContain('Enter a plugin name')
    wrapper.unmount()
  })

  it('Antigravity plugins: French', async () => {
    api({ agyPluginsList: async () => ({ plugins: [{ name: 'figma', enabled: false, version: '1.0.0', source: 'x', counts: { skills: 1 } }] }), agyPluginsSet: async () => ({ ok: true }), agyPluginsRemove: async () => ({ ok: true }) })
    setMessages('fr', fr)
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'antigravity', available: true }] }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.get('[data-test="skills-tab-plugins"]').text()).toBe('Plugins Antigravity')
    await wrapper.get('[data-test="skills-tab-plugins"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="agy-plugin-figma"]').text()).toContain('Désactivé')
    expect(wrapper.get('[data-test="agy-plugin-figma"]').text()).toContain('1 skill')
    wrapper.unmount()
  })
})
