// The model and effort of the agents Tessel had no file for (agentModelSources.js),
// as agentModel.js gives them to the pane header: their session files and
// databases first, then their command, then their settings. Fixtures follow
// each agent's own record shapes (no personal data).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { agentModel, copilotModelFromText } from '../agentModel'
import {
  _clearModelSourceCachesForTest,
  aiderConfigModel,
  ampModeFromCommand,
  continueModel,
  crushConfigModel,
  effortFlag,
  geminiModelFromText,
  gooseConfigModel,
  kimiConfigModel,
  kimiModelFromWire,
  modelWatchTargets,
  opencodeSessionModel,
  piModelFromText,
  piModelTimeline,
  qwenModelFromText,
  tomlKeys,
  vibeConfigModel
} from '../agentModelSources'
import { effortLevel } from '../../shared/modelLabel'

const sqlite = process.getBuiltinModule && process.getBuiltinModule('node:sqlite')
const GID = '3f2a9c4e-8b1d-4e6f-9a7c-5d4e3b2a1f00'
const PID = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b'
const line = (o) => JSON.stringify(o)
const T0 = Date.parse('2026-10-16T10:00:00.000Z')
const iso = (s) => new Date(T0 + s * 1000).toISOString()

let home
const saved = {}
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-model-src-'))
  for (const k of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'KIMI_CODE_HOME', 'QWEN_HOME', 'QWEN_RUNTIME_DIR', 'GEMINI_CLI_HOME', 'PI_CODING_AGENT_DIR', 'OMP_CODING_AGENT_DIR', 'VIBE_HOME', 'CONTINUE_GLOBAL_DIR']) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  _clearModelSourceCachesForTest()
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v
})
function put(rel, text) {
  const f = join(home, rel)
  fs.mkdirSync(join(f, '..'), { recursive: true })
  fs.writeFileSync(f, text)
  return f
}

describe('effort words', () => {
  it("an agent's own word as Tessel's effort label; one it has no label for: none", () => {
    expect(effortLevel('High')).toBe('high')
    expect(effortLevel('Extra high')).toBe('xhigh')
    expect(effortLevel('extra_high')).toBe('xhigh')
    expect(effortLevel('off')).toBe('none')
    expect(effortLevel('max')).toBe('max')
    expect(effortLevel('default')).toBe(null)
    expect(effortLevel(null)).toBe(null)
  })
  it('--effort, --reasoning-effort, --thinking on a command line; Amp’s --mode', () => {
    expect(effortFlag('copilot --reasoning-effort=high')).toBe('high')
    expect(effortFlag('pi --model openai/gpt-5.4 --thinking xhigh')).toBe('xhigh')
    expect(effortFlag('amp --mode deep --effort medium')).toBe('medium')
    expect(effortFlag('agent --thinking --model x')).toBe(null)
    expect(ampModeFromCommand('amp --mode deep --effort medium')).toBe('deep')
    expect(ampModeFromCommand('amp')).toBe(null)
  })
})

describe('Gemini CLI', () => {
  const chat = (rel, rows) => put(`.gemini/tmp/proj/chats/${rel}`, rows.map(line).join('\n') + '\n')
  const head = { sessionId: GID, projectHash: 'ab12', startTime: iso(0), lastUpdated: iso(0), kind: 'main' }

  it("each answer's model, the newest one; a prompt or a metadata update names none", () => {
    const text = [
      line(head),
      line({ id: 'u1', timestamp: iso(1), type: 'user', content: [{ text: 'Use gemini-2.5-flash please' }] }),
      line({ id: 'g1', timestamp: iso(2), type: 'gemini', content: 'On it.', thoughts: [], tokens: { input: 10, output: 5, total: 15 }, model: 'gemini-3-pro-preview' }),
      line({ $set: { lastUpdated: iso(3) } })
    ].join('\n')
    expect(geminiModelFromText(text)).toEqual({ model: 'gemini-3-pro-preview', effort: null, at: T0 + 2000 })
    expect(geminiModelFromText(line({ type: 'user', content: 'gemini-3-flash' }))).toBe(null)
  })

  it('the pane: its own chat file (its id), even after megabytes of tool output; else its settings', () => {
    put('.gemini/settings.json', JSON.stringify({ model: { name: 'gemini-2.5-pro' } }))
    expect(agentModel({ agentId: 'gemini', sessionId: GID }, home)).toEqual({ model: 'gemini-2.5-pro', effort: null, source: 'settings' })
    _clearModelSourceCachesForTest()
    const big = 'x'.repeat(1300 * 1024)
    chat(`session-2026-10-16T10-00-${GID.slice(0, 8)}.jsonl`, [
      head,
      { id: 'g1', timestamp: iso(2), type: 'gemini', content: 'Reading.', model: 'gemini-3-flash-preview' },
      { id: 'g1', timestamp: iso(3), type: 'gemini', content: 'Reading.', model: 'gemini-3-flash-preview', toolCalls: [{ name: 'read_file', result: big }] },
      { $set: { lastUpdated: iso(4) } }
    ])
    // Another session's file with the same short id is not its.
    chat(`session-2026-10-15T09-00-${GID.slice(0, 8)}.jsonl`, [{ ...head, sessionId: GID.slice(0, 8) + '-0000-4000-8000-000000000000' }, { type: 'gemini', model: 'gemini-other' }])
    expect(agentModel({ agentId: 'gemini', sessionId: GID }, home)).toEqual({ model: 'gemini-3-flash-preview', effort: null, source: 'session', at: T0 + 3000 })
  })
})

