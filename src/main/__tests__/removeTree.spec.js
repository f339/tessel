// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, resolve, sep } from 'path'
import { removeTreeSync } from '../removeTree'

let root
beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'tessel-remove-tree-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  const target = resolve(root)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-remove-tree-'))
    throw new Error('Unexpected cleanup path')
  fs.rmSync(target, { recursive: true, force: true })
})
const put = (file, text = 'x') => {
  fs.mkdirSync(join(file, '..'), { recursive: true })
  fs.writeFileSync(file, text)
}
const junction = (target, path) => fs.symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')

describe('removeTreeSync', () => {
  it('removes a folder and what it holds, a junction inside removed itself and never what it points to', () => {
    const outside = join(root, 'outside')
    put(join(outside, 'keep.txt'), 'keep')
    const tree = join(root, 'tree')
    put(join(tree, 'a.txt'))
    put(join(tree, 'deep', 'er', 'b.txt'))
    junction(outside, join(tree, 'deep', 'link'))
    // Electron's fs.rmSync goes through a junction (Node's in these tests does not): never used.
    const rm = vi.spyOn(fs, 'rmSync')
    removeTreeSync(tree)
    expect(fs.existsSync(tree)).toBe(false)
    expect(fs.readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    expect(rm).not.toHaveBeenCalled()
  })

  it('a junction given itself is unlinked, a file removed, and nothing happens when the path is gone', () => {
    const outside = join(root, 'outside')
    put(join(outside, 'keep.txt'), 'keep')
    junction(outside, join(root, 'link'))
    removeTreeSync(join(root, 'link'))
    expect(fs.existsSync(join(root, 'link'))).toBe(false)
    expect(fs.existsSync(join(outside, 'keep.txt'))).toBe(true)
    put(join(root, 'file.txt'))
    removeTreeSync(join(root, 'file.txt'))
    expect(fs.existsSync(join(root, 'file.txt'))).toBe(false)
    expect(() => removeTreeSync(join(root, 'missing'))).not.toThrow()
  })

  it('an entry that cannot go stops the removal with its error (what was not reached stays)', () => {
    const tree = join(root, 'tree')
    put(join(tree, 'held.txt'))
    const real = fs.unlinkSync.bind(fs)
    vi.spyOn(fs, 'unlinkSync').mockImplementation((path) => {
      if (String(path).endsWith('held.txt')) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return real(path)
    })
    expect(() => removeTreeSync(tree)).toThrow(/busy/)
    expect(fs.existsSync(join(tree, 'held.txt'))).toBe(true)
  })
})
