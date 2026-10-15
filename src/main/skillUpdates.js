// "Update available" for skills added from GitHub. About once a day, and
// when asked, the GitHub API says whether a newer commit touched a skill's
// folder since the one installed, and which commits ("what improved").
// Unauthenticated: GitHub allows 60 requests an hour per address, so
//   - one request per repository first (its newest commit, with the ETag of
//     the last answer: unchanged, GitHub answers 304), and a skill's folder
//     only when its repository moved past the installed commit;
//   - an answer about a fixed commit never changes: kept, never asked again;
//   - a few requests left in the hour are not used, and once GitHub says the
//     limit is reached (403 with none left, or 429), nothing is asked until
//     the time it gives;
//   - a repository that fails (blocked, offline) does not stop the others,
//     and a check that failed is not tried again for an hour unless asked.
// Before an update, only that skill's repository is asked. Records of skills
// whose folder is gone are dropped. State (answers, ETags, when) in one JSON
// file in Tessel's data folder.
import fsSync from 'node:fs'
import path from 'node:path'
import { t } from './i18n'
import { writeFileAtomic } from './safeJson'
import { parseGithubSpec, dropStaleSources } from './skillsManager'

export const UPDATE_CHECK = {
  every: 20 * 3600 * 1000, // about once a day
  retry: 3600 * 1000, // after a failed check, the next one on its own
  minGap: 60 * 1000, // a check asked for again within a minute: the last one
  perPage: 30, // commits listed since the installed one
  maxRequests: 40, // in one check
  keepRemaining: 5, // requests of the hour left for everything else
  timeout: 20000 // one request, its answer read whole
}

const API = 'https://api.github.com' // i18n-ignore URL
const SHA = /^[0-9a-f]{40}$/i
const fail = (message, code, extra) => Object.assign(new Error(message), code ? { code } : {}, extra || {})
const limited = (until) => fail('GitHub rate limit', 'SKILL_UPDATE_LIMIT', { until }) // i18n-ignore internal
const STOPS = ['SKILL_UPDATE_LIMIT', 'SKILL_UPDATE_BUDGET']

// One commit from the API -> { sha, message (first line), date (ms), author }.
export function mapCommit(c) {
  const commit = (c && c.commit) || {}
  const author = commit.author || {}
  const date = Date.parse((commit.committer && commit.committer.date) || author.date || '')
  return {
    sha: c && typeof c.sha === 'string' ? c.sha : '',
    message: String(commit.message || '').split(/\r?\n/)[0].slice(0, 200),
    date: Number.isFinite(date) ? date : null,
    author: String(author.name || (c && c.author && c.author.login) || '').slice(0, 100)
  }
}