describe('Qwen Code', () => {
  it("each answer's model in its chat (the pane's id)", () => {
    const rows = [
      { uuid: 'a', parentUuid: null, sessionId: GID, timestamp: iso(1), type: 'user', cwd: 'C:\\Proj', message: { role: 'user', parts: [{ text: 'hi' }] } },
      { uuid: 'b', parentUuid: 'a', sessionId: GID, timestamp: iso(2), type: 'assistant', cwd: 'C:\\Proj', model: 'qwen3-coder-plus', message: { role: 'model', parts: [{ text: 'hello' }] } }
    ]
    expect(qwenModelFromText(rows.map(line).join('\n'))).toEqual({ model: 'qwen3-coder-plus', effort: null, at: T0 + 2000 })
    put(`.qwen/projects/C--Proj/chats/${GID}.jsonl`, rows.map(line).join('\n') + '\n')
    expect(agentModel({ agentId: 'qwen', sessionId: GID }, home)).toMatchObject({ model: 'qwen3-coder-plus', source: 'session' })
  })
})

describe('Kimi Code', () => {
  const KID = 'session_7f3a9c2e41'
  const bind = (alias, effort, time, prompt = 'You are Kimi Code.') => line({ type: 'profile.bind', agentId: 'main', modelAlias: alias, profileName: 'default', thinkingEffort: effort, systemPrompt: prompt, disallowedTools: [], time })
  const update = (fields, time) => line({ type: 'config.update', agentId: 'main', ...fields, time })

  it("the session's start, then each /model and /effort (config.update)", () => {
    const tail = [line({ type: 'metadata', protocol_version: '1.5', created_at: T0 }), bind('kimi-code/kimi-for-coding', 'high', T0), update({ modelAlias: 'kimi-code/kimi-k2-turbo', thinkingEffort: 'high' }, T0 + 5000), update({ thinkingEffort: 'max' }, T0 + 9000)].join('\n')
    expect(kimiModelFromWire(tail)).toEqual({ model: 'kimi-code/kimi-k2-turbo', effort: 'max', at: T0 + 9000 })
    // Thinking off is no reasoning; "on" (a model without levels) no level.
    expect(kimiModelFromWire(bind('kimi-code/kimi-for-coding', 'off', T0))).toMatchObject({ effort: 'none' })
    expect(kimiModelFromWire(bind('my/model', 'on', T0))).toMatchObject({ effort: null })
  })

  it('a long session: the model its start bound, its effort from a later /effort; a start line cut after its first fields', () => {
    const cut = bind('kimi-code/kimi-for-coding', 'low', T0, 'p'.repeat(5000)).slice(0, 300)
    expect(kimiModelFromWire(update({ thinkingEffort: 'high' }, T0 + 1000), cut)).toEqual({ model: 'kimi-code/kimi-for-coding', effort: 'high', at: T0 + 1000 })
    expect(kimiModelFromWire('', cut)).toEqual({ model: 'kimi-code/kimi-for-coding', effort: 'low' })
  })

  it('config.toml: its default model, thinking and display name (a TOML table per alias)', () => {
    const toml = [
      'default_model = "kimi-code/kimi-for-coding"',
      '',
      '[[hooks]]',
      'event = "Stop"',
      'command = "node x.cjs"',
      '',
      '[thinking]',
      'enabled = true',
      'effort = "high" # its default',
      '',
      '[models."kimi-code/kimi-for-coding"]',
      'provider = "managed:kimi-code"',
      'model = "kimi-for-coding"',
      'display_name = "Kimi K2.6"',
      'max_context_size = 262144'
    ].join('\n')
    expect(kimiConfigModel(toml)).toEqual({ model: 'kimi-code/kimi-for-coding', effort: 'high', name: 'Kimi K2.6' })
    expect(kimiConfigModel('default_model = "x"\n[thinking]\nenabled = false\n')).toEqual({ model: 'x', effort: 'none' })
    expect(tomlKeys(toml).get('models\nkimi-code/kimi-for-coding').get('max_context_size')).toBe(262144)
  })

  it('the pane: its session wire (its id), with the display name config.toml gives that alias; else config.toml', () => {
    put('.kimi-code/config.toml', 'default_model = "kimi-code/kimi-for-coding"\n[models."kimi-code/kimi-k2-turbo"]\ndisplay_name = "Kimi K2 Turbo"\n')
    expect(agentModel({ agentId: 'kimi', sessionId: KID }, home)).toEqual({ model: 'kimi-code/kimi-for-coding', effort: null, source: 'settings' })
    _clearModelSourceCachesForTest()
    put(`.kimi-code/sessions/ws-9a8b/${KID}/agents/main/wire.jsonl`, [bind('kimi-code/kimi-for-coding', 'high', T0), update({ modelAlias: 'kimi-code/kimi-k2-turbo', thinkingEffort: 'low' }, T0 + 4000)].join('\n') + '\n')
    expect(agentModel({ agentId: 'kimi', sessionId: KID }, home)).toEqual({ model: 'kimi-code/kimi-k2-turbo', name: 'Kimi K2 Turbo', effort: 'low', source: 'session', at: T0 + 4000 })
  })
})

