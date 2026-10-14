// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import { join, resolve, sep } from 'path'
import { removeOwnedDirectory } from '../claudeAccountsStorage'

const MARKER = '.tessel-managed-claude-auth'
let root
beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'tessel-claude-storage-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  const target = resolve(root)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-claude-storage-'))
    throw new Error('Unexpected cleanup path')
  fs.rmSync(target, { recursive: true, force: true })
})

describe('removeOwnedDirectory', () => {
  it('a folder still held when it would go (a browser working in it) is marked again, with its age, so a later cleanup can finish it', async () => {
    const folder = join(root, 'login-1')
    fs.mkdirSync(join(folder, 'AppData'), { recursive: true })
    fs.writeFileSync(join(folder, 'AppData', 'cookies'), 'x')
    fs.writeFileSync(join(folder, MARKER), 'login:1\n')
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    fs.utimesSync(join(folder, MARKER), hoursAgo, hoursAgo)
    const real = fsp.rmdir.bind(fsp)
    const rmdir = vi.spyOn(fsp, 'rmdir').mockImplementation(async (path, ...rest) => {
      if (resolve(String(path)) === resolve(folder)) throw Object.assign(new Error('held'), { code: 'EPERM' })
      return real(path, ...rest)
    })
    await expect(removeOwnedDirectory(root, folder, MARKER, 'login:1')).rejects.toThrow('held')
    expect(fs.readdirSync(folder)).toEqual([MARKER])
    expect(fs.readFileSync(join(folder, MARKER), 'utf8')).toBe('login:1\n')
    expect(Math.abs(fs.statSync(join(folder, MARKER)).mtimeMs - hoursAgo.getTime())).toBeLessThan(2000)
    rmdir.mockRestore()
    await removeOwnedDirectory(root, folder, MARKER, 'login:1')
    expect(fs.existsSync(folder)).toBe(false)
  })
})
