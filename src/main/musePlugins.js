// Muse Code's plugins (bundles of skills, commands, hooks and MCP servers),
// listed and turned on or off with Muse's own commands (its plugin command
// reference, each verb's --json):
//   muse plugins list --json   { plugins: [{ record: { id, enabled, version,
//                                source: { provenance } }, plugin: { id,
//                                display_name, description, capabilities:
//                                { skills, commands, hooks, mcp_servers } },
//                                active, valid }] }
//   muse plugins enable|disable <id> --json, muse plugins remove <id> --json
// Muse is started directly (its binary, an argument array, no shell; see
// museServe.js findMuse), stopped after 60 s. Installing one (a folder or
// name@marketplace) and approving its hooks can ask questions, so that runs
// in a pane the user sees (the Skills window), never here.
import { execFile as nodeExecFile } from 'node:child_process'
import os from 'node:os'
import { t } from './i18n'
import { cleanEnv } from './cleanEnv'
import { findMuse } from './museServe'

// A plugin id as Muse lists it: never an option or more than one word on its
// command line.
export const MUSE_PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,99}$/

const PARTS = { skills: 'skills', commands: 'commands', hooks: 'hooks', mcp_servers: 'mcpServers', agents: 'agents', subagents: 'agents', rules: 'rules' }
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

// `muse plugins list --json` -> [{ name, label, enabled, version, source,
// description, counts }] (counts of what each bundles: { skills: 2, hooks: 1 }),
// or null when the output is not that list.
export function parseMusePluginList(stdout) {
  const out = String(stdout || '')
  const start = out.indexOf('{')
  if (start < 0) return null
  let data
  try {
    data = JSON.parse(out.slice(start))
  } catch {
    return null
  }
  if (!object(data) || !Array.isArray(data.plugins)) return null
  const plugins = []
  for (const entry of data.plugins.slice(0, 200)) {
    const record = object(entry) && object(entry.record) ? entry.record : {}
    const plugin = object(entry) && object(entry.plugin) ? entry.plugin : {}
    const name = typeof record.id === 'string' ? record.id : plugin.id
    if (typeof name !== 'string' || !MUSE_PLUGIN_ID.test(name)) continue
    const caps = object(plugin.capabilities) ? plugin.capabilities : {}
    const counts = {}
    for (const [key, part] of Object.entries(PARTS)) if (Array.isArray(caps[key]) && caps[key].length) counts[part] = (counts[part] || 0) + caps[key].length
    plugins.push({
      name,
      label: text(record.display_name || plugin.display_name, 80),
      enabled: record.enabled !== false,
      version: text(record.version || plugin.version, 40),
      source: text(object(record.source) ? record.source.provenance : '', 80),
      description: text(record.description || plugin.description, 300),
      counts
    })
  }
  return plugins
}

const failure = (res, fallback) => {
  // Its --json error envelope, else its last lines.
  try {
    const e = JSON.parse(String(res.stdout || '').trim())
    if (object(e) && object(e.error) && typeof e.error.message === 'string') return e.error.message.slice(0, 300)
  } catch {
    /* plain text */
  }
  const line = String(res.stderr || res.stdout || res.error || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
  return line.slice(0, 300) || fallback
}

// execFile, find, env: injectable (tests). -> { list, set, remove }
export function createMusePlugins({ execFile = nodeExecFile, find = findMuse, env = () => cleanEnv(process.env), home = os.homedir() } = {}) {
  const vars = () => {
    try {
      return env() || {}
    } catch {
      return {}
    }
  }
  // -> { ok, stdout, stderr, error, missing }
  function run(args) {
    const runEnv = vars()
    const file = find({ env: runEnv, home })
    if (!file) return Promise.resolve({ ok: false, missing: true, stdout: '', stderr: '' })
    return new Promise((done) => {
      try {
        const child = execFile(file, args, { cwd: home, env: runEnv, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) =>
          done({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? String(err.message || err) : '', missing: !!(err && err.code === 'ENOENT') })
        )
        child?.stdin?.on?.('error', () => {})
        child?.stdin?.end?.()
      } catch (err) {
        done({ ok: false, stdout: '', stderr: '', error: String((err && err.message) || err) })
      }
    })
  }
  const notInstalled = () => t('main.musePlugins.notInstalled', 'Muse Code is not installed.')
  const badName = () => t('main.musePlugins.badName', 'Invalid plugin name.')
  return {
    // -> { plugins } or { plugins: [], error }
    async list() {
      const res = await run(['plugins', 'list', '--json'])
      if (!res.ok) return { plugins: [], error: res.missing ? notInstalled() : failure(res, t('main.musePlugins.listFailed', 'Could not list the Muse Code plugins.')) }
      const plugins = parseMusePluginList(res.stdout)
      return plugins ? { plugins } : { plugins: [], error: t('main.musePlugins.listUnreadable', 'Could not read the Muse Code plugin list.') }
    },
    // { name, enabled } -> { ok } or { ok: false, error }
    async set({ name, enabled } = {}) {
      if (typeof name !== 'string' || !MUSE_PLUGIN_ID.test(name)) return { ok: false, error: badName() }
      const res = await run(['plugins', enabled ? 'enable' : 'disable', name, '--json'])
      return res.ok ? { ok: true } : { ok: false, error: res.missing ? notInstalled() : failure(res, t('main.musePlugins.setFailed', 'Muse Code could not change this plugin.')) }
    },
    // { name } -> { ok } or { ok: false, error }
    async remove({ name } = {}) {
      if (typeof name !== 'string' || !MUSE_PLUGIN_ID.test(name)) return { ok: false, error: badName() }
      const res = await run(['plugins', 'remove', name, '--json'])
      return res.ok ? { ok: true } : { ok: false, error: res.missing ? notInstalled() : failure(res, t('main.musePlugins.removeFailed', 'Muse Code could not uninstall this plugin.')) }
    }
  }
}
