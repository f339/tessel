// A commit's hover card (TimelineHover.vue) on a list of commits (Source
// Control's Commits), as the Timeline shows it: after 500 ms on a row (at
// once when moving from one row to the next), kept while the pointer is on
// the card, its numbers and GitHub page read once per commit.
import { reactive } from 'vue'

// A commit of scmHistory (sourceControl.js parseHistoryLog) as a Timeline
// entry TimelineHover reads.
export function commitEntry(item) {
  if (!item || !item.id) return null
  return {
    id: item.id,
    kind: 'commit',
    time: item.timestamp || 0,
    label: item.subject || '',
    commit: { id: item.id, author: item.author || '', email: item.authorEmail || '', message: item.message || item.subject || '' }
  }
}

export function useCommitHover({ root, now = () => Date.now(), api = () => window.shellApi && window.shellApi.scm } = {}) {
  const hover = reactive({ entry: null, anchor: null })
  const infos = reactive({})
  let showTimer = 0
  let hideTimer = 0
  let hiddenAt = 0

  const rectOf = (el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, height: r.height }
  }
  async function loadInfo(id) {
    const scm = api()
    const where = typeof root === 'function' ? root() : root
    if (infos[id] || !scm || !scm.commitInfo || !where) return
    infos[id] = { pending: true }
    const res = await Promise.resolve(scm.commitInfo({ root: where, commit: id })).catch(() => null)
    infos[id] = res && res.ok ? { stats: res.stats || null, webUrl: res.webUrl || null } : { stats: null, webUrl: null }
  }
  function show(entry, el) {
    if (!entry || !el || !el.isConnected) return
    hover.entry = entry
    hover.anchor = rectOf(el)
    loadInfo(entry.commit.id)
  }
  function hide() {
    clearTimeout(showTimer)
    clearTimeout(hideTimer)
    if (hover.entry) hiddenAt = now()
    hover.entry = null
    hover.anchor = null
  }
  function onRowEnter(entry, ev) {
    clearTimeout(hideTimer)
    if (!entry || (hover.entry && hover.entry.id === entry.id)) return
    clearTimeout(showTimer)
    const el = ev.currentTarget
    const quick = !!hover.entry || now() - hiddenAt < 200
    showTimer = setTimeout(() => show(entry, el), quick ? 0 : 500)
  }
  function onRowLeave() {
    clearTimeout(showTimer)
    clearTimeout(hideTimer)
    hideTimer = setTimeout(hide, 150)
  }
  function onCardEnter() {
    clearTimeout(hideTimer)
  }
  const info = () => (hover.entry ? infos[hover.entry.commit.id] || null : null)
  function dispose() {
    clearTimeout(showTimer)
    clearTimeout(hideTimer)
  }
  return { hover, info, onRowEnter, onRowLeave, onCardEnter, hide, dispose }
}
