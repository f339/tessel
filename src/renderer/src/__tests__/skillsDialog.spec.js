import { afterEach, describe, expect, it } from 'vitest'
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

describe('Skills dialog', () => {
  let previousApi
  afterEach(() => {
    window.shellApi = previousApi
    setMessages('en', {})
  })

  function api(over = {}) {
    previousApi = window.shellApi
    const calls = { install: [], remove: [], github: [] }
    window.shellApi = {
      skillsList: async () => ({
        roots: [],
        skills: [
          skill({ dir: '/h/.claude/skills/pdf', source: { kind: 'github', owner: 'o', repo: 'r', path: 'skills/pdf' } }),
          skill({ dir: '/p/.agents/skills/pdf', scope: 'project', seenBy: ['codex', 'opencode', 'copilot', 'gemini'] }),
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
      skillsOpen: async () => ({ ok: true }),
      ...over
    }
    return calls
  }

  it('lists each skill once with its copies: agents, scope, path; only the user\'s own can be removed', async () => {
    api()
    const agents = ['claude', 'codex'].map((id) => ({ id, available: true }))
    const wrapper = mount(SkillsDialog, { props: { agents, cwd: '/p' }, attachTo: document.body })
    await flushPromises()
    const rows = wrapper.findAll('.mcp-server')
    expect(rows.map((r) => r.find('.mcp-name').text())).toEqual(['docx', 'pdf'])
    const pdf = rows[1]
    const copies = pdf.findAll('.skills-copy')
    expect(copies).toHaveLength(2)
    expect(copies[0].text()).toContain('Seen by Claude Code')
    expect(copies[0].text()).toContain('All projects')
    expect(copies[0].text()).toContain('/h/.claude/skills/pdf')
    expect(copies[0].text()).toContain('Update') // added from GitHub
    expect(copies[1].text()).toContain('This project')
    expect(copies[1].text()).toContain('Codex')
    expect(copies[1].text()).not.toContain('Update')
    const docx = rows[0]
    expect(docx.text()).toContain('Synced from your Claude account')
    expect(docx.find('.danger').exists()).toBe(false)
    wrapper.unmount()
  })

  it('removes to the Recycle Bin, or deletes after a second confirmation', async () => {
    const calls = api()
    const answers = [true, 'alt', true]
    const asked = []
    const wrapper = mount(SkillsDialog, {
      props: { agents: [{ id: 'claude', available: true }] },
      global: { provide: { askConfirm: (o) => (asked.push(o), Promise.resolve(answers.shift())) } },
      attachTo: document.body
    })
    await flushPromises()
    const removeBtn = () => wrapper.findAll('.skills-copy')[1].find('.danger')
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
    await wrapper.findAll('.skills-copy')[1].findAll('.exit-btn').find((b) => b.text() === 'Update').trigger('click')
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

  it('says where each copy comes from, if it was edited, and if GitHub has an update', async () => {
    api({ skillsList: async () => ({ roots: [], skills: tracked() }) })
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }, { id: 'codex', available: true }] }, attachTo: document.body })
    await flushPromises()
    const row = (name) => wrapper.findAll('.mcp-server').find((r) => r.find('.mcp-name').text() === name)
    expect(row('mine').find('.skills-origin').text()).toBe('Your skill')
    expect(row('mine').find('.skills-origin').classes()).toContain('origin-own')
    expect(row('pdf').find('.skills-origin').text()).toBe('From GitHub — o/r')
    expect(row('pdf').find('.skills-origin').attributes('title')).toContain('o/r/skills/pdf @ aaaaaaa')
    expect(row('copied').find('.skills-origin').text()).toBe('Copied from a folder')
    expect(row('docx').find('.skills-origin').exists()).toBe(false) // the agent's own
    expect(row('pdf').find('.skills-modified').text()).toBe('Modified locally')
    expect(row('mine').find('.skills-modified').exists()).toBe(false)
    expect(row('pdf').find('.skills-update').text()).toBe('Update available')
    expect(row('pdf').find('.skills-update').attributes('title')).toContain('Fix tables')
    expect(row('pdf').findAll('.exit-btn').find((b) => b.text() === 'Update').classes()).toContain('primary')
    expect(row('pdf').find('.skills-history-line').text()).toContain('Changed 3 days ago · 3 versions')
    expect(row('mine').find('.skills-history-line').text()).toContain('Changed 1 hour ago · 1 version')
    expect(row('copied').find('.skills-history-line').exists()).toBe(false)
    expect(wrapper.find('.skills-filter').exists()).toBe(false) // a short list
    wrapper.unmount()
  })

  it('a long list can be filtered by origin', async () => {
    const many = [...tracked(), ...['a', 'b', 'c', 'd'].map((n) => skill({ dir: `/h/.claude/skills/${n}`, name: n, origin: 'own' }))]
    api({ skillsList: async () => ({ roots: [], skills: many }) })
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    const filter = wrapper.find('.skills-filter')
    expect(filter.findAll('button').map((b) => b.text())).toEqual(['All8', 'Yours5', 'GitHub1', 'Folders1'])
    await filter.findAll('button')[1].trigger('click')
    expect(wrapper.findAll('.mcp-server .mcp-name').map((n) => n.text())).toEqual(['a', 'b', 'c', 'd', 'mine'])
    await filter.findAll('button')[2].trigger('click')
    expect(wrapper.findAll('.mcp-server .mcp-name').map((n) => n.text())).toEqual(['pdf'])
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
    const pdf = () => wrapper.findAll('.mcp-server').find((r) => r.find('.mcp-name').text() === 'pdf')
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
    const pdf = wrapper.findAll('.mcp-server').find((r) => r.find('.mcp-name').text() === 'pdf')
    await pdf.findAll('.exit-btn').find((b) => b.text() === 'Update').trigger('click')
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
    const mine = () => wrapper.findAll('.mcp-server').find((r) => r.find('.mcp-name').text() === 'mine')
    expect(mine().find('.skills-partial').text()).toBe('Partly kept')
    expect(mine().find('.skills-partial').attributes('title')).toContain('cannot be restored')
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
    await wrapper.findAll('.skills-copy')[1].findAll('.exit-btn').find((b) => b.text() === 'Update').trigger('click')
    await flushPromises()
    await wrapper.find('.skills-preview form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('.mcp-notice').text()).toBe('Updated "pdf". The old copy is in the Recycle Bin. Agents use it from their next session.')
    wrapper.unmount()
  })

  it('speaks French: origins, badges, history', async () => {
    api({ skillsList: async () => ({ roots: [], skills: tracked() }) })
    setMessages('fr', fr)
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('Votre compétence')
    expect(text).toContain('Depuis GitHub — o/r')
    expect(text).toContain('Copiée depuis un dossier')
    expect(text).toContain('Modifiée localement')
    expect(text).toContain('Mise à jour disponible')
    expect(text).toContain('Modifiée il y a 3 jours · 3 versions')
    expect(text).toContain('Historique')
    wrapper.unmount()
  })

  it('speaks French', async () => {
    api()
    setMessages('fr', fr)
    const wrapper = mount(SkillsDialog, { props: { agents: [{ id: 'claude', available: true }] }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.text()).toContain('Les compétences sont des dossiers')
    expect(wrapper.text()).toContain('Tous les projets')
    expect(wrapper.text()).toContain('Synchronisée depuis votre compte Claude')
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
    expect(wrapper.findAll('.mcp-server').map((r) => r.find('.mcp-name').text())).toEqual(['docx', 'pdf'])
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
