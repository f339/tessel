// The Antigravity CLI's plugins (bundles of skills, MCP servers, hooks and
// rules, in ~/.gemini/config/plugins), listed and turned on or off with agy's
// own commands, checked with agy 1.3.5:
//   agy plugin list --json   [{ name, enabled, version, source, path, skills: [...], ... }]
//   agy plugin enable|disable <name>, agy plugin uninstall <name>
// Installing one (from its marketplace or a folder) can ask questions, so it
// runs in a pane the user sees (the Skills window), never here.
import { t } from './i18n'

// A plugin name as agy lists it (its folder name): never an option or more
// than one word on its command line.
export const AGY_PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,99}$/

const PARTS = ['skills', 'mcpServers', 'agents', 'hooks', 'rules', 'commands']
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')

// `agy plugin list --json` -> [{ name, enabled, version, source, counts }]:
// counts of what each bundles ({ skills: 2, mcpServers: 1 }). null when the
// output is not that list.
export function parseAgyPluginList(stdout) {
  const out = String(stdout || '')
  const start = out.indexOf('[')
  if (start < 0) return null
  let rows
  try {
    rows = JSON.parse(out.slice(start))
  } catch {
    return null
  }
  if (!Array.isArray(rows)) return null
  const plugins = []
  for (const r of rows.slice(0, 200)) {
    if (!r || typeof r !== 'object' || typeof r.name !== 'string' || !AGY_PLUGIN_NAME.test(r.name)) continue
    const counts = {}
    for (const key of PARTS) if (Array.isArray(r[key]) && r[key].length) counts[key] = r[key].length
    plugins.push({ name: r.name, enabled: r.enabled !== false, version: text(r.version, 40), source: text(r.source, 80), counts })
  }
  return plugins
}

const notInstalled = (res) => /not recognized|CommandNotFound|ENOENT|cannot find/i.test(`${res.stderr || ''} ${res.stdout || ''} ${res.error || ''}`)
const failure = (res, fallback) => {
  const line = String(res.stderr || res.stdout || res.error || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
  return line.slice(0, 300) || fallback
}

// run(exe, args) -> { ok, stdout, stderr, error } (agentTools' runAgentCli).
// -> { plugins } or { plugins: [], error }
export async function listAgyPlugins(run) {
  const res = await run('agy', ['plugin', 'list', '--json'])
  if (!res.ok) {
    return {
      plugins: [],
      error: notInstalled(res)
        ? t('main.agyPlugins.notInstalled', 'The Antigravity CLI is not installed.')
        : failure(res, t('main.agyPlugins.listFailed', 'Could not list the Antigravity CLI plugins.'))
    }
  }
  const plugins = parseAgyPluginList(res.stdout)
  return plugins ? { plugins } : { plugins: [], error: t('main.agyPlugins.listUnreadable', 'Could not read the Antigravity CLI plugin list.') }
}

// { name, enabled } -> { ok } or { ok: false, error }
export async function setAgyPlugin({ name, enabled } = {}, run) {
  if (typeof name !== 'string' || !AGY_PLUGIN_NAME.test(name)) return { ok: false, error: t('main.agyPlugins.badName', 'Invalid plugin name.') }
  const res = await run('agy', ['plugin', enabled ? 'enable' : 'disable', name])
  return res.ok ? { ok: true } : { ok: false, error: failure(res, t('main.agyPlugins.setFailed', 'The Antigravity CLI could not change this plugin.')) }
}

// { name } -> { ok } or { ok: false, error }
export async function removeAgyPlugin({ name } = {}, run) {
  if (typeof name !== 'string' || !AGY_PLUGIN_NAME.test(name)) return { ok: false, error: t('main.agyPlugins.badName', 'Invalid plugin name.') }
  const res = await run('agy', ['plugin', 'uninstall', name])
  return res.ok ? { ok: true } : { ok: false, error: failure(res, t('main.agyPlugins.removeFailed', 'The Antigravity CLI could not uninstall this plugin.')) }
}
