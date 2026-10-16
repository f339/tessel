// Muse Code session-log fixtures, shaped like its session.jsonl: one record
// per line ({ record_type, payload_type, recorded_at in microseconds,
// payload }), or a batch whose children carry records as JSON text. The
// layout is <sessions>/YYYY/MM/DD/<UUIDv7 id>/session.jsonl.
import fs from 'fs'
import { join } from 'path'

// A UUIDv7 whose time is `ms` (what Muse names a session).
export const uuid7 = (ms, tail = 'a1b2c3d4e5f6') => {
  const h = ms.toString(16).padStart(12, '0')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7abc-8def-${tail}`
}
const at = (iso) => Date.parse(iso) * 1000 // Muse's microseconds
export const rec = (payload_type, payload, iso) => ({ record_type: 'durable', payload_type, recorded_at: at(iso), payload })
export const line = (...args) => JSON.stringify(rec(...args))
export const batch = (iso, ...records) =>
  JSON.stringify({ record_type: 'retained_frame', payload_type: 'retained_frame', recorded_at: at(iso), children: records.map((r) => ({ record_json: JSON.stringify(r) })) })

// A session as Muse writes it: metadata, a prompt (taken in, then its turn
// started), the turn's model, a request, commentary between tools, an answer.
export function museLog({ cwd = 'C:\\Users\\me\\proj', model = 'muse-spark-1.3', effort = 'high', prompt = 'Fix the login bug', answer = 'Done: the token is refreshed.' } = {}) {
  return [
    line('runtime.session.metadata', { record: { workspace_root: cwd, model_id: model } }, '2026-10-15T14:00:00Z'),
    line('runtime.session.route_facts', { record: { cwd } }, '2026-10-15T14:00:00.100Z'),
    line('runtime.user_intent.accepted', { refill_blocks: [{ type: 'text', text: prompt }] }, '2026-10-15T14:00:05Z'),
    line('runtime.session', { run_id: 'run-1', event: { kind: 'started', prompt } }, '2026-10-15T14:00:05.200Z'),
    line('run.model.configured', { record: { model_id: model, ...(effort ? { reasoning_effort: effort } : {}) } }, '2026-10-15T14:00:05.300Z'),
    line('runtime.session', { event: { kind: 'model_completed', model, usage: { input_tokens: 1200, output_tokens: 80 } } }, '2026-10-15T14:00:09Z'),
    line('runtime.session', { event: { kind: 'assistant_message_committed', text: 'Looking at the auth module.', phase: 'commentary' } }, '2026-10-15T14:00:09.500Z'),
    line('runtime.session', { event: { kind: 'assistant_message_committed', text: answer } }, '2026-10-15T14:00:20Z')
  ]
}

// The day folder of a time, local (Muse names it in its own zone).
export const dayOf = (ms) => {
  const d = new Date(ms)
  return [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')]
}

// Written under `sessionsDir`; -> the log's path.
export function writeMuseSession(sessionsDir, id, lines, day = ['2026', '10', '15']) {
  const folder = join(sessionsDir, ...day, id)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(join(folder, 'session.jsonl'), lines.join('\n') + '\n')
  return join(folder, 'session.jsonl')
}
