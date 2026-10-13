// The explorer's "Open Editors" section, like VS Code's: every file open in
// the workspace's editor panes (their tabs, in order) and its web pages, as
// rows: name, where it is (its folder, relative to the project), unsaved,
// preview (italic), the one in use. Pure: App.vue gives the panes, ExplorerPanel
// draws the rows.
import { docPathOf, fileName, samePath } from '../editor/editorTabs'
import { isRemotePath, remoteHostPath } from '../../../shared/remotePath'

// As VS Code labels them: "C:\p\src\a.ts" under "C:\p" -> "src"; at the
// root -> the root itself ("C:\p"); elsewhere: its folder, the home folder as
// "~". Windows paths keep their backslashes, a host's its slashes.
export function folderLabel(path, root, home = '') {
  const shown = (p) => (isRemotePath(p) ? remoteHostPath(p) || p : String(p || ''))
  const norm = (p) => shown(p).replace(/\\/g, '/').replace(/\/+$/, '')
  const windows = /^[a-z]:[\\/]/i.test(shown(root) || shown(path))
  const out = (v) => (windows ? v.replace(/\//g, '\\') : v)
  const p = norm(path)
  const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
  const r = norm(root)
  if (r && dir.toLowerCase() === r.toLowerCase()) return out(r)
  if (r && dir.toLowerCase().startsWith(r.toLowerCase() + '/')) return out(dir.slice(r.length + 1))
  const h = norm(home)
  if (h && (dir.toLowerCase() === h.toLowerCase() || dir.toLowerCase().startsWith(h.toLowerCase() + '/'))) return out('~' + dir.slice(h.length))
  return out(dir)
}

// leaves: the workspace's panes in order ({ id, kind, files, activePath,
// title, url, paneName }); activeId: the pane in use; root: the project
// folder; isDirty(path); label(tab): the editor's own tab label (diffs).
// -> [{ key, kind: 'file' | 'page', paneId, tabPath, path, name, folder,
//      preview, dirty, active }]
export function openEditorsOf({ leaves = [], activeId = null, root = null, home = '', isDirty = () => false, label = null } = {}) {
  const out = []
  for (const leaf of leaves) {
    if (!leaf) continue
    if (leaf.kind === 'editor') {
      for (const f of leaf.files || []) {
        const path = docPathOf(f)
        if (!path) continue
        out.push({
          key: `${leaf.id}|${f.path}`,
          kind: 'file',
          paneId: leaf.id,
          tabPath: f.path,
          path,
          name: (label && !!f.diff && label(f)) || fileName(path),
          folder: folderLabel(path, root, home),
          preview: !!f.preview,
          diff: !!f.diff,
          dirty: !f.diff && !!isDirty(path),
          active: leaf.id === activeId && samePath(f.path, leaf.activePath)
        })
      }
    } else if (leaf.kind === 'browser') {
      const url = String(leaf.url || '')
      out.push({
        key: `${leaf.id}|page`, // i18n-ignore
        kind: 'page',
        paneId: leaf.id,
        tabPath: null,
        path: null,
        name: leaf.paneName || leaf.title || url,
        folder: url,
        preview: false,
        diff: false,
        dirty: false,
        active: leaf.id === activeId
      })
    }
  }
  return out
}
