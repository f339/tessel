// Live Share phase 2b: a task branch's changes for a guest (the review, read
// only), as review.js reads them for the host, but with every git command
// made as a guest's:
//
// - the repository's hooks, filters, diff drivers, fsmonitor and the other
//   settings that run programs off, from every config file (gitSafety.js
//   guestGitArgs), and no external diff or textconv;
// - every path literal (--literal-pathspecs): a guest's "[.]env" or
//   "config/server.pe[m]" is never a pattern;
// - each git process counted in the guest's budget (charge(): false -> the
//   request is refused as busy), and what was read kept a little while (a
//   branch's facts REVIEW_TTL_MS, a file's diff while the branch stays the
//   same), so polling the review never costs more than reading it once.
//
// What the guest may ask the diff of is the caller's to check (exactly one
// of the files the branch changed that it may see: shareRequests.js); an
// answer that names more than one file (a folder, a file that became a
// folder) is refused here anyway.
import fs from 'fs'
import { resolve } from 'path'
import { run } from '../agentTools'
import { guestGitArgs } from '../gitSafety'
import { parseChangedFiles, parseCommits, parseMergeTree, parseStatusPaths } from '../../shared/diff'
import { parseWorktrees, BRANCH_RE, ANY_BRANCH_RE, REF_RE } from '../review'

export const REVIEW_TTL_MS = 15000
const MAX_DIFF = 600 * 1024
const CACHE_MAX = 64
const busy = () => Object.assign(new Error('busy'), { code: 'busy' }) // i18n-ignore internal: answered 'busy'
const no = (code) => ({ ok: false, code })

function samePath(a, b) {
  const x = resolve(a)
  const y = resolve(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

// `git diff --raw --numstat` in one run -> the three texts parseChangedFiles
// reads (the name-status lines are the raw lines' status and path).
export function splitRawNumstat(text) {
  const raw = []
  const numstat = []
  const ns = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line) continue
    if (line.startsWith(':')) {
      raw.push(line)
      const m = /^:\d+ \d+ [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*\t(.+)$/.exec(line)
      if (m) ns.push(`${m[1]}\t${m[2]}`)
    } else numstat.push(line)
  }
  return { ns: ns.join('\n'), numstat: numstat.join('\n'), raw: raw.join('\n') }
}

// createGuestReview({ git, gitArgs }) -> { info(copy, charge), diff(info,
// topPath, charge) }. copy: { root (the project's folder), path (the task's
// copy), branch, target } (the host's window's, never the guest's).
export function createGuestReview({ git: gitRun = run, gitArgs = guestGitArgs, clock = Date.now } = {}) {
  const infos = new Map() // copy key -> { at, value: Promise<info> }
  const diffs = new Map() // repo + base + head + path -> { ok, text, truncated }

  async function git(cwd, args, charge) {
    if (typeof charge === 'function' && charge() === false) throw busy()
    const prefix = await gitArgs(cwd)
    return gitRun('git', ['--literal-pathspecs', '-C', cwd, ...prefix, ...args], { timeout: 30000 })
  }

  async function read({ root, path, branch, target }, charge) {
    if (typeof branch !== 'string' || !ANY_BRANCH_RE.test(branch) || typeof target !== 'string' || !REF_RE.test(target) || branch === target) return no('not-found')
    const top = await git(root, ['rev-parse', '--show-toplevel'], charge)
    if (!top.ok) return no('not-repo')
    const repo = top.stdout.trim()
    // Only a copy git lists for this repository on that branch (never the
    // project folder itself); a branch of another prefix only while listed.
    let listed = null
    if (path) {
      if (samePath(path, repo)) return no('not-found')
      const list = await git(repo, ['worktree', 'list', '--porcelain'], charge)
      listed = parseWorktrees(list.stdout).find((w) => samePath(w.path, path)) || null
      if (listed && listed.branch !== `refs/heads/${branch}`) return no('not-found')
    }
    if (!BRANCH_RE.test(branch) && !listed) return no('not-found')
    const refs = await git(repo, ['rev-parse', `${branch}^{commit}`, `${target}^{commit}`], charge)
    if (!refs.ok) return no('not-found')
    const head = refs.stdout.split(/\r?\n/)[0].trim()
    if (!/^[0-9a-f]{40,64}$/.test(head)) return no('failed')
    const mb = await git(repo, ['merge-base', target, head], charge)
    if (!mb.ok) return no('not-found')
    const base = mb.stdout.trim()
    const changed = await git(repo, ['diff', '--no-renames', '--no-abbrev', '--no-ext-diff', '--no-textconv', '--raw', '--numstat', base, head], charge)
    if (!changed.ok) return no('failed')
    const { ns, numstat, raw } = splitRawNumstat(changed.stdout)
    const log = await git(repo, ['log', '--format=%H%x1f%an%x1f%ct%x1f%s%x1f%b%x1e', '-n', '50', `${base}..${head}`], charge)
    const merge = await git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', target, head], charge)
    const behind = await git(repo, ['rev-list', '--count', `${head}..${target}`], charge)
    const copyExists = !!(path && fs.existsSync(path))
    let uncommitted = []
    if (listed && copyExists) {
      const st = await git(path, ['status', '--porcelain=v1', '--untracked-files=all'], charge)
      if (st.ok) uncommitted = parseStatusPaths(st.stdout)
    }
    return {
      ok: true,
      repo,
      branch,
      target,
      base,
      head,
      files: parseChangedFiles(ns, numstat, raw),
      commits: log.ok ? parseCommits(log.stdout) : [],
      // merge-tree exits 1 with conflicts, other codes on errors.
      conflicts: merge.code === 1 ? parseMergeTree(merge.stdout) : [],
      mergeCheck: merge.ok || merge.code === 1 ? 'done' : 'failed',
      uncommitted,
      behind: Number(behind.stdout.trim()) || 0,
      copyExists
    }
  }

  // A branch's facts, kept REVIEW_TTL_MS (a failure is not kept).
  function info(copy, charge) {
    const key = [copy.root, copy.path, copy.branch, copy.target].join('\n')
    const hit = infos.get(key)
    if (hit && clock() - hit.at < REVIEW_TTL_MS) return hit.value
    const value = read(copy, charge).then((res) => {
      if (!res.ok && infos.get(key) && infos.get(key).value === value) infos.delete(key)
      return res
    })
    // A refusal (busy) is not kept either.
    value.catch(() => infos.get(key) && infos.get(key).value === value && infos.delete(key))
    infos.set(key, { at: clock(), value })
    if (infos.size > CACHE_MAX) infos.delete(infos.keys().next().value)
    return value
  }

  // One changed file's diff (topPath: from the repository's top, one of
  // info.files). -> { ok, text, truncated } | { ok: false, code }
  async function diff(branch, topPath, charge) {
    const key = [branch.repo, branch.base, branch.head, topPath].join('\n')
    if (diffs.has(key)) return diffs.get(key)
    const res = await git(branch.repo, ['diff', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', branch.base, branch.head, '--', topPath], charge)
    if (!res.ok) return no('failed')
    // One file's answer only (a folder, or a file that became one, names
    // several).
    if ((res.stdout.match(/^diff --git /gm) || []).length > 1) return no('not-found')
    const tooBig = res.stdout.length > MAX_DIFF
    const out = { ok: true, text: tooBig ? res.stdout.slice(0, MAX_DIFF) : res.stdout, truncated: tooBig }
    diffs.set(key, out)
    if (diffs.size > CACHE_MAX) diffs.delete(diffs.keys().next().value)
    return out
  }

  return { info, diff }
}
