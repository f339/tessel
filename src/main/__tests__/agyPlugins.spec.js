// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parseAgyPluginList, listAgyPlugins, setAgyPlugin, removeAgyPlugin } from '../agyPlugins'

// `agy plugin list --json` on agy 1.3.5, after installing a plugin from a folder.
const LISTED = JSON.stringify([
  {
    name: 'tessel-probe-plugin',
    enabled: true,
    version: '0.1.0',
    source: 'antigravity',
    path: 'C:\\Users\\me\\.gemini\\config\\plugins\\tessel-probe-plugin',
    skills: ['probe-skill']
  },
  { name: 'figma', enabled: false, version: '1.2.0', source: 'antigravity-plugins-official', skills: ['a', 'b'], mcpServers: ['figma'], hooks: [] }
])

const runner = (answers) => {
  const calls = []
  const run = async (exe, args) => {
    calls.push([exe, ...args])
    const a = answers[args.join(' ')]
    return a || { ok: true, stdout: '', stderr: '' }
  }
  return { run, calls }
}

describe("the Antigravity CLI's plugins", () => {
  it('reads its JSON list: name, on or off, version, source, what it bundles', () => {
    expect(parseAgyPluginList(LISTED)).toEqual([
      { name: 'tessel-probe-plugin', enabled: true, version: '0.1.0', source: 'antigravity', counts: { skills: 1 } },
      { name: 'figma', enabled: false, version: '1.2.0', source: 'antigravity-plugins-official', counts: { skills: 2, mcpServers: 1 } }
    ])
    expect(parseAgyPluginList('[]')).toEqual([])
    expect(parseAgyPluginList('No plugins installed.')).toBe(null)
    // A name that could be read as an option or as more than one word is left out.
    expect(parseAgyPluginList(JSON.stringify([{ name: '--yolo' }, { name: 'a b' }, { name: 'ok' }])).map((p) => p.name)).toEqual(['ok'])
  })

  it('lists with agy plugin list --json, and says why when it cannot', async () => {
    const ok = runner({ 'plugin list --json': { ok: true, stdout: LISTED } })
    expect((await listAgyPlugins(ok.run)).plugins.map((p) => p.name)).toEqual(['tessel-probe-plugin', 'figma'])
    expect(ok.calls).toEqual([['agy', 'plugin', 'list', '--json']])
    const missing = runner({ 'plugin list --json': { ok: false, stderr: "agy : The term 'agy' is not recognized" } })
    expect(await listAgyPlugins(missing.run)).toEqual({ plugins: [], error: 'The Antigravity CLI is not installed.' })
    const odd = runner({ 'plugin list --json': { ok: true, stdout: 'garbage' } })
    expect((await listAgyPlugins(odd.run)).error).toMatch(/Could not read/)
  })

  it('turns a plugin on or off and uninstalls it with its own commands, by a plain name only', async () => {
    const r = runner({})
    expect(await setAgyPlugin({ name: 'figma', enabled: false }, r.run)).toEqual({ ok: true })
    expect(await setAgyPlugin({ name: 'figma', enabled: true }, r.run)).toEqual({ ok: true })
    expect(await removeAgyPlugin({ name: 'figma' }, r.run)).toEqual({ ok: true })
    expect(r.calls).toEqual([
      ['agy', 'plugin', 'disable', 'figma'],
      ['agy', 'plugin', 'enable', 'figma'],
      ['agy', 'plugin', 'uninstall', 'figma']
    ])
    for (const name of ['--all', 'a b', '', null, '../x']) {
      expect((await setAgyPlugin({ name, enabled: true }, r.run)).ok).toBe(false)
      expect((await removeAgyPlugin({ name }, r.run)).ok).toBe(false)
    }
    expect(r.calls).toHaveLength(3)
    const failing = runner({ 'plugin disable figma': { ok: false, stderr: 'Error: plugin not found' } })
    expect(await setAgyPlugin({ name: 'figma', enabled: false }, failing.run)).toEqual({ ok: false, error: 'Error: plugin not found' })
  })
})