describe("Pi's session format (Pi, OMP, OpenClaw)", () => {
  const rows = [
    { type: 'session', version: 3, id: PID, timestamp: iso(0), cwd: 'C:\\Proj' },
    { type: 'model_change', id: 'e1', parentId: null, timestamp: iso(0), provider: 'openai-codex', modelId: 'gpt-5.4' },
    { type: 'thinking_level_change', id: 'e2', parentId: 'e1', timestamp: iso(0), thinkingLevel: 'low' },
    { type: 'message', id: 'e3', parentId: 'e2', timestamp: iso(5), message: { role: 'user', content: [{ type: 'text', text: 'Switch to claude-opus-5' }] } },
    { type: 'message', id: 'e4', parentId: 'e3', timestamp: iso(9), message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], api: 'openai-codex-responses', provider: 'openai-codex', model: 'gpt-5.4', usage: {} } }
  ]

  it('the model in force (its latest change or answer) and its thinking level', () => {
    expect(piModelFromText(rows.map(line).join('\n'))).toEqual({ model: 'openai-codex/gpt-5.4', effort: 'low', at: T0 + 9000 })
    const later = [...rows, { type: 'model_change', timestamp: iso(20), provider: 'anthropic', modelId: 'claude-opus-5-5' }, { type: 'thinking_level_change', timestamp: iso(21), thinkingLevel: 'off' }]
    expect(piModelFromText(later.map(line).join('\n'))).toEqual({ model: 'anthropic/claude-opus-5-5', effort: 'none', at: T0 + 21000 })
    expect(piModelTimeline(later.map(line))).toEqual([
      { t: T0, model: 'openai-codex/gpt-5.4', effort: null },
      { t: T0, model: 'openai-codex/gpt-5.4', effort: 'low' },
      { t: T0 + 20000, model: 'anthropic/claude-opus-5-5', effort: 'low' },
      { t: T0 + 21000, model: 'anthropic/claude-opus-5-5', effort: 'none' }
    ])
  })

  it('the pane: its session file by its id; a long one keeps the level its start set; else its settings', () => {
    put('.pi/agent/settings.json', JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-5', defaultThinkingLevel: 'medium' }))
    expect(agentModel({ agentId: 'pi', sessionId: PID }, home)).toEqual({ model: 'anthropic/claude-sonnet-5', effort: 'medium', source: 'settings' })
    _clearModelSourceCachesForTest()
    const filler = Array.from({ length: 400 }, (_, i) => line({ type: 'message', timestamp: iso(10 + i), message: { role: 'toolResult', content: [{ type: 'text', text: 'y'.repeat(1000) }] } }))
    put(`.pi/agent/sessions/--C--Proj--/2026-10-16T10-00-00-000Z_${PID}.jsonl`, [...rows.map(line), ...filler, line(rows[4])].join('\n') + '\n')
    expect(agentModel({ agentId: 'pi', sessionId: PID }, home)).toMatchObject({ model: 'openai-codex/gpt-5.4', effort: 'low', source: 'session' })
    // OMP: the same format in its own folder.
    put(`.omp/agent/sessions/--C--Proj--/2026-10-16T10-00-00-000Z_${PID}.jsonl`, rows.map(line).join('\n') + '\n')
    expect(agentModel({ agentId: 'omp', sessionId: PID }, home)).toMatchObject({ model: 'openai-codex/gpt-5.4', effort: 'low', source: 'session' })
  })

  it('OpenClaw: its newest session in its index, with the level its file notes; else its default model', () => {
    put('.openclaw/openclaw.json', JSON.stringify({ agents: { defaults: { model: { primary: 'openai-codex/gpt-5.4' }, workspace: 'C:\\w' } } }))
    expect(agentModel({ agentId: 'openclaw' }, home)).toEqual({ model: 'openai-codex/gpt-5.4', effort: null, source: 'settings' })
    put('.openclaw/agents/main/sessions/sessions.json', JSON.stringify({
      'agent:main:old': { sessionId: 'aaaa1111-0000-4000-8000-000000000001', updatedAt: T0 - 60000, modelProvider: 'anthropic', model: 'claude-old' },
      'agent:main:main': { sessionId: PID, updatedAt: T0 + 9000, modelProvider: 'openai-codex', model: 'gpt-5.4' }
    }))
    put(`.openclaw/agents/main/sessions/${PID}.jsonl`, rows.map(line).join('\n') + '\n')
    expect(agentModel({ agentId: 'openclaw' }, home)).toMatchObject({ model: 'openai-codex/gpt-5.4', effort: 'low', source: 'session' })
  })
})

