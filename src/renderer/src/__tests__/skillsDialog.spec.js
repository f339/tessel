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

  // The Add tab, opened.
  async function openAdd(over = {}, props = {}) {
    const calls = api({ skillsFromGithub: async (q) => (calls.github.push(q), pkg), ...over })
    const asked = []
    const wrapper = mount(SkillsDialog, {
      props: { agents: ['claude', 'codex'].map((id) => ({ id, available: true })), cwd: '/p/artcraft', ...props },
      global: { provide: { askConfirm: (o) => (asked.push(o), Promise.resolve(true)) } },
      attachTo: document.body
    })
    await flushPromises()
    await wrapper.get('[data-test="skills-tab-add"]').trigger('click')
    return { wrapper, calls, asked }
  }
  async function lookUpRepo(w, text) {
    if (w.find('[data-test="skills-change-source"]').exists()) await w.get('[data-test="skills-change-source"]').trigger('click')
    await w.get('[data-test="skills-repo"]').setValue(text)
    await w.get('.skills-source-form').trigger('submit')
    await flushPromises()
  }
  const chip = (w, a) => w.get(`.skills-agent-chip[data-agent="${a}"]`)
  const candRows = (w) => w.findAll('.skills-cand .skills-row')
  const candOf = (w, name) => w.get(`.skills-cand[data-skill="${name}"]`)
  const submit = async (w) => {
    await w.get('.skills-actionbar').trigger('submit')
    await flushPromises()
  }

  it('Add: the source in one bar, repositories to try; an error says what went wrong; the skill found, then the install bar', async () => {
    const { wrapper, calls } = await openAdd({
      skillsFromGithub: async (q) => (calls.github.push(q), q.input === 'x/missing' ? { ok: false, error: 'Not found on GitHub.' } : pkg)
    })
    // GitHub or a folder, one box with its button inside; the install bar is there already, with nothing to install.
    const bar = wrapper.get('.skills-source-bar')
    expect(bar.attributes('aria-label')).toBe('Where it comes from')
    const sources = wrapper.get('.skills-sources')
    expect(sources.attributes('role')).toBe('group')
    expect(sources.findAll('.skills-source').map((b) => [b.text(), b.attributes('aria-pressed')])).toEqual([
      ['GitHub', 'true'],
      ['Folder', 'false']
    ])
    expect(wrapper.get('.skills-field [data-test="skills-look"]').attributes('disabled')).toBeDefined() // nothing typed yet
    expect(wrapper.get('[data-test="skills-repo"]').attributes('aria-label')).toBe('Repository')
    expect(wrapper.get('[data-test="skills-install"]').text()).toBe('Install')
    expect(wrapper.get('[data-test="skills-install"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.skills-foot-summary').text()).toBe('Look up a repository or choose a folder')
    expect(wrapper.find('.skills-browse').exists()).toBe(false)

    // A suggested repository is looked up at once.
    expect(wrapper.findAll('.skills-suggest').map((b) => b.text())).toEqual(['anthropics/skills', 'openai/skills', 'huggingface/skills', 'obra/superpowers'])
    await wrapper.get('.skills-suggest[data-repo="anthropics/skills"]').trigger('click')
    await flushPromises()
    expect(calls.github[0]).toEqual({ input: 'anthropics/skills', pick: null })
    expect(wrapper.find('.skills-source-what').exists()).toBe(true)

    await lookUpRepo(wrapper, 'x/missing')
    const error = wrapper.get('.skills-add-error')
    expect(error.attributes('role')).toBe('alert')
    expect(error.text()).toBe('Not found on GitHub.')
    expect(wrapper.get('[data-test="skills-repo"]').attributes('aria-invalid')).toBe('true')
    expect(wrapper.get('[data-test="skills-repo"]').attributes('aria-describedby')).toContain(error.attributes('id'))
    expect(wrapper.find('.skills-browse').exists()).toBe(false)

    await lookUpRepo(wrapper, 'o/r/skills/pdf')
    expect(wrapper.find('.skills-add-error').exists()).toBe(false)
    // Found: the source in one line (Change source brings the box back); the skill alone, no list.
    expect(wrapper.find('.skills-source-bar').exists()).toBe(false)
    expect(wrapper.get('.skills-source-what').text()).toBe('o/r/skills/pdf @ abcdef1')
    expect(wrapper.get('.skills-browse').classes()).toContain('single')
    expect(wrapper.find('.skills-browse-list').exists()).toBe(false)
    const card = wrapper.get('.skills-preview')
    expect(card.get('.skills-detail-name').text()).toBe('pdf')
    expect(card.get('.skills-details-desc').text()).toBe('Fill PDF forms.')
    expect(card.find('.skills-desc-more').exists()).toBe(false) // short: shown whole
    expect(card.get('.skills-pv-source').text()).toBe('o/r/skills/pdf @ abcdef1')
    expect(card.get('.skills-pv-source').attributes('title')).toBe('From GitHub: o/r/skills/pdf @ abcdef1234')
    expect(card.get('.skills-pv-files').text()).toBe('2 files, 2 KB')
    expect(card.text()).toContain('Read it before installing: an agent follows these instructions.')
    expect(card.text()).toContain('Tessel never runs them')
    expect(wrapper.get('[data-test="skills-install"]').text()).toBe('Install pdf')
    expect(wrapper.get('.skills-foot-summary').text()).toBe('pdf · For Claude Code and Codex · All projects')
    // The files, on a click, each with its size next to it; few: no "Show all".
    await card.get('.skills-pv-files').trigger('click')
    expect(card.get('.skills-pv-files').attributes('aria-expanded')).toBe('true')
    expect(card.findAll('.skills-files tr').map((r) => r.text())).toEqual(['SKILL.md30 B', 'fill.py2 KB'])
    expect(card.find('[data-test="skills-files-all"]').exists()).toBe(false)
    // No label squeezed beside its control: no setting row in the tab.
    expect(wrapper.find('.skills-add .set-row').exists()).toBe(false)

    // Change source: the box again, with what was typed; Cancel keeps what was found.
    await wrapper.get('[data-test="skills-change-source"]').trigger('click')
    expect(wrapper.get('[data-test="skills-repo"]').element.value).toBe('o/r/skills/pdf')
    expect(wrapper.find('.skills-preview').exists()).toBe(true)
    await wrapper.findAll('.skills-source-cancel').at(0).trigger('click')
    expect(wrapper.find('.skills-source-bar').exists()).toBe(false)
    expect(wrapper.get('.skills-source-what').text()).toBe('o/r/skills/pdf @ abcdef1')
    wrapper.unmount()
  })

  it('a repository with several skills: its list beside the skill opened, read from GitHub at the commit of the list; keyboard; back to the list', async () => {
    const candidates = [
      { path: 'skills/pdf', name: 'pdf', description: 'PDF things.', files: 2, bytes: 2078 },
      { path: 'skills/docx', name: 'docx', description: 'Word things.', files: 5, bytes: 40960 },
      { path: 'skills/xlsx', name: 'xlsx', description: null, files: 1, bytes: 900 }
    ]
    const { wrapper, calls } = await openAdd({
      skillsFromGithub: async (q) => {
        calls.github.push(q)
        return q.pick ? { ...pkg, name: q.pick.split('/').pop(), id: q.pick } : { repo: 'o/r', commit: 'c'.repeat(40), total: 3, candidates }
      }
    })
    await lookUpRepo(wrapper, 'o/r')
    // The source in one line: the repository, its commit, how many skills.
    expect(wrapper.get('.skills-source-what').text()).toBe('o/r @ ccccccc')
    expect(wrapper.get('.skills-source-what').attributes('title')).toBe('3 skills in o/r @ ccccccc')
    expect(wrapper.get('.skills-source-count').text()).toBe('3 skills')
    // The list: a row each, its name, size and description; nothing opened yet.
    expect(wrapper.findAll('.skills-cand .skills-row-name').map((n) => n.text())).toEqual(['pdf', 'docx', 'xlsx'])
    expect(wrapper.findAll('.skills-cand .skills-row-size').map((n) => n.text())).toEqual(['2 files, 2 KB', '5 files, 40 KB', '1 file, 900 B'])
    expect(candRows(wrapper).map((r) => r.attributes('title'))).toEqual(['skills/pdf', 'skills/docx', 'skills/xlsx'])
    expect(candRows(wrapper)[2].get('.skills-row-desc').text()).toBe('No description.')
    expect(wrapper.get('.skills-browse-shown').text()).toBe('3 skills')
    expect(wrapper.get('.skills-detail-empty').text()).toContain('Open a skill of the list')
    expect(wrapper.get('[data-test="skills-install"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.skills-foot-summary').text()).toBe('Choose a skill to install')

    await candRows(wrapper)[1].trigger('click')
    await flushPromises()
    expect(calls.github.at(-1)).toEqual({ input: 'o/r', pick: 'skills/docx', commit: 'c'.repeat(40) })
    expect(candRows(wrapper)[1].attributes('aria-current')).toBe('true')
    expect(candRows(wrapper)[1].attributes('aria-controls')).toBe(wrapper.get('.skills-browse-detail').attributes('id'))
    expect(wrapper.get('.skills-browse-detail').attributes('role')).toBe('region')
    expect(wrapper.get('.skills-detail-name').text()).toBe('docx')
    expect(wrapper.get('[data-test="skills-install"]').text()).toBe('Install docx')
    // Narrow, the skill takes the list's place: the class says which one shows.
    expect(wrapper.get('.skills-browse').classes()).toContain('viewing')
    // Another: the new one is read; one opened at a time.
    await candRows(wrapper)[0].trigger('click')
    await flushPromises()
    expect(calls.github.at(-1)).toEqual({ input: 'o/r', pick: 'skills/pdf', commit: 'c'.repeat(40) })
    expect(candRows(wrapper).map((r) => r.attributes('aria-current'))).toEqual(['true', undefined, undefined])
    expect(wrapper.findAll('.skills-preview')).toHaveLength(1)
    // A click on the one opened keeps it (nothing read again).
    const asked = calls.github.length
    await candRows(wrapper)[0].trigger('click')
    await flushPromises()
    expect(calls.github).toHaveLength(asked)
    expect(wrapper.get('.skills-detail-name').text()).toBe('pdf')
    // Back to the list.
    await wrapper.get('[data-test="skills-back"]').trigger('click')
    expect(wrapper.get('.skills-browse').classes()).not.toContain('viewing')
    expect(wrapper.get('.skills-detail-name').text()).toBe('pdf') // still opened (beside the list when wide)

    // Keyboard: arrows between the rows, right opens, Escape in the skill goes back on its row.
    candRows(wrapper)[0].element.focus()
    await candRows(wrapper)[0].trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(candRows(wrapper)[1].element)
    await candRows(wrapper)[1].trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(candRows(wrapper)[2].element)
    await candRows(wrapper)[2].trigger('keydown', { key: 'ArrowRight' })
    await flushPromises()
    expect(calls.github.at(-1)).toEqual({ input: 'o/r', pick: 'skills/xlsx', commit: 'c'.repeat(40) })
    await wrapper.get('[data-test="skills-read"]').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.get('.skills-browse').classes()).not.toContain('viewing')
    expect(document.activeElement).toBe(candRows(wrapper)[2].element)
    expect(wrapper.emitted('close')).toBeUndefined()
    wrapper.unmount()
  })

  it('a skill that cannot be read says so in its pane; a click tries again', async () => {
    let fail = true
    const { wrapper } = await openAdd({
      skillsFromGithub: async (q) => (!q.pick ? { repo: 'o/r', candidates: [{ path: 'a', name: 'a', files: 1, bytes: 1 }] } : fail ? { ok: false, error: 'GitHub answered 503.' } : { ...pkg, name: 'a' })
    })
    await lookUpRepo(wrapper, 'o/r')
    await candRows(wrapper)[0].trigger('click')
    await flushPromises()
    expect(wrapper.get('.skills-browse-detail .skills-add-error').text()).toBe('GitHub answered 503.')
    expect(wrapper.get('[data-test="skills-install"]').attributes('disabled')).toBeDefined()
    fail = false
    await candRows(wrapper)[0].trigger('click')
    await flushPromises()
    expect(wrapper.get('.skills-detail-name').text()).toBe('a')
    wrapper.unmount()
  })

  it('an answer for a skill clicked before another one is dropped', async () => {
    const answers = {}
    const candidates = [
      { path: 'a', name: 'a', files: 1, bytes: 1 },
      { path: 'b', name: 'b', files: 1, bytes: 1 }
    ]
    const { wrapper } = await openAdd({
      skillsFromGithub: (q) => (q.pick ? new Promise((resolve) => (answers[q.pick] = resolve)) : Promise.resolve({ repo: 'o/r', candidates }))
    })
    await lookUpRepo(wrapper, 'o/r')
    const rows = candRows(wrapper)
    await rows[0].trigger('click')
    expect(wrapper.get('.skills-browse-detail .skills-looking').text()).toBe('Loading…') // never the skill shown before
    await rows[1].trigger('click')
    answers.b({ ...pkg, name: 'b', id: 'b' })
    await flushPromises()
    answers.a({ ...pkg, name: 'a', id: 'a' })
    await flushPromises()
    expect(wrapper.get('[data-test="skills-install"]').text()).toBe('Install b')
    expect(wrapper.get('.skills-detail-name').text()).toBe('b')
    wrapper.unmount()
  })

  it('selection: a box per skill, one for all those shown, a filter; Install installs the ones selected in one go, each read at the commit of the list', async () => {
    const candidates = [
      { path: 'skills/pdf', name: 'pdf', description: 'PDF things.', files: 2, bytes: 2078 },
      { path: 'skills/docx', name: 'docx', description: 'Word documents.', files: 5, bytes: 40960 },
      { path: 'skills/doc-coauthoring', name: 'doc-coauthoring', description: 'Write documents together.', files: 1, bytes: 900 }
    ]
    let finish = null
    const { wrapper, calls } = await openAdd({
      skillsFromGithub: async (q) => {
        calls.github.push(q)
        return q.pick ? { ...pkg, name: q.pick.split('/').pop(), id: 'id-' + q.pick } : { repo: 'o/r', commit: 'c'.repeat(40), total: 3, candidates }
      },
      skillsInstall: async (q) => {
        calls.install.push(q)
        if (finish === null) await new Promise((resolve) => (finish = resolve))
        const name = q.id.split('/').pop()
        if (q.replace) return { ok: true, name, results: [{ dir: q.replace, ok: true, seenBy: ['codex'], agents: ['codex'] }] }
        return {
          ok: name !== 'docx',
          name,
          results: [
            { dir: `/h/.claude/skills/${name}`, ok: true, seenBy: ['claude'], agents: ['claude'] },
            name === 'docx'
              ? { dir: `/h/.agents/skills/${name}`, ok: false, exists: true, seenBy: ['codex'], agents: ['codex'] }
              : { dir: `/h/.agents/skills/${name}`, ok: true, seenBy: ['codex'], agents: ['codex'] }
          ]
        }
      }
    })
    await lookUpRepo(wrapper, 'o/r')
    const box = (name) => candOf(wrapper, name).get('.skills-check')
    const all = () => wrapper.get('[data-test="skills-select-all"]')
    // Boxes, not native checkboxes: buttons with role checkbox, named after their skill.
    expect(wrapper.find('.skills-add input[type="checkbox"]').exists()).toBe(false)
    expect(box('pdf').attributes('role')).toBe('checkbox')
    expect(box('pdf').attributes('aria-label')).toBe('Select pdf')
    expect(box('pdf').attributes('aria-checked')).toBe('false')
    await box('pdf').trigger('click')
    expect(box('pdf').attributes('aria-checked')).toBe('true')
    expect(candOf(wrapper, 'pdf').classes()).toContain('checked')
    expect(all().attributes('aria-checked')).toBe('mixed')
    expect(wrapper.get('.skills-browse-selected').text()).toBe('1 skill selected')
    // Selecting does not open: nothing read yet; Install already offers it.
    expect(calls.github).toHaveLength(1)
    expect(wrapper.get('[data-test="skills-install"]').text()).toBe('Install pdf')

    // The filter: by name, description or path; "all" means all those shown.
    await wrapper.get('[data-test="skills-filter"]').setValue('doc')
    expect(wrapper.findAll('.skills-cand .skills-row-name').map((n) => n.text())).toEqual(['docx', 'doc-coauthoring'])
    expect(wrapper.get('.skills-browse-shown').text()).toBe('2 of 3 skills')
    await all().trigger('click')
    expect(all().attributes('aria-checked')).toBe('true')
    await wrapper.get('[data-test="skills-filter"]').setValue('nothing like it')
    expect(wrapper.get('.skills-browse-note').text()).toBe('No skill matches.')
    expect(all().attributes('disabled')).toBeDefined()
    await wrapper.get('[data-test="skills-filter"]').setValue('')
    expect(all().attributes('aria-checked')).toBe('true')
    expect(wrapper.get('.skills-browse-selected').text()).toBe('3 skills selected')
    await all().trigger('click') // all of them again: none
    expect(wrapper.find('.skills-browse-selected').exists()).toBe(false)
    await box('pdf').trigger('click')
    await box('docx').trigger('click')

    // The skill opened can be selected from its pane too.
    await candRows(wrapper)[2].trigger('click')
    await flushPromises()
    const selectThis = wrapper.get('[data-test="skills-select-this"]')
    expect(selectThis.attributes('aria-checked')).toBe('false')
    await selectThis.trigger('click')
    expect(box('doc-coauthoring').attributes('aria-checked')).toBe('true')
    await wrapper.get('[data-test="skills-select-this"]').trigger('click')
    expect(box('doc-coauthoring').attributes('aria-checked')).toBe('false')

    // The bar: what is selected, for whom, where; one button for all of them.
    expect(wrapper.get('.skills-foot-summary').text()).toBe('2 skills selected · For Claude Code and Codex · All projects')
    expect(wrapper.get('[data-test="skills-install"]').text()).toBe('Install 2 skills')
    calls.github.length = 0
    await wrapper.get('.skills-actionbar').trigger('submit')
    await flushPromises()
    // One at a time, with its progress.
    expect(wrapper.get('[data-test="skills-install"]').text()).toBe('Installing 1 of 2…')
    expect(wrapper.get('.skills-add').attributes('aria-busy')).toBe('true')
    finish()
    await flushPromises()
    // Each one read again from the same commit, then installed with its own package.
    expect(calls.github).toEqual([
      { input: 'o/r', pick: 'skills/pdf', commit: 'c'.repeat(40) },
      { input: 'o/r', pick: 'skills/docx', commit: 'c'.repeat(40) }
    ])
    expect(calls.install.map((q) => [q.id, q.agents, q.scope])).toEqual([
      ['id-skills/pdf', ['claude', 'codex'], 'user'],
      ['id-skills/docx', ['claude', 'codex'], 'user']
    ])
    // The result: a line per skill, and under one not everywhere, its folders that did not take it.
    const results = wrapper.get('.skills-results')
    expect(results.get('.skills-results-head').text()).toBe('1 of 2 skills installed')
    const skills = results.findAll('.skills-result-skill')
    expect(skills.map((s) => [s.attributes('data-skill'), s.classes().find((c) => ['ok', 'exists', 'failed'].includes(c))])).toEqual([
      ['pdf', 'ok'],
      ['docx', 'exists']
    ])
    expect(skills[0].get('.skills-result-state').text()).toBe('Installed for Claude Code and Codex')
    expect(skills[0].findAll('.skills-result')).toHaveLength(0)
    expect(skills[1].get('.skills-result-skill-head .skills-result-state').text()).toBe('Already there for Codex')
    expect(skills[1].findAll('.skills-result').map((l) => l.attributes('data-dir'))).toEqual(['/h/.agents/skills/docx'])
    expect(wrapper.get('.mcp-notice').text()).toBe('Installed 1 skill for Claude Code and Codex. Agents use it from their next session.')
    // Replace it: that skill read again, installed in that folder only.
    calls.github.length = 0
    await skills[1].get('.skills-result button').trigger('click')
    await flushPromises()
    expect(calls.github).toEqual([{ input: 'o/r', pick: 'skills/docx', commit: 'c'.repeat(40) }])
    expect(calls.install.at(-1)).toMatchObject({ id: 'id-skills/docx', replace: '/h/.agents/skills/docx' })
    expect(wrapper.get('.skills-results-head').text()).toBe('2 of 2 skills installed')
    // Every skill everywhere: no Install left; View them in Installed.
    expect(wrapper.find('[data-test="skills-install"]').exists()).toBe(false)
    expect(wrapper.get('.skills-actionbar').exists()).toBe(true)
    expect(wrapper.get('[data-test="skills-view-installed"]').text()).toBe('View them in Installed')
    wrapper.unmount()
  })

  it('the real anthropics/skills: 20 skills listed, long descriptions cut, a big skill opened (96 files, the first ones listed) and installed', async () => {
    const real = JSON.parse(fs.readFileSync(join(process.cwd(), 'src/renderer/src/__tests__/fixtures/anthropicSkills.json'), 'utf8'))
    const big = real.packages['skills/claude-api']
    // A SKILL.md the size of claude-api's (about 100 KB): headings, a table, code.
    const section = (i) => `## Part ${i}\n\n| Model | Use |\n| --- | --- |\n| claude-${i} | the ${i}th |\n\n\`\`\`python\nclient.messages.create(model="m${i}")\n\`\`\`\n\nSome text about part ${i}. `.padEnd(700, 'x') + '\n'
    const skillMd = `---\nname: claude-api\ndescription: ${big.description}\nlicense: Complete terms in LICENSE.txt\n---\n\n# Claude API\n\n${Array.from({ length: 140 }, (_, i) => section(i)).join('\n')}`
    const bigPkg = {
      id: 'big',
      name: big.name,
      description: big.description,
      skillMd,
      files: big.files.map(([path, size]) => ({ path, size })),
      totalBytes: big.files.reduce((n, [, size]) => n + size, 0),
      scripts: big.scripts,
      setup: [],
      source: { kind: 'github', owner: 'anthropics', repo: 'skills', ref: null, path: 'skills/claude-api', commit: real.list.commit }
    }
    const { wrapper, calls } = await openAdd({
      skillsFromGithub: async (q) => (calls.github.push(q), q.pick ? bigPkg : real.list),
      skillsInstall: async (q) => (calls.install.push(q), { ok: true, name: 'claude-api', results: q.agents.map((a) => ({ dir: `/h/.${a}/skills/claude-api`, ok: true, seenBy: [a], agents: [a] })) })
    })
    await lookUpRepo(wrapper, 'anthropics/skills')
    expect(wrapper.get('.skills-source-what').text()).toBe('anthropics/skills @ dbd4588')
    expect(wrapper.get('.skills-source-count').text()).toBe('20 skills')
    // Every skill a row, its description whole in the DOM but on one line (CSS cuts it).
    expect(candRows(wrapper)).toHaveLength(20)
    expect(wrapper.findAll('.skills-cand .skills-row-name').map((n) => n.text())).toEqual(real.list.candidates.map((c) => c.name))
    expect(candOf(wrapper, 'canvas-design').get('.skills-row-size').text()).toBe('83 files, 5.3 MB')
    expect(candOf(wrapper, 'claude-api').get('.skills-row-size').text()).toBe('96 files, 2 MB')
    expect(candOf(wrapper, 'template-skill').get('.skills-row-size').text()).toBe('1 file, 140 B')
    const longest = real.list.candidates.reduce((a, c) => (c.description.length > a.description.length ? c : a))
    expect(longest.description.length).toBeGreaterThan(500)
    expect(candOf(wrapper, longest.name).get('.skills-row-desc').text()).toBe(longest.description)

    // claude-api opened: its description folded to a few lines, opened on a click.
    await candOf(wrapper, 'claude-api').get('.skills-row').trigger('click')
    await flushPromises()
    expect(calls.github.at(-1)).toEqual({ input: 'anthropics/skills', pick: 'skills/claude-api', commit: real.list.commit })
    const desc = wrapper.get('.skills-preview .skills-details-desc')
    expect(desc.classes()).toContain('clamped')
    await wrapper.get('.skills-desc-more').trigger('click')
    expect(wrapper.get('.skills-preview .skills-details-desc').classes()).not.toContain('clamped')
    expect(wrapper.get('.skills-desc-more').text()).toBe('Show less')
    // Its 96 files: the first 12, then all of them on a click, and fewer again.
    expect(wrapper.get('.skills-pv-files').text()).toBe('96 files, 2 MB')
    await wrapper.get('.skills-pv-files').trigger('click')
    expect(wrapper.findAll('.skills-files tr')).toHaveLength(12)
    expect(wrapper.get('[data-test="skills-files-all"]').text()).toBe('Show all 96 files')
    await wrapper.get('[data-test="skills-files-all"]').trigger('click')
    expect(wrapper.findAll('.skills-files tr')).toHaveLength(96)
    expect(wrapper.get('[data-test="skills-files-all"]').text()).toBe('Show fewer')
    // Its scripts said by their names, not their long paths.
    expect(wrapper.get('.skills-preview .skills-warn').text()).toContain('(build-report-lite.mjs, runner-scaffold.mjs')
    // Its 100 KB SKILL.md, formatted: every table and code block.
    await wrapper.get('[data-test="skills-read"]').trigger('click')
    expect(wrapper.findAll('.skills-md-view table')).toHaveLength(140)
    expect(wrapper.findAll('.skills-md-view pre')).toHaveLength(140)
    // Installed with the package shown.
    await submit(wrapper)
    expect(calls.install).toEqual([{ id: 'big', agents: ['claude', 'codex'], scope: 'user', cwd: '/p/artcraft', replace: null }])
    expect(wrapper.get('.skills-results-head').text()).toBe('2 of 2 done')
    wrapper.unmount()
  })

  it('agent chips: each one on or off, all or none; the shared folder said only when it matters; Install needs one', async () => {
    const agents = ['claude', 'codex', 'opencode', 'copilot'].map((id) => ({ id, available: true }))
    const { wrapper, calls } = await openAdd({}, { agents })
    await lookUpRepo(wrapper, 'o/r/skills/pdf')
    expect(wrapper.find('.skills-add input[type="checkbox"]').exists()).toBe(false)
    const group = wrapper.get('.skills-agent-chips')
    expect(group.attributes('role')).toBe('group')
    expect(wrapper.get(`#${group.attributes('aria-labelledby')}`).text()).toBe('Agents')
    expect(group.findAll('.skills-agent-chip').map((c) => c.text())).toEqual(['Claude Code', 'Codex', 'OpenCode', 'Copilot CLI'])
    expect(group.findAll('.skills-agent-chip').map((c) => c.attributes('title'))).toEqual(['Claude Code', 'Codex', 'OpenCode', 'Copilot CLI']) // narrow: icons only
    expect(group.findAll('.skills-agent-chip .brand-icon')).toHaveLength(4)
    expect(group.findAll('.skills-agent-chip').every((c) => c.attributes('aria-pressed') === 'true')).toBe(true) // the agents found
    // Codex chosen: its shared .agents folder is explained (a note beside the chips).
    const note = wrapper.get('.skills-shared-note')
    expect(note.attributes('title')).toBe('Codex gets it in the shared .agents folder, which OpenCode, Copilot CLI and Gemini CLI read too.')
    expect(note.attributes('aria-label')).toBe(note.attributes('title'))
    await chip(wrapper, 'codex').trigger('click')
    expect(chip(wrapper, 'codex').attributes('aria-pressed')).toBe('false')
    expect(chip(wrapper, 'codex').classes()).not.toContain('on')
    expect(wrapper.find('.skills-shared-note').exists()).toBe(false)
    expect(wrapper.get('.skills-foot-summary').text()).toBe('pdf · For 3 agents · All projects')

    const allOrNone = () => wrapper.get('[data-test="skills-agents-all"]')
    expect(allOrNone().text()).toBe('Select all')
    await allOrNone().trigger('click')
    expect(allOrNone().text()).toBe('Select none')
    await allOrNone().trigger('click')
    expect(group.findAll('.skills-agent-chip').every((c) => c.attributes('aria-pressed') === 'false')).toBe(true)
    expect(wrapper.get('.skills-info.warn').text()).toBe('Choose at least one agent.')
    expect(wrapper.get('[data-test="skills-install"]').attributes('disabled')).toBeDefined()
    await allOrNone().trigger('click')
    expect(group.findAll('.skills-agent-chip').every((c) => c.attributes('aria-pressed') === 'true')).toBe(true)
    await chip(wrapper, 'opencode').trigger('click')
    await chip(wrapper, 'copilot').trigger('click')
    expect(wrapper.get('.skills-foot-summary').text()).toBe('pdf · For Claude Code and Codex · All projects')
    await submit(wrapper)
    expect(calls.install[0]).toMatchObject({ agents: ['claude', 'codex'], scope: 'user' })

    // The choice is kept for the next skill looked up.
    await lookUpRepo(wrapper, 'o/r/skills/pdf')
    expect(chip(wrapper, 'opencode').attributes('aria-pressed')).toBe('false')
    wrapper.unmount()
  })

  it('an agent not found on this computer is offered, marked as such', async () => {
    const { wrapper } = await openAdd({}, { agents: [{ id: 'claude', available: true }] })
    await lookUpRepo(wrapper, 'o/r/skills/pdf')
    // Codex is always offered; not found here, it starts off and says so.
    expect(chip(wrapper, 'codex').classes()).toContain('missing')
    expect(chip(wrapper, 'codex').attributes('aria-pressed')).toBe('false')
    expect(chip(wrapper, 'codex').attributes('aria-label')).toBe('Codex (not found on this computer)')
    wrapper.unmount()
  })

  it('scope: All projects or this project, named; this project only with a project open', async () => {
    const { wrapper, calls } = await openAdd()
    await lookUpRepo(wrapper, 'o/r/skills/pdf')
    const opt = (s) => wrapper.get(`.skills-scope-opt[data-scope="${s}"]`)
    expect(wrapper.get(`#${wrapper.get('.skills-scopes').attributes('aria-labelledby')}`).text()).toBe('Use it in')
    expect(opt('user').attributes('aria-pressed')).toBe('true')
    expect(opt('project').text()).toContain('This project')
    expect(opt('project').get('.skills-scope-sub').text()).toBe('artcraft')
    expect(opt('project').attributes('title')).toBe('/p/artcraft')
    await opt('project').trigger('click')
    expect(opt('project').attributes('aria-pressed')).toBe('true')
    expect(opt('user').attributes('aria-pressed')).toBe('false')
    // In a project, Codex shares the project's .agents with the Antigravity CLI.
    expect(wrapper.get('.skills-shared-note').attributes('title')).toContain("project's shared .agents folder")
    expect(wrapper.get('.skills-foot-summary').text()).toBe('pdf · For Claude Code and Codex · This project')
    await submit(wrapper)
    expect(calls.install[0]).toMatchObject({ scope: 'project', cwd: '/p/artcraft' })
    wrapper.unmount()

    // No project open (or a remote one): this project cannot be chosen.
    for (const cwd of [null, 'ssh://host/p']) {
      const other = await openAdd({}, { cwd })
      await lookUpRepo(other.wrapper, 'o/r/skills/pdf')
      const project = other.wrapper.get('.skills-scope-opt[data-scope="project"]')
      expect(project.attributes('disabled')).toBeDefined()
      expect(project.get('.skills-scope-sub').text()).toBe('No project open')
      expect(project.attributes('title')).toBe('Open a project folder to add it to one project only')
      other.wrapper.unmount()
    }
  })

  it('the instructions: formatted, the front matter as key/value pairs; or as source; no raw HTML, no image, links outside', async () => {
    const md = [
      '---',
      'name: pdf',
      'description: >',
      '  Fill PDF forms',
      '  and merge files.',
      'allowed-tools:',
      '  - Read',
      '  - Bash',
      '---',
      '# PDF skill',
      '',
      'Use **pdftk** <script>alert(1)</script> <b onclick="x()">raw</b>.',
      '',
      '![logo](https://tracker.example/pixel.png)',
      '',
      'See [the docs](https://example.com/docs) or [a file](notes.md).'
    ].join('\n')
    const opened = []
    const { wrapper } = await openAdd({ skillsFromGithub: async () => ({ ...pkg, skillMd: md }), openExternal: (url) => opened.push(url) })
    await lookUpRepo(wrapper, 'o/r/skills/pdf')
    // Closed at first: a long SKILL.md does not fill the page.
    expect(wrapper.find('.skills-md-box').exists()).toBe(false)
    const read = wrapper.get('[data-test="skills-read"]')
    expect(read.text()).toBe('Read the instructions')
    expect(read.attributes('aria-expanded')).toBe('false')
    await read.trigger('click')
    expect(read.attributes('aria-expanded')).toBe('true')
    expect(read.text()).toBe('Hide the instructions')
    expect(read.attributes('aria-controls')).toBe(wrapper.get('.skills-md-box').attributes('id'))

    const fm = wrapper.get('.skills-fm')
    expect(fm.findAll('dt').map((d) => d.text())).toEqual(['name', 'description', 'allowed-tools'])
    expect(fm.findAll('dd').map((d) => d.text())).toEqual(['pdf', 'Fill PDF forms and merge files.', 'Read, Bash'])
    const view = wrapper.get('.skills-md-view')
    expect(view.get('h1').text()).toBe('PDF skill')
    expect(view.get('strong').text()).toBe('pdftk')
    expect(view.text()).not.toContain('name: pdf') // the front matter is not shown twice
    // Raw HTML is shown as text, never run; the image is not loaded.
    expect(view.find('script').exists()).toBe(false)
    expect(view.find('b').exists()).toBe(false)
    expect(view.text()).toContain('<script>alert(1)</script>')
    expect(view.get('img').attributes('src')).toBeUndefined()
    expect(view.get('img').attributes('alt')).toBe('logo')
    // A web link opens in the browser; another link does nothing here.
    const links = view.findAll('a')
    await links[0].trigger('click')
    await links[1].trigger('click')
    expect(opened).toEqual(['https://example.com/docs'])

    // View source: the file as it is.
    const toggle = wrapper.get('[data-test="skills-source-toggle"]')
    expect(toggle.text()).toBe('View source')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-pressed')).toBe('true')
    expect(toggle.text()).toBe('View formatted')
    expect(wrapper.find('.skills-md-view').exists()).toBe(false)
    expect(wrapper.get('pre.skills-md').text()).toBe(md)
    await toggle.trigger('click')
    expect(wrapper.find('.skills-md-view').exists()).toBe(true)
    wrapper.unmount()
  })

  it('the result per agent: installed, already there (Replace it), failed with its reason; then View it in Installed', async () => {
    const results = [
      { dir: '/h/.claude/skills/pdf', ok: true, seenBy: ['claude', 'opencode', 'copilot'], agents: ['claude'] },
      { dir: '/h/.agents/skills/pdf', ok: false, exists: true, error: 'A skill with this name is already there.', seenBy: ['codex', 'opencode', 'copilot', 'gemini'], agents: ['codex'] },
      { dir: '/h/.config/opencode/skills/pdf', ok: false, error: 'EPERM: operation not permitted', seenBy: ['opencode'], agents: ['opencode'] }
    ]
    const agents = ['claude', 'codex', 'opencode'].map((id) => ({ id, available: true }))
    let installs = 0
    const { wrapper, calls } = await openAdd(
      {
        skillsInstall: async (q) => {
          calls.install.push(q)
          installs++
          if (q.replace) return { ok: true, name: 'pdf', results: [{ dir: q.replace, ok: true, seenBy: ['codex'], agents: ['codex'] }] }
          return { ok: false, name: 'pdf', results }
        }
      },
      { agents }
    )
    await lookUpRepo(wrapper, 'o/r/skills/pdf')
    await wrapper.get('.skills-actionbar').trigger('submit')
    await flushPromises()
    const box = wrapper.get('.skills-results')
    expect(box.attributes('aria-live')).toBe('polite')
    expect(box.get('.skills-results-head').text()).toBe('1 of 3 done')
    const lines = () => wrapper.findAll('.skills-result')
    expect(lines().map((l) => l.classes().find((c) => ['ok', 'exists', 'failed'].includes(c)))).toEqual(['ok', 'exists', 'failed'])
    expect(lines().map((l) => l.get('.skills-result-agents').text())).toEqual(['Claude Code', 'Codex', 'OpenCode'])
    expect(lines().map((l) => l.get('.skills-result-state').text())).toEqual(['Installed', 'Already there', 'Failed'])
    expect(lines()[0].text()).toContain('Also seen by OpenCode') // OpenCode reads Claude's folder
    expect(lines()[2].get('.skills-result-error').text()).toBe('EPERM: operation not permitted')
    expect(lines()[1].text()).toContain('already in this folder')
    // Not every folder has it: Install stays; the one already there can be replaced.
    expect(wrapper.find('[data-test="skills-install"]').exists()).toBe(true)
    await lines()[1].get('button').trigger('click')
    await flushPromises()
    expect(calls.install[1]).toMatchObject({ replace: '/h/.agents/skills/pdf' })
    expect(lines().map((l) => l.get('.skills-result-state').text())).toEqual(['Installed', 'Installed', 'Failed'])
    expect(installs).toBe(2)

    // View it in Installed: that tab, the skill open and focused.
    await wrapper.get('[data-test="skills-view-installed"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.skills-add').exists()).toBe(false)
    const row = rowOf(wrapper, 'pdf')
    expect(row.get('.skills-row').attributes('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(row.get('.skills-row').element)
    wrapper.unmount()
  })

  it('every folder has it: no Install button left; another choice brings it back; Add another skill starts again', async () => {
    const { wrapper } = await openAdd({
      skillsInstall: async (q) => ({ ok: true, name: 'pdf', results: q.agents.map((a) => ({ dir: `/h/.${a}/skills/pdf`, ok: true, seenBy: [a], agents: [a] })) })
    })
    await lookUpRepo(wrapper, 'o/r/skills/pdf')
    await wrapper.get('.skills-actionbar').trigger('submit')
    await flushPromises()
    expect(wrapper.get('.skills-results-head').text()).toBe('2 of 2 done')
    expect(wrapper.find('[data-test="skills-install"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-test="skills-view-installed"]').element) // not lost with the button
    expect(wrapper.find('.skills-actionbar').exists()).toBe(true) // the bar stays
    expect(wrapper.get('.mcp-notice').text()).toBe('Installed "pdf" for Claude Code and Codex. Agents use it from their next session.')
    await chip(wrapper, 'codex').trigger('click')
    expect(wrapper.find('[data-test="skills-install"]').exists()).toBe(true)
    await wrapper.findAll('.skills-results-foot .skills-link').find((b) => b.text() === 'Add another skill').trigger('click')
    await flushPromises()
    expect(wrapper.find('.skills-source-bar').exists()).toBe(true)
    expect(wrapper.find('.skills-browse').exists()).toBe(false)
    expect(wrapper.get('[data-test="skills-repo"]').element.value).toBe('')
    expect(document.activeElement).toBe(wrapper.get('[data-test="skills-repo"]').element)
    wrapper.unmount()
  })

  it('a progress state while it installs', async () => {
    let finish
    const { wrapper } = await openAdd({ skillsInstall: () => new Promise((resolve) => (finish = resolve)) })
    await lookUpRepo(wrapper, 'o/r/skills/pdf')
    await wrapper.get('.skills-actionbar').trigger('submit')
    await flushPromises()
    const button = wrapper.get('[data-test="skills-install"]')
    expect(button.text()).toBe('Installing…')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.find('.skills-spinner').exists()).toBe(true)
    expect(wrapper.get('.skills-add').attributes('aria-busy')).toBe('true')
    finish({ ok: true, name: 'pdf', results: [{ dir: '/h/.claude/skills/pdf', ok: true, seenBy: ['claude'], agents: ['claude'] }] })
    await flushPromises()
    expect(wrapper.get('.skills-add').attributes('aria-busy')).toBeUndefined()
    wrapper.unmount()
  })

  it('from a folder: chosen with the picker, its path shown, previewed and installed', async () => {
    const folderPkg = { ...pkg, id: 'f1', name: 'pdf-forms', source: { kind: 'folder', path: 'C:\\Users\\me\\skills\\pdf-forms' } }
    const picked = []
    const { wrapper, calls } = await openAdd({
      skillsList: async () => ({ roots: [], skills: [], home: 'C:\\Users\\me' }),
      pickFolder: async (o) => (picked.push(o), 'C:\\Users\\me\\skills\\pdf-forms'),
      skillsFromFolder: async (dir) => (calls.github.push({ folder: dir }), folderPkg)
    })
    await wrapper.get('.skills-source[data-source="folder"]').trigger('click')
    expect(wrapper.get('.skills-source[data-source="folder"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-test="skills-repo"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('A folder with a SKILL.md at its top')
    await wrapper.get('[data-test="skills-choose-folder"]').trigger('click')
    await flushPromises()
    expect(picked[0]).toMatchObject({ defaultPath: '/p/artcraft' })
    expect(calls.github).toEqual([{ folder: 'C:\\Users\\me\\skills\\pdf-forms' }])
    expect(wrapper.get('.skills-source-what').text()).toBe('~\\skills\\pdf-forms')
    expect(wrapper.get('.skills-source-what').attributes('title')).toBe('From a folder: C:\\Users\\me\\skills\\pdf-forms')
    expect(wrapper.get('.skills-pv-source').text()).toBe('~\\skills\\pdf-forms')
    expect(wrapper.get('.skills-pv-meta .skills-origin').text()).toBe('Folder')
    await wrapper.get('.skills-actionbar').trigger('submit')
    await flushPromises()
    expect(calls.install[0]).toMatchObject({ id: 'f1', agents: ['claude', 'codex'] })
    wrapper.unmount()
  })

  it('Add tab: one line per label and button; two panes when there is room; the install bar stays in view', () => {
    const css = fs.readFileSync(join(process.cwd(), 'src/renderer/src/components/SkillsDialog.vue'), 'utf8').replace(/\r\n/g, '\n')
    const rule = (sel) => {
      const at = css.indexOf(`\n${sel} {`)
      return at < 0 ? '' : css.slice(at, css.indexOf('}', at))
    }
    for (const sel of ['.skills-source', '.skills-agent-chip', '.skills-field-label', '.skills-step-title', '.skills-scope-title', '.skills-result-state'])
      expect(rule(sel), sel).toContain('white-space: nowrap')
    for (const sel of ['.skills-source', '.skills-agent-chip']) expect(rule(sel), sel).toContain('flex: 0 0 auto')
    expect(rule('.skills-agent-chips')).toContain('flex-wrap: wrap')
    expect(rule('.skills-field-input')).toContain('min-width: 0')
    expect(rule('.skills-add')).toContain('container-type: inline-size')
    expect(rule('.skills-add')).toContain('container-name: skills-add')
    // A row's description on one line, cut; the skill's own folded to a few lines.
    expect(rule('.skills-row-desc')).toContain('white-space: nowrap')
    expect(rule('.skills-row-desc')).toContain('text-overflow: ellipsis')
    expect(rule('.skills-details-desc.clamped')).toContain('-webkit-line-clamp')
    // Side by side from 760 px (each pane scrolling on its own, as high as the
    // window allows); one at a time under it; a compact bar under 620 px.
    const wide = css.slice(css.indexOf('@container skills-add (min-width: 760px)'))
    expect(wide).toContain('grid-template-columns')
    expect(wide.slice(0, wide.indexOf('\n}\n'))).toMatch(/height: clamp\(.*100vh/)
    expect(css).toContain('@container skills-add (max-width: 759px)')
    expect(css).toContain('@container skills-add (max-width: 620px)')
    // The bar sticks to the bottom of what scrolls.
    expect(rule('.skills-actionbar')).toContain('position: sticky')
    expect(rule('.skills-actionbar')).toContain('bottom: 0')
  })

  it('speaks French: the Add tab', async () => {
    setMessages('fr', fr)
    const { wrapper } = await openAdd({
      skillsInstall: async () => ({ ok: false, name: 'pdf', results: [{ dir: '/h/.agents/skills/pdf', ok: false, exists: true, seenBy: ['codex'], agents: ['codex'] }] })
    })
    expect(wrapper.get('.skills-source-bar').attributes('aria-label')).toBe("D'où elle vient")
    expect(wrapper.get('.skills-source[data-source="folder"]').text()).toBe('Dossier')
    expect(wrapper.get('[data-test="skills-look"]').text()).toBe('Rechercher')
    expect(wrapper.get('.skills-source-foot .set-hint').text()).toBe('Essayer :')
    expect(wrapper.get('[data-test="skills-install"]').text()).toBe('Installer')
    expect(wrapper.get('.skills-foot-summary').text()).toBe('Recherchez un dépôt ou choisissez un dossier')
    await lookUpRepo(wrapper, 'o/r/skills/pdf')
    expect(wrapper.get('[data-test="skills-change-source"]').text()).toBe('Changer de source')
    expect(wrapper.get('[data-test="skills-read"]').text()).toBe('Lire les instructions')
    expect(wrapper.get('.skills-pv-files').text()).toBe('2 fichiers, 2 Ko')
    expect(wrapper.findAll('.skills-field-label').map((l) => l.text())).toEqual(['Agents', "L'utiliser dans"])
    expect(wrapper.get('[data-test="skills-agents-all"]').text()).toBe('Tout désélectionner')
    expect(wrapper.get('.skills-foot-summary').text()).toBe('pdf · Pour Claude Code et Codex · Tous les projets')
    expect(wrapper.get('[data-test="skills-install"]').text()).toBe('Installer pdf')
    await wrapper.get('[data-test="skills-read"]').trigger('click')
    expect(wrapper.get('[data-test="skills-source-toggle"]').text()).toBe('Voir la source')
    await wrapper.get('.skills-actionbar').trigger('submit')
    await flushPromises()
    expect(wrapper.get('.skills-results-head').text()).toBe('Terminé : 0 sur 1')
    expect(wrapper.get('.skills-result-state').text()).toBe('Déjà présente')
    expect(wrapper.get('.skills-result button').text()).toBe('La remplacer')
    expect(wrapper.get('[data-test="skills-view-installed"]').text()).toBe('La voir dans Installées')
    wrapper.unmount()
  })

  it('Update shows the new version, then replaces that copy only', async () => {
    const calls = api({
      skillsInstall: async (q) => (calls.install.push(q), { ok: true, name: 'pdf', results: [{ dir: q.replace, ok: true, seenBy: ['claude'], agents: ['claude'] }] })
    })
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    await open(wrapper, 'pdf')
    await button(copyOf(wrapper, '/h/.claude/skills/pdf'), 'Update').trigger('click')
    await flushPromises()
    // What is updated instead of a source; the new version to read; no agents or scope to choose.
    expect(wrapper.findAll('.skills-add .skills-step-title').map((s) => s.text())).toEqual(['Update pdf'])
    expect(wrapper.find('.skills-source-bar').exists()).toBe(false)
    expect(wrapper.find('.skills-browse-list').exists()).toBe(false)
    expect(wrapper.get('.skills-detail-name').text()).toBe('pdf')
    expect(wrapper.get('.skills-updating .skills-path').attributes('title')).toBe('/h/.claude/skills/pdf')
    expect(wrapper.find('[data-test="skills-read"]').exists()).toBe(true)
    expect(wrapper.find('.skills-agent-chips').exists()).toBe(false)
    expect(wrapper.find('.skills-scopes').exists()).toBe(false)
    expect(wrapper.get('.skills-foot-summary').text()).toBe('Replaces the copy in /h/.claude/skills/pdf')
    expect(wrapper.get('[data-test="skills-install"]').text()).toBe('Update pdf')
    await wrapper.get('.skills-actionbar').trigger('submit')
    await flushPromises()
    expect(calls.install[0]).toMatchObject({ id: 'p1', replace: '/h/.claude/skills/pdf' })
    // Done: its result, no button left, and the way back to the list.
    expect(wrapper.find('[data-test="skills-install"]').exists()).toBe(false)
    expect(wrapper.get('.skills-result-state').text()).toBe('Installed')
    await wrapper.findAll('.skills-link').find((b) => b.text() === 'Back to the list').trigger('click')
    expect(wrapper.find('.skills-add').exists()).toBe(false)
    expect(wrapper.find('.skills-search').exists()).toBe(true)
    // The Add tab again: a fresh start, not the finished update.
    await wrapper.get('[data-test="skills-tab-add"]').trigger('click')
    expect(wrapper.find('.skills-source-bar').exists()).toBe(true)
    expect(wrapper.find('.skills-updating').exists()).toBe(false)
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
    expect(wrapper.find('input.skills-field-input').exists()).toBe(true)
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
    await wrapper.find('.skills-actionbar').trigger('submit')
    await flushPromises()
    expect(asked[0]).toMatchObject({ confirmLabel: 'Update anyway', danger: true })
    expect(calls.install).toHaveLength(0) // declined
    await wrapper.find('.skills-actionbar').trigger('submit')
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
    await wrapper.find('.skills-actionbar').trigger('submit')
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

  it('Antigravity plugins: only with the Antigravity CLI installed; one row each, details on a click: turn off, uninstall; installed in a pane', async () => {
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
    // The same list as the skills: a row each, a count above it.
    expect(wrapper.get('.skills-count').text()).toBe('2 plugins')
    expect(wrapper.get('.skills-list').attributes('aria-label')).toBe('Installed plugins')
    const row = (name) => wrapper.get(`[data-test="agy-plugin-${name}"]`)
    expect(row('figma').get('.skills-row-name').text()).toBe('figma')
    expect(row('figma').get('.skills-scope').text()).toBe('1.2.0')
    expect(row('figma').get('.skills-row-desc').text()).toBe('2 skills · 1 MCP server')
    expect(row('old-kit').get('.skills-off').text()).toBe('Turned off')
    expect(row('old-kit').get('.skills-row-desc').text()).toBe('From antigravity')
    expect(wrapper.find('.skills-details').exists()).toBe(false)

    // Keyboard: arrows between rows, right opens, Escape closes (back on the row).
    const rows = () => wrapper.findAll('.skills-list .skills-row')
    rows()[0].element.focus()
    await rows()[0].trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows()[1].element)
    await rows()[1].trigger('keydown', { key: 'ArrowRight' })
    expect(rows()[1].attributes('aria-expanded')).toBe('true')
    await row('old-kit').get('[data-test="agy-plugin-toggle"]').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(rows()[1].attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(rows()[1].element)
    expect(wrapper.emitted('close')).toBeUndefined()

    // Its details: where it comes from, what it brings, turn off, uninstall.
    await row('figma').get('.skills-row').trigger('click')
    const details = row('figma').get('.skills-details')
    expect(row('figma').get('.skills-row').attributes('aria-expanded')).toBe('true')
    expect(details.attributes('role')).toBe('region')
    expect(details.attributes('aria-labelledby')).toBe(row('figma').get('.skills-row').attributes('id'))
    expect(details.text()).toContain('From antigravity-plugins-official')
    expect(details.findAll('.skills-plugin-parts .skills-tag').map((t) => t.text())).toEqual(['2 skills', '1 MCP server'])
    expect(details.text()).toContain('On: Antigravity CLI panes load it when they start.')
    await details.get('[data-test="agy-plugin-toggle"]').trigger('click')
    await flushPromises()
    expect(calls.set).toEqual([{ name: 'figma', enabled: false }])
    expect(row('figma').get('.skills-off').text()).toBe('Turned off')
    expect(row('figma').get('[data-test="agy-plugin-toggle"]').text()).toBe('Turn on')
    await row('old-kit').get('.skills-row').trigger('click')
    expect(row('figma').find('.skills-details').exists()).toBe(false) // one open at a time
    expect(row('old-kit').get('.skills-details').text()).toContain('Nothing listed in it.')
    await row('old-kit').get('[data-test="agy-plugin-remove"]').trigger('click')
    await flushPromises()
    expect(calls.rm).toEqual([{ name: 'old-kit' }])
    expect(wrapper.find('[data-test="agy-plugin-old-kit"]').exists()).toBe(false)
    expect(wrapper.get('.skills-count').text()).toBe('1 plugin')

    // Installing runs in a pane the user sees; nothing a shell would read as more.
    await wrapper.get('[data-test="agy-plugin-target"]').setValue('figma@antigravity-plugins-official')
    await wrapper.get('form.skills-plugin-form').trigger('submit')
    expect(wrapper.emitted('run').at(-1)[0].command).toBe('agy plugin install "figma@antigravity-plugins-official"')
    await wrapper.get('[data-test="agy-plugin-target"]').setValue('x; rm -rf /')
    await wrapper.get('form.skills-plugin-form').trigger('submit')
    expect(wrapper.emitted('run')).toHaveLength(1)
    expect(wrapper.get('.skills-add-error').attributes('role')).toBe('alert')
    expect(wrapper.get('.skills-add-error').text()).toContain('Enter a plugin name')
    expect(wrapper.get('[data-test="agy-plugin-target"]').attributes('aria-invalid')).toBe('true')
    expect(wrapper.get('[data-test="agy-plugin-target"]').attributes('aria-label')).toBe('Plugin name or folder')
    wrapper.unmount()
  })

  it('Antigravity plugins: loading, then none', async () => {
    let answer
    api({ agyPluginsList: () => new Promise((resolve) => (answer = resolve)) })
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'antigravity', available: true }] }, attachTo: document.body })
    await flushPromises()
    await wrapper.get('[data-test="skills-tab-plugins"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.skills-skeleton')).toHaveLength(2)
    expect(wrapper.get('.skills-count').text()).toBe('Loading…')
    answer({ plugins: [] })
    await flushPromises()
    expect(wrapper.find('.skills-skeleton').exists()).toBe(false)
    expect(wrapper.get('.mcp-empty').text()).toBe('No Antigravity CLI plugins installed.')
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
    expect(wrapper.get('.skills-count').text()).toBe('1 plugin')
    await wrapper.get('[data-test="agy-plugin-figma"] .skills-row').trigger('click')
    expect(wrapper.get('[data-test="agy-plugin-toggle"]').text()).toBe('Activer')
    expect(wrapper.get('[data-test="agy-plugin-remove"]').text()).toBe('Désinstaller')
    expect(wrapper.get('.skills-plugin-state').text()).toBe('Désactivé : les panneaux Antigravity CLI ne le chargent pas.')
    wrapper.unmount()
  })

  it("Muse plugins: a tab of their own beside Antigravity's; listed, turned on, uninstalled, installed in a pane with muse's own command", async () => {
    const calls = api()
    calls.set = []
    calls.rm = []
    let list = [
      { name: 'weather', label: 'Weather', enabled: false, version: '0.1.0', source: 'native-local', counts: { skills: 1, commands: 1, hooks: 1 } },
      { name: 'docs-kit', label: '', enabled: true, version: '2.0.0', source: 'marketplace-user-added', counts: { mcpServers: 2 } }
    ]
    Object.assign(window.shellApi, {
      agyPluginsList: async () => ({ plugins: [] }),
      agyPluginsSet: async () => ({ ok: true }),
      agyPluginsRemove: async () => ({ ok: true }),
      musePluginsList: async () => ({ plugins: list }),
      musePluginsSet: async (q) => {
        calls.set.push(q)
        list = list.map((p) => (p.name === q.name ? { ...p, enabled: q.enabled } : p))
        return { ok: true }
      },
      musePluginsRemove: async (q) => {
        calls.rm.push(q)
        list = list.filter((p) => p.name !== q.name)
        return { ok: true }
      }
    })
    list[0].description = 'A forecast skill.'
    const agents = [{ id: 'antigravity', available: true }, { id: 'muse', available: true }]
    const wrapper = mount(SkillsDialog, { props: { agents }, attachTo: document.body, global: { provide: { askConfirm: () => Promise.resolve(true) } } })
    await flushPromises()
    expect(wrapper.get('[data-test="skills-tab-plugins"]').text()).toBe('Antigravity plugins')
    expect(wrapper.get('[data-test="skills-tab-muse-plugins"]').text()).toBe('Muse plugins')
    await wrapper.get('[data-test="skills-tab-muse-plugins"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="skills-tab-muse-plugins"]').classes()).toContain('on')
    expect(wrapper.get('[data-test="skills-tab-plugins"]').classes()).not.toContain('on')
    expect(wrapper.text()).toContain('Muse Code plugins bundle skills, commands, hooks and MCP servers.')
    // The same list as Antigravity's: a row each, a count above it.
    expect(wrapper.get('.skills-count').text()).toBe('2 plugins')
    const row = (name) => wrapper.get(`[data-test="muse-plugin-${name}"]`)
    expect(row('weather').get('.skills-row-name').text()).toBe('Weather')
    expect(row('weather').get('.skills-row-desc').text()).toBe('1 skill · hooks · 1 command')
    expect(row('weather').get('.skills-off').text()).toBe('Turned off')
    expect(row('docs-kit').get('.skills-row-name').text()).toBe('docs-kit')
    // Its details: its description, its words, turn on, uninstall.
    await row('weather').get('.skills-row').trigger('click')
    const details = row('weather').get('.skills-details')
    expect(details.text()).toContain('A forecast skill.')
    expect(details.text()).toContain('Installed from a folder')
    expect(details.text()).toContain('Off: Muse Code panes do not load it.')
    await details.get('[data-test="muse-plugin-toggle"]').trigger('click')
    await flushPromises()
    expect(calls.set).toEqual([{ name: 'weather', enabled: true }])
    expect(wrapper.text()).toContain('Turned on "weather". Muse Code panes use the change from their next start.')
    await row('docs-kit').get('.skills-row').trigger('click')
    await row('docs-kit').get('[data-test="muse-plugin-remove"]').trigger('click')
    await flushPromises()
    expect(calls.rm).toEqual([{ name: 'docs-kit' }])
    expect(wrapper.find('[data-test="muse-plugin-docs-kit"]').exists()).toBe(false)
    // Installing: muse's own command, in a pane the user sees.
    await wrapper.get('[data-test="muse-plugin-target"]').setValue('weather@local')
    await wrapper.get('form.skills-plugin-form').trigger('submit')
    expect(wrapper.emitted('run').at(-1)[0]).toEqual({ label: 'Muse plugin: weather@local', command: 'muse plugins install "weather@local"' })
    // Back to Antigravity's tab: its own list again.
    await wrapper.get('[data-test="skills-tab-plugins"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="muse-plugin-weather"]').exists()).toBe(false)
    expect(wrapper.get('.mcp-empty').text()).toBe('No Antigravity CLI plugins installed.')
    wrapper.unmount()
  })

  it('Muse plugins: French', async () => {
    api({ musePluginsList: async () => ({ plugins: [{ name: 'weather', enabled: false, version: '0.1.0', source: 'x', counts: { skills: 1 } }] }), musePluginsSet: async () => ({ ok: true }), musePluginsRemove: async () => ({ ok: true }) })
    setMessages('fr', fr)
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'muse', available: true }] }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('[data-test="skills-tab-plugins"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="skills-tab-muse-plugins"]').text()).toBe('Plugins Muse')
    await wrapper.get('[data-test="skills-tab-muse-plugins"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="muse-plugin-weather"]').text()).toContain('Désactivé')
    expect(wrapper.text()).toContain('Les plugins de Muse Code')
    await wrapper.get('[data-test="muse-plugin-weather"] .skills-row').trigger('click')
    expect(wrapper.get('[data-test="muse-plugin-toggle"]').text()).toBe('Activer')
    expect(wrapper.get('.skills-plugin-state').text()).toBe('Désactivé : les panneaux Muse Code ne le chargent pas.')
    wrapper.unmount()
  })
})
