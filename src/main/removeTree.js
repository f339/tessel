// Deleting a folder without ever going through a link. Electron's fs.rmSync
// (Electron 42) goes through a directory junction and empties the folder it
// points to, so nothing here deletes with it: every entry is looked at, as in
// worktreeLeftover.js. A junction or symbolic link (lstat says isSymbolicLink,
// junctions included on Windows) is removed itself, never what it points to;
// so is a folder whose real path is not where it stands (another kind of
// reparse point), without looking inside. A folder is emptied, then removed.
import fs from 'fs'
import { basename, dirname, join, resolve } from 'path'

const pathKey = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))

function realOf(path) {
  try {
    return fs.realpathSync.native(path)
  } catch {
    return null
  }
}

// A junction or symbolic link: removed itself, never what it points to.
function unlinkLink(path) {
  try {
    fs.unlinkSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    // A directory link on some systems: rmdir removes the link, and never
    // anything inside (it fails on a folder that is not empty).
    fs.rmdirSync(path)
  }
}

function unlinkFile(path) {
  try {
    fs.unlinkSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error
    // A read-only file.
    fs.chmodSync(path, 0o666)
    fs.unlinkSync(path)
  }
}

// `expected`: where `path` really is when no link leads to it.
function removeEntry(path, expected) {
  let stat
  try {
    stat = fs.lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) return unlinkLink(path)
  if (!stat.isDirectory()) return unlinkFile(path)
  const real = realOf(path)
  if (!real || pathKey(real) !== pathKey(expected)) return unlinkLink(path)
  for (const name of fs.readdirSync(path)) removeEntry(join(path, name), join(real, name))
  fs.rmdirSync(path)
}

// Deletes `path`: a folder with everything in it, a file or a link. Nothing
// when it is already gone; any other error is thrown (what was not reached
// yet stays).
export function removeTreeSync(path) {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  removeEntry(absolute, join(realOf(parent) || parent, basename(absolute)))
}