describe('Droid (Factory)', () => {
  it('its session settings, else its settings.json (not verified with an installed Droid)', () => {
    const DID = '5b6c7d8e-9f00-4a1b-8c2d-3e4f5a6b7c8d'
    put('.factory/settings.json', JSON.stringify({ model: 'claude-sonnet-4-5-20250929', reasoningEffort: 'medium', autonomyLevel: 'low' }))
    expect(agentModel({ agentId: 'droid', sessionId: DID }, home)).toEqual({ model: 'claude-sonnet-4-5-20250929', effort: 'medium', source: 'settings' })
    _clearModelSourceCachesForTest()
    put(`.factory/sessions/-C-Proj/${DID}.jsonl`, line({ type: 'session_start', id: DID, title: 'x', cwd: 'C:\\Proj' }) + '\n')
    put(`.factory/sessions/-C-Proj/${DID}.settings.json`, JSON.stringify({ model: 'gpt-5.1-codex', reasoningEffort: 'high', autonomyMode: 'auto-low' }))
    expect(agentModel({ agentId: 'droid', sessionId: DID }, home)).toMatchObject({ model: 'gpt-5.1-codex', effort: 'high', source: 'session' })
  })
})

describe.skipIf(!sqlite)("OpenCode, Kilo and ZCode: OpenCode's tables", () => {
  function db(file, sessions, messages) {
    fs.mkdirSync(join(file, '..'), { recursive: true })
    const d = new sqlite.DatabaseSync(file)
    d.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, model TEXT, time_created INTEGER, time_updated INTEGER)')
    d.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
    for (const s of sessions) d.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(s.id, s.parent || null, s.dir, s.model ? JSON.stringify(s.model) : null, s.created, s.updated)
    for (const [i, m] of messages.entries()) d.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(`msg_${i}`, m.session, m.at, m.at, JSON.stringify(m.data))
    d.close()
  }
  const now = Date.now()

  it("a session's newest message names its model and variant (its effort); else the session's own column", () => {
    const col = JSON.stringify({ id: 'deepseek-v4.1-flash-free', providerID: 'opencode', variant: 'high' })
    expect(opencodeSessionModel(col, [{ data: JSON.stringify({ role: 'assistant', modelID: 'deepseek-v4.1-flash-free', providerID: 'opencode', mode: 'build' }), time_created: 5 }])).toEqual({ model: 'opencode/deepseek-v4.1-flash-free', effort: 'high', at: 5 })
    expect(opencodeSessionModel(col, [{ data: JSON.stringify({ role: 'user', model: { providerID: 'opencode', modelID: 'big-pickle', variant: 'default' } }), time_created: 6 }])).toEqual({ model: 'opencode/big-pickle', effort: null, at: 6 })
    expect(opencodeSessionModel(col, [], 7)).toEqual({ model: 'opencode/deepseek-v4.1-flash-free', effort: 'high', at: 7 })
  })

  it('OpenCode: its session (its id), a model picked in it later, then its settings', () => {
    db(join(home, '.local/share/opencode/opencode.db'), [{ id: 'ses_mine01', dir: 'C:\\Proj', model: { id: 'mimo-v2.6-flash-free', providerID: 'opencode', variant: 'default' }, created: now - 60000, updated: now - 30000 }], [
      { session: 'ses_mine01', at: now - 50000, data: { role: 'user', model: { providerID: 'opencode', modelID: 'mimo-v2.6-flash-free' } } },
      { session: 'ses_mine01', at: now - 40000, data: { role: 'assistant', modelID: 'mimo-v2.6-flash-free', providerID: 'opencode', variant: 'max' } }
    ])
    expect(agentModel({ agentId: 'opencode', sessionId: 'ses_mine01', launchedAt: now - 70000 }, home)).toEqual({ model: 'opencode/mimo-v2.6-flash-free', effort: 'max', source: 'session', at: now - 40000 })
    // A model picked in its list after that: the picked one, at the variant picked for it.
    put('.local/state/opencode/model.json', JSON.stringify({ recent: [{ providerID: 'opencode', modelID: 'big-pickle' }], favorite: [], variant: { 'opencode/big-pickle': 'high' } }))
    expect(agentModel({ agentId: 'opencode', sessionId: 'ses_mine01', launchedAt: now - 70000 }, home)).toEqual({ model: 'opencode/big-pickle', effort: 'high', source: 'picked' })
  })

  it("Kilo: the session of the pane's folder written since it started (it has no session id here)", () => {
    db(join(home, '.local/share/kilo/kilo.db'), [
      { id: 'ses_kilo_old', dir: 'C:\\Proj', model: { id: 'old/model', providerID: 'kilo' }, created: now - 9e6, updated: now - 9e6 },
      { id: 'ses_kilo_else', dir: 'C:\\Else', model: { id: 'else/model', providerID: 'kilo' }, created: now - 1000, updated: now - 1000 },
      { id: 'ses_kilo_mine', dir: 'C:\\Proj', model: { id: 'moonshotai/kimi-k3', providerID: 'kilo', variant: 'max' }, created: now - 5000, updated: now - 2000 }
    ], [])
    expect(agentModel({ agentId: 'kilo', cwd: 'C:/Proj/', launchedAt: now - 10000 }, home)).toEqual({ model: 'kilo/moonshotai/kimi-k3', effort: 'max', source: 'session', at: now - 2000 })
    // Before it wrote anything: its settings.
    put('.config/kilo/kilo.jsonc', '{\n  // its default\n  "model": "kilo/anthropic/claude-sonnet-5",\n}')
    expect(agentModel({ agentId: 'kilo', cwd: 'C:\\Proj', launchedAt: now + 1e6 }, home)).toEqual({ model: 'kilo/anthropic/claude-sonnet-5', effort: null, source: 'settings' })
  })

  it('ZCode: its session in its own database', () => {
    db(join(home, '.zcode/cli/db/db.sqlite'), [{ id: 'zses_123456', dir: 'C:\\Proj', model: { id: 'glm-5', providerID: 'zai' }, created: now, updated: now }], [])
    expect(agentModel({ agentId: 'zcode', sessionId: 'zses_123456' }, home)).toMatchObject({ model: 'zai/glm-5', source: 'session' })
  })
})

