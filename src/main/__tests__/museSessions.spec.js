// @vitest-environment node
// Muse Code's session logs, read as Tessel reads them: fixtures shaped like
// its session.jsonl (one record per line, or a batch whose children carry
// records as JSON text; recorded_at in microseconds), in a temporary home.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, resolve, sep } from 'path'
import {
  museConfigDir,
  museSessionsDir,
  museSessionLog,
  museSessionFolders,
  museSessionStart,
  museRecords,
  museModelFromText,
  museModelTimeline,
  parseMuseHead,
  museConversation,
  museTime
} from '../museSessions'
import { uuid7, rec, line, batch, museLog, dayOf, writeMuseSession } from './fixtures/museLog'

let dir, home
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-muse-sessions-'))
  home = join(dir, 'home')
  fs.mkdirSync(home)
})
afterEach(() => {
  const target = resolve(dir)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-muse-sessions-')) throw new Error('Unsafe fixture path')
  fs.rmSync(target, { recursive: true, force: true })
})

const writeSession = (id, lines, day) => writeMuseSession(museSessionsDir(home), id, lines, day)

describe('where Muse keeps its files', () => {
  it('~/.config/muse and ~/.local/share/muse/sessions, on every platform', () => {
    expect(museConfigDir(home, {})).toBe(join(home, '.config', 'muse'))
    expect(museSessionsDir(home, {})).toBe(join(home, '.local', 'share', 'muse', 'sessions'))
  })
  it("XDG folders belong to the real home only (never a test's or another account's)", () => {
    expect(museConfigDir(home, { XDG_CONFIG_HOME: join(dir, 'xdg') })).toBe(join(home, '.config', 'muse'))
    expect(museConfigDir(os.homedir(), { XDG_CONFIG_HOME: join(dir, 'xdg') })).toBe(join(dir, 'xdg', 'muse'))
    expect(museSessionsDir(os.homedir(), { XDG_DATA_HOME: 'relative' })).toBe(join(os.homedir(), '.local', 'share', 'muse', 'sessions'))
  })
})

describe('records', () => {
  it('a batch is unwrapped, microseconds become milliseconds', () => {
    const r = museRecords(JSON.parse(batch('2026-10-15T14:00:00Z', rec('run.model.configured', { record: { model_id: 'm1' } }, '2026-10-15T14:00:01Z'), 'not an object')))
    expect(r).toEqual([{ type: 'run.model.configured', at: Date.parse('2026-10-15T14:00:01Z'), payload: { record: { model_id: 'm1' } } }])
    expect(museTime(Date.parse('2026-10-15T14:00:00Z'))).toBe(Date.parse('2026-10-15T14:00:00Z'))
    expect(museTime('2026-10-15T14:00:00Z')).toBe(Date.parse('2026-10-15T14:00:00Z'))
    expect(museTime(null)).toBe(0)
  })
})

describe('a session log from its id', () => {
  it('found in the day its UUIDv7 names (a neighbouring day too: Muse’s time zone may differ)', () => {
    const ms = Date.parse('2026-10-15T23:30:00Z')
    const id = uuid7(ms)
    expect(museSessionStart(id)).toBe(ms)
    const file = writeSession(id, museLog(), dayOf(ms))
    expect(museSessionLog(id, museSessionsDir(home))).toBe(file)
    // The day after (the log written in a zone ahead of ours).
    const other = uuid7(ms, 'ffffffffffff')
    const shifted = writeSession(other, museLog(), dayOf(ms + 24 * 3600 * 1000))
    expect(museSessionLog(other, museSessionsDir(home))).toBe(shifted)
  })
  it('only a UUIDv7, only a file inside the sessions folder', () => {
    expect(museSessionLog('../../etc/passwd', museSessionsDir(home))).toBe(null)
    expect(museSessionLog('89cec4e6-00f8-47a4-b013-796a12edd5e4', museSessionsDir(home))).toBe(null)
    expect(museSessionLog(uuid7(Date.now()), museSessionsDir(home))).toBe(null)
  })
  it('the folders newest day first, newest first within a day, none from long before `since`', () => {
    const older = uuid7(Date.parse('2026-09-01T10:00:00Z'))
    const a = uuid7(Date.parse('2026-10-15T10:00:00Z'))
    const b = uuid7(Date.parse('2026-10-15T12:00:00Z'))
    writeSession(older, museLog(), ['2026', '09', '01'])
    writeSession(a, museLog())
    writeSession(b, museLog())
    fs.mkdirSync(join(museSessionsDir(home), '2026', '10', '15', 'not-a-session'), { recursive: true })
    expect(museSessionFolders(museSessionsDir(home)).map((f) => f.id)).toEqual([b, a, older])
    expect(museSessionFolders(museSessionsDir(home), { since: Date.parse('2026-10-14T00:00:00Z') }).map((f) => f.id)).toEqual([b, a])
    expect(museSessionFolders(museSessionsDir(home), { max: 1 }).map((f) => f.id)).toEqual([b])
  })
})