// sources: the store of where each skill was added from (skillsManager.js).
export function createSkillUpdates(file, { sources, fetchFn = (...args) => fetch(...args), now = () => Date.now(), opts = UPDATE_CHECK } = {}) {
  let state = null
  const load = () => {
    if (state) return state
    try {
      const data = JSON.parse(fsSync.readFileSync(file, 'utf8'))
      state = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
    } catch {
      state = {}
    }
    for (const key of ['heads', 'lists', 'at']) if (!state[key] || typeof state[key] !== 'object') state[key] = {}
    return state
  }
  const save = () => {
    try {
      fsSync.mkdirSync(path.dirname(file), { recursive: true })
      writeFileAtomic(file, JSON.stringify(state))
    } catch {
      // not saved: checked again next time
    }
  }

  const repoKey = (s) => `${s.owner}/${s.repo}`.toLowerCase() + `@${s.ref || ''}`
  const listKey = (s, sha, p) => `${s.owner}/${s.repo}`.toLowerCase() + `@${String(sha).toLowerCase()}:${p || ''}`
  const isGithub = (s) => !!s && s.kind === 'github' && !!parseGithubSpec(`${s.owner}/${s.repo}`) && (s.ref == null || /^[A-Za-z0-9._/-]{1,200}$/.test(s.ref))

  // One check at a time (a full one, or one skill before its update).
  let chain = Promise.resolve()
  const queue = (fn) => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => {})
    return run
  }

  let requests = 0
  // The request and its answer, read whole, within the timeout.
  async function api(query, etag = null) {
    const st = load()
    if (st.limit && st.limit.remaining <= opts.keepRemaining && st.limit.reset > now()) throw limited(st.limit.reset)
    if (requests >= opts.maxRequests) throw fail(t('main.skills.updates.budget', 'Too many skills to check at once; the rest are checked next time.'), 'SKILL_UPDATE_BUDGET')
    requests++
    const ctrl = new AbortController()
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort()
        reject(fail(t('main.skills.updates.timeout', 'GitHub did not answer in time.'), 'SKILL_UPDATE_TIMEOUT'))
      }, opts.timeout)
    })
    try {
      return await Promise.race([ask(st, query, etag, ctrl.signal), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
  async function ask(st, query, etag, signal) {
    let res
    try {
      res = await fetchFn(API + query, {
        signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Tessel',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(etag ? { 'If-None-Match': etag } : {})
        }
      })
    } catch (err) {
      throw fail(t('main.skills.updates.offline', 'Could not reach GitHub: {{error}}', { error: (err && err.message) || String(err) }))
    }
    const header = (name) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null)
    const remainingText = header('x-ratelimit-remaining')
    const reset = Number(header('x-ratelimit-reset'))
    if (remainingText != null && remainingText !== '' && Number.isFinite(Number(remainingText)))
      st.limit = { remaining: Number(remainingText), reset: Number.isFinite(reset) && reset > 0 ? reset * 1000 : now() + 3600 * 1000 }
    if (res.status === 304) return { notModified: true }
    // Rate limited: 429, or 403 with none left or a Retry-After (any other
    // 403 is this repository's: blocked, and the others go on).
    const retryText = header('retry-after')
    const retry = retryText != null && retryText !== '' ? Number(retryText) : NaN
    if (res.status === 429 || (res.status === 403 && (remainingText === '0' || Number.isFinite(retry)))) {
      throw limited(Number.isFinite(retry) && retry > 0 ? now() + retry * 1000 : st.limit && st.limit.reset > now() ? st.limit.reset : now() + 3600 * 1000)
    }
    // Gone, private, empty, or a commit no longer there.
    if (res.status === 404 || res.status === 409 || res.status === 422) return { missing: true }
    if (!res.ok) throw fail(t('main.skills.httpError', 'GitHub answered {{status}}.', { status: res.status }))
    return { data: await res.json(), etag: header('etag') }
  }

  // The newest commit of a repository's branch (the default one without a
  // ref). Asked with the last ETag: a 304 keeps the last answer.
  async function headOf(g) {
    const st = load()
    const key = repoKey(g)
    const prev = st.heads[key]
    const ref = g.ref ? `&sha=${encodeURIComponent(g.ref)}` : ''
    const r = await api(`/repos/${g.owner}/${g.repo}/commits?per_page=1${ref}`, prev && prev.sha ? prev.etag : null)
    if (r.notModified && prev && prev.sha) {
      st.heads[key] = { sha: prev.sha, etag: prev.etag, at: now() }
      return prev.sha
    }
    if (r.missing) {
      st.heads[key] = { sha: null, missing: true, at: now() }
      return null
    }
    const first = Array.isArray(r.data) ? r.data[0] : null
    const sha = first && SHA.test(first.sha || '') ? first.sha : null
    st.heads[key] = { sha, etag: r.etag || null, at: now() }
    return sha
  }

  // The commits that touched a folder, newest first, as of a fixed commit.
  async function commitsAt(g, sha, folder) {
    const st = load()
    const key = listKey(g, sha, folder)
    if (st.lists[key]) return st.lists[key]
    const p = folder ? `&path=${encodeURIComponent(folder)}` : ''
    const r = await api(`/repos/${g.owner}/${g.repo}/commits?sha=${sha}&per_page=${opts.perPage}${p}`)
    const commits = !r.missing && Array.isArray(r.data) ? r.data.map(mapCommit).filter((c) => SHA.test(c.sha)) : []
    st.lists[key] = commits
    return commits
  }

  // The last commit that touched the folder in the installed commit.
  async function installedAt(g, commit, folder) {
    const st = load()
    const key = listKey(g, commit, folder)
    if (key in st.at) return st.at[key]
    const p = folder ? `&path=${encodeURIComponent(folder)}` : ''
    const r = await api(`/repos/${g.owner}/${g.repo}/commits?sha=${commit}&per_page=1${p}`)
    const first = !r.missing && Array.isArray(r.data) ? r.data[0] : null
    st.at[key] = first && SHA.test(first.sha || '') ? first.sha : null
    return st.at[key]
  }

  // One repository and its skills. used: the answers still needed.
  async function checkGroup(g, used) {
    if (used) used.heads.add(repoKey(g))
    const head = await headOf(g)
    if (!head) return
    const done = new Set()
    for (const s of g.copies) {
      // Up to date, or installed before Tessel kept the commit: nothing to ask.
      if (!s.commit || !SHA.test(s.commit) || s.commit.toLowerCase() === head.toLowerCase()) continue
      const folder = s.path || ''
      if (used) {
        used.lists.add(listKey(g, head, folder))
        used.at.add(listKey(g, s.commit, folder))
      }
      if (done.has(`${s.commit}:${folder}`)) continue // i18n-ignore key
      done.add(`${s.commit}:${folder}`) // i18n-ignore key
      await commitsAt(g, head, folder)
      await installedAt(g, s.commit, folder)
    }
  }

  async function run(force) {
    const st = load()
    const start = now()
    if (st.until && start < st.until) return { ok: false, checked: false, rateLimited: true, until: st.until }
    const idle = { ok: true, checked: false, checkedAt: st.checkedAt || null }
    if (force) {
      if (st.attemptAt && start - st.attemptAt < opts.minGap) return idle
    } else if ((st.checkedAt && start - st.checkedAt < opts.every) || (st.failedAt && start - st.failedAt < opts.retry)) return idle
    st.attemptAt = start
    requests = 0
    dropStaleSources(sources)
    const groups = new Map()
    for (const s of Object.values(sources ? sources.all() : {})) {
      if (!isGithub(s)) continue
      const key = repoKey(s)
      if (!groups.has(key)) groups.set(key, { owner: s.owner, repo: s.repo, ref: s.ref || null, copies: [] })
      groups.get(key).copies.push(s)
    }
    const used = { heads: new Set(), lists: new Set(), at: new Set() }
    const errors = []
    let stop = null
    for (const [key, g] of groups) {
      try {
        await checkGroup(g, used)
      } catch (err) {
        if (err && STOPS.includes(err.code)) {
          stop = err
          break
        }
        // This repository only: its last answers stay, the others go on.
        errors.push((err && err.message) || String(err))
        st.heads[key] = { ...(st.heads[key] || {}), error: (err && err.message) || String(err) }
      }
    }
    if (stop && stop.code === 'SKILL_UPDATE_LIMIT') st.until = stop.until
    else delete st.until
    if (!stop && (!groups.size || errors.length < groups.size)) {
      st.checkedAt = start
      delete st.failedAt
    } else st.failedAt = start
    // Answers no skill needs any more are dropped (after a full check only).
    if (!stop && !errors.length)
      for (const name of ['heads', 'lists', 'at']) for (const key of Object.keys(st[name])) if (!used[name].has(key)) delete st[name][key]
    save()
    if (stop && stop.code === 'SKILL_UPDATE_LIMIT') return { ok: false, checked: true, rateLimited: true, until: stop.until }
    if (stop) return { ok: false, checked: true, error: stop.message }
    if (errors.length) return { ok: false, checked: true, error: errors[0], checkedAt: st.checkedAt || null }
    return { ok: true, checked: true, checkedAt: st.checkedAt }
  }

  let running = null
  // force: asked by the user (still never within a minute, nor while GitHub's
  // limit lasts). -> { ok, checked, checkedAt?, rateLimited?, until?, error? }
  function check({ force = false } = {}) {
    if (!running) running = queue(() => run(force)).finally(() => (running = null))
    return running
  }

  // One skill's repository only (before its update).
  function checkSource(source) {
    return queue(async () => {
      const st = load()
      if (!isGithub(source) || (st.until && now() < st.until)) return
      requests = 0
      try {
        await checkGroup({ owner: source.owner, repo: source.repo, ref: source.ref || null, copies: [source] }, null)
      } catch (err) {
        if (err && err.code === 'SKILL_UPDATE_LIMIT') st.until = err.until
      }
      save()
    })
  }

  // What the last check says about a copy added from GitHub (null: not
  // checked yet). -> { available, checkedAt, latest, commits (since the
  // installed one, newest first), more (older ones not listed), missing }
  function infoFor(source) {
    if (!source || source.kind !== 'github' || !source.owner || !source.repo) return null
    const st = load()
    const head = st.heads[repoKey(source)]
    if (!head) return null
    const base = { checkedAt: head.at || st.checkedAt || null, available: false, latest: null, commits: [], more: false }
    if (head.missing) return { ...base, missing: true }
    if (!head.sha) return null
    if (!source.commit || source.commit.toLowerCase() === head.sha.toLowerCase()) return base
    const folder = source.path || ''
    const commits = st.lists[listKey(source, head.sha, folder)]
    const installed = st.at[listKey(source, source.commit, folder)]
    if (!commits || installed === undefined) return null
    if (!commits.length) return { ...base, missing: true }
    const at = installed ? commits.findIndex((c) => c.sha.toLowerCase() === installed.toLowerCase()) : -1
    const since = at >= 0 ? commits.slice(0, at) : commits
    return { ...base, available: since.length > 0, latest: commits[0], commits: since, more: at < 0 && commits.length >= opts.perPage }
  }

  function annotate(skills) {
    for (const skill of skills) if (skill.source && skill.source.kind === 'github') skill.update = infoFor(skill.source)
    return skills
  }

  // Before an update: that skill's repository asked again (ETag: mostly a
  // 304), then what changed since the installed copy.
  async function changesFor(dir) {
    const source = sources ? sources.get(dir) : null
    await checkSource(source).catch(() => null)
    return infoFor(source)
  }

  const status = () => {
    const st = load()
    return { checkedAt: st.checkedAt || null, until: st.until && st.until > now() ? st.until : null }
  }

  return { check, annotate, infoFor, changesFor, status }
}