describe('Cline: its reasoning effort', () => {
  it("the provider's reasoning setting, for the model set there", () => {
    const old = { dir: process.env.CLINE_DIR, data: process.env.CLINE_DATA_DIR }
    delete process.env.CLINE_DIR
    delete process.env.CLINE_DATA_DIR
    try {
      const providers = (reasoning) => JSON.stringify({ version: 1, lastUsedProvider: 'cline', modes: {}, providers: { cline: { settings: { provider: 'cline', model: 'cline-free/deepseek-v4.1-flash', reasoning } } } })
      put('.cline/data/settings/providers.json', providers({ enabled: true, effort: 'medium' }))
      expect(agentModel({ agentId: 'cline', cwd: 'C:\\Proj' }, home)).toEqual({ model: 'cline-free/deepseek-v4.1-flash', effort: 'medium', source: 'settings' })
      put('.cline/data/settings/providers.json', providers({ enabled: false, effort: 'high' }))
      expect(agentModel({ agentId: 'cline', cwd: 'C:\\Proj' }, home).effort).toBe('none')
      expect(agentModel({ agentId: 'cline', cwd: 'C:\\Proj', command: 'cline --model other/model' }, home)).toEqual({ model: 'other/model', effort: null, source: 'command' })
    } finally {
      if (old.dir !== undefined) process.env.CLINE_DIR = old.dir
      if (old.data !== undefined) process.env.CLINE_DATA_DIR = old.data
    }
  })
})