describe('model and effort', () => {
  it('the turn’s configured model and effort', () => {
    expect(museModelFromText(museLog().join('\n'))).toEqual({ model: 'muse-spark-1.3', effort: 'high', at: Date.parse('2026-10-15T14:00:05.300Z') })
  })
  it('a /models switch and an /effort change are newer (a batch included)', () => {
    const text = [
      ...museLog(),
      line('runtime.model_reconfigure.completed', { record: { effective: { model_id: 'muse-spark-1.3-contributor' } } }, '2026-10-15T14:05:00Z'),
      batch('2026-10-15T14:06:00Z', rec('runtime.reasoning_effort_reconfigure.completed', { record: { reasoning_effort: 'xhigh' } }, '2026-10-15T14:06:00Z'))
    ].join('\n')
    expect(museModelFromText(text)).toEqual({ model: 'muse-spark-1.3-contributor', effort: 'xhigh', at: Date.parse('2026-10-15T14:06:00Z') })
    expect(museModelTimeline(text)).toEqual([
      { t: Date.parse('2026-10-15T14:00:00Z'), model: 'muse-spark-1.3', effort: null },
      { t: Date.parse('2026-10-15T14:00:05.300Z'), model: 'muse-spark-1.3', effort: 'high' },
      { t: Date.parse('2026-10-15T14:05:00Z'), model: 'muse-spark-1.3-contributor', effort: 'high' },
      { t: Date.parse('2026-10-15T14:06:00Z'), model: 'muse-spark-1.3-contributor', effort: 'xhigh' }
    ])
  })
  it('an older log with only the model a request came back from; an effort outside its tiers is never taken', () => {
    const text = [
      line('runtime.session', { event: { kind: 'model_completed', model: 'muse-spark-1.2', usage: {} } }, '2026-10-15T14:00:09Z'),
      line('runtime.reasoning_effort_reconfigure', { record: { reasoning_effort: 'turbo' } }, '2026-10-15T14:00:10Z')
    ].join('\n')
    expect(museModelFromText(text)).toEqual({ model: 'muse-spark-1.2', effort: null })
    expect(museModelFromText('{"cut line')).toBe(null)
  })
})

describe('start, prompts and answers', () => {
  it('its folder, start, first prompt and model', () => {
    const head = parseMuseHead(museLog().join('\n'))
    expect(head).toMatchObject({ cwd: 'C:\\Users\\me\\proj', started: Date.parse('2026-10-15T14:00:00Z'), prompt: 'Fix the login bug', model: 'muse-spark-1.3' })
    // A prompt that is not really yours is passed over.
    const own = parseMuseHead(museLog({ prompt: '[Tessel] reminder' }).join('\n'), (t) => !t.startsWith('[Tessel]'))
    expect(own.prompt).toBe('')
  })
  it('each prompt once (taken in, then its turn started), answers without the commentary between tools', () => {
    expect(museConversation(museLog().join('\n'))).toEqual([
      { role: 'user', text: 'Fix the login bug', at: Date.parse('2026-10-15T14:00:05Z') },
      { role: 'assistant', text: 'Done: the token is refreshed.', at: Date.parse('2026-10-15T14:00:20Z') }
    ])
  })
})
