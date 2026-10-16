// @vitest-environment node
// Muse Code's plugins, with its own commands (`muse plugins … --json`, the
// shapes of its plugin command reference): its binary run directly with an
// argument array (a fake here: no real Muse runs).
import { describe, expect, it, vi } from 'vitest'
import { createMusePlugins, parseMusePluginList } from '../musePlugins'

const LIST = {
  plugins: [
    {
      record: { id: 'weather', display_name: 'Weather', version: '0.1.0', description: 'A forecast skill.', manifest_family: 'native', enabled: true, trust: 'user-local', source: { provenance: 'native-local', path: 'C:/p/weather' } },
      warning: 'third-party plugin: hooks require review before activation',
      plugin: { id: 'weather', display_name: 'Weather', version: '0.1.0', manifest_family: 'native', capabilities: { skills: [{ id: 'forecast' }], hooks: [{ id: 'log-tool-use' }], mcp_servers: [], commands: [{ id: 'forecast-brief' }] } },
      valid: true,
      active: true,
      active_scope: 'installed-plugin',
      diagnostics: []
    },
    { record: { id: 'off-kit', enabled: false, version: '2.0.0', source: { provenance: 'marketplace-user-added' } }, plugin: { id: 'off-kit', capabilities: { mcp_servers: [{ id: 'a' }, { id: 'b' }] } } },
    { record: { id: '--evil; rm', enabled: true }, plugin: {} }
  ]
}

describe('Muse Code plugins', () => {
  it('its list: each plugin, on or off, and what it bundles; a name that could be read as more is dropped', () => {
    expect(parseMusePluginList(JSON.stringify(LIST, null, 2))).toEqual([
      { name: 'weather', label: 'Weather', enabled: true, version: '0.1.0', source: 'native-local', description: 'A forecast skill.', counts: { skills: 1, hooks: 1, commands: 1 } },
      { name: 'off-kit', label: '', enabled: false, version: '2.0.0', source: 'marketplace-user-added', description: '', counts: { mcpServers: 2 } }
    ])
    expect(parseMusePluginList('no plugins')).toBe(null)
    expect(parseMusePluginList('{"plugins":[]}')).toEqual([])
  })

  it("listed, turned off and removed with muse's own verbs, its binary run directly", async () => {
    const execFile = vi.fn((file, args, opts, cb) => {
      cb(null, args[1] === 'list' ? JSON.stringify(LIST) : '{"installed":{}}', '')
      return { stdin: { on() {}, end() {} } }
    })
    const plugins = createMusePlugins({ execFile, find: () => 'C:\\m\\muse-bin-1.4.9-R1.exe', env: () => ({ Path: 'C:\\Windows' }), home: 'C:\\Users\\me' })
    expect((await plugins.list()).plugins.map((p) => p.name)).toEqual(['weather', 'off-kit'])
    expect(await plugins.set({ name: 'weather', enabled: false })).toEqual({ ok: true })
    expect(await plugins.remove({ name: 'off-kit' })).toEqual({ ok: true })
    expect(execFile.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['C:\\m\\muse-bin-1.4.9-R1.exe', ['plugins', 'list', '--json']],
      ['C:\\m\\muse-bin-1.4.9-R1.exe', ['plugins', 'disable', 'weather', '--json']],
      ['C:\\m\\muse-bin-1.4.9-R1.exe', ['plugins', 'remove', 'off-kit', '--json']]
    ])
    expect(execFile.mock.calls[0][2]).toMatchObject({ windowsHide: true, cwd: 'C:\\Users\\me' })
    // Never an option or a second word for a name.
    expect(await plugins.set({ name: '--all', enabled: true })).toMatchObject({ ok: false })
    expect(execFile).toHaveBeenCalledTimes(3)
  })

  it('its own error message, and Muse not installed, said plainly', async () => {
    const execFile = vi.fn((file, args, opts, cb) => {
      cb(Object.assign(new Error('exit 1'), { code: 1 }), JSON.stringify({ error: { code: 'unknown-plugin', message: 'unknown plugin `nope`' } }), 'unknown plugin `nope`')
      return {}
    })
    const plugins = createMusePlugins({ execFile, find: () => 'muse', env: () => ({}) })
    expect(await plugins.remove({ name: 'nope' })).toEqual({ ok: false, error: 'unknown plugin `nope`' })
    const none = createMusePlugins({ execFile, find: () => null, env: () => ({}) })
    expect(await none.list()).toEqual({ plugins: [], error: 'Muse Code is not installed.' })
  })
})