describe('Copilot: its effort', () => {
  const ev = (type, data, s) => line({ type, data, id: `e${s}`, timestamp: iso(s), parentId: null })

  it("the effort its latest /model set, for the answers after it (they do not say)", () => {
    const text = [ev('session.model_change', { newModel: 'auto', reasoningEffort: 'medium' }, 1), ev('assistant.message', { model: 'gpt-6-luna', content: 'Hi' }, 2)].join('\n')
    expect(copilotModelFromText(text)).toEqual({ model: 'gpt-6-luna', effort: 'medium', at: T0 + 2000 })
    expect(copilotModelFromText([text, ev('session.model_change', { newModel: 'claude-sonnet-5', previousModel: 'auto', reasoningEffort: 'high' }, 3)].join('\n'))).toEqual({ model: 'claude-sonnet-5', effort: 'high', at: T0 + 3000 })
  })

  it("the pane's own session (its id), even with megabytes between its /model and its latest answer", () => {
    const SID = '7c6d5e4f-3a2b-4c1d-8e9f-0a1b2c3d4e5f'
    const big = ev('tool.execution_complete', { toolCallId: 't', result: 'z'.repeat(1200 * 1024) }, 3)
    put(`.copilot/session-state/${SID}/events.jsonl`, [ev('session.start', { sessionId: SID, context: { cwd: 'C:\\Proj' } }, 0), ev('session.model_change', { newModel: 'auto', reasoningEffort: 'low' }, 1), big, ev('assistant.message', { model: 'mai-code-1.1-flash' }, 4)].join('\n') + '\n')
    expect(agentModel({ agentId: 'copilot', sessionId: SID, cwd: 'C:\\Proj' }, home)).toEqual({ model: 'mai-code-1.1-flash', effort: 'low', source: 'session', at: T0 + 4000 })
  })
})

describe('Continue, Crush, Goose, Aider, Mistral Vibe: their settings', () => {
  const yaml = [
    'name: Local Config',
    'version: 1.0.0',
    'schema: v1',
    'models:',
    '  - name: Claude Opus 4.6',
    '    provider: anthropic',
    '    model: claude-opus-4-6',
    '    roles:',
    '      - chat',
    '      - edit',
    '  - name: "Embedder"',
    '    provider: ollama',
    '    model: nomic-embed-text',
    '    roles: [embed]',
    '  - name: Autodetect',
    '    provider: ollama',
    '    model: AUTODETECT'
  ].join('\n')

  it('Continue: its /model pick (a name from config.yaml), else its first chat model', () => {
    expect(continueModel(undefined, yaml)).toEqual({ model: 'claude-opus-4-6', effort: null, name: 'Claude Opus 4.6' })
    expect(continueModel('Autodetect', yaml)).toEqual({ model: 'Autodetect', effort: null, name: 'Autodetect' })
    put('.continue/config.yaml', yaml)
    put('.continue/index/globalContext.json', JSON.stringify({ cliSelectedModel: 'Claude Opus 4.6', selectedModelsByProfileId: {} }))
    expect(agentModel({ agentId: 'continue', command: 'cn' }, home)).toEqual({ model: 'claude-opus-4-6', effort: null, name: 'Claude Opus 4.6', source: 'settings' })
  })

  it('Crush, Goose, Aider, Vibe', () => {
    expect(crushConfigModel({ models: { large: { model: 'gpt-5.1', provider: 'openai', reasoning_effort: 'high' }, small: { model: 'gpt-5-mini', provider: 'openai' } } })).toEqual({ model: 'gpt-5.1', effort: 'high' })
    expect(gooseConfigModel('GOOSE_PROVIDER: anthropic\nGOOSE_MODEL: "claude-sonnet-4-5" # default\n')).toEqual({ model: 'claude-sonnet-4-5', effort: null })
    expect(aiderConfigModel('model: o4-mini\nreasoning-effort: high\nauto-commits: false\n')).toEqual({ model: 'o4-mini', effort: 'high' })
    expect(vibeConfigModel('active_model = "devstral-2"\n\n[[models]]\nname = "mistral-medium"\n')).toEqual({ model: 'devstral-2', effort: null })
    put('proj/.aider.conf.yml', 'model: gpt-5.1\n')
    expect(agentModel({ agentId: 'aider', cwd: join(home, 'proj') }, home)).toEqual({ model: 'gpt-5.1', effort: null, source: 'settings' })
    // Its --model beats them, with its --reasoning-effort.
    expect(agentModel({ agentId: 'aider', cwd: join(home, 'proj'), command: 'aider --model o3 --reasoning-effort low' }, home)).toEqual({ model: 'o3', effort: 'low', source: 'command' })
    expect(agentModel({ agentId: 'amp', command: 'amp --mode deep --effort high' }, home)).toEqual({ model: 'deep', effort: 'high', source: 'command' })
  })
})

describe('OpenClaude and Qoder: Claude Code transcripts in their own folders', () => {
  it('the latest answer and the effort it ran with', () => {
    const OID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
    put(`.openclaude/projects/C--Proj/${OID}.jsonl`, line({ type: 'assistant', timestamp: iso(4), message: { model: 'claude-opus-5-5' }, perTurnEffort: 'xhigh' }) + '\n')
    expect(agentModel({ agentId: 'openclaude', sessionId: OID }, home)).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh', source: 'session', at: T0 + 4000 })
    put(`.qoder/projects/C--Proj/${OID}.jsonl`, line({ type: 'assistant', sessionId: OID, timestamp: iso(5), message: { model: 'qoder-performance' } }) + '\n')
    expect(agentModel({ agentId: 'qoder', sessionId: OID }, home)).toEqual({ model: 'qoder-performance', effort: null, source: 'session', at: T0 + 5000 })
    put('.openclaude/settings.json', JSON.stringify({ model: 'sonnet', effortLevel: 'high' }))
    expect(agentModel({ agentId: 'openclaude' }, home)).toEqual({ model: 'sonnet', effort: 'high', source: 'settings' })
  })
})

describe('watching', () => {
  it("the new agents' files are watched", () => {
    const t = modelWatchTargets(home)
    const has = (agent, rel, name) => t.some((x) => x.agent === agent && x.dir === join(home, rel) && x.match.test(name))
    expect(has('kimi', '.kimi-code', 'config.toml')).toBe(true)
    expect(has('kimi', '.kimi-code/sessions', 'wire.jsonl')).toBe(true)
    expect(has('gemini', '.gemini/tmp', `session-2026-10-16T10-00-${GID.slice(0, 8)}.jsonl`)).toBe(true)
    expect(has('opencode', '.local/share/opencode', 'opencode.db-wal')).toBe(true)
    expect(has('pi', '.pi/agent/sessions', 'x.jsonl')).toBe(true)
    expect(has('droid', '.factory/sessions', `${GID}.settings.json`)).toBe(true)
    // A database written while its agent streams: at most every 5 s.
    expect(t.find((x) => x.dir === join(home, '.local/share/kilo')).every).toBe(5000)
  })
})
