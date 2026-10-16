// Live Share's virtual paths (src/shared/liveSharePath.js): strict parsing on
// both sides, and paths built the way the interface joins them.
import { describe, it, expect } from 'vitest'
import {
  isLsharePath,
  isVirtualPath,
  segmentOk,
  cleanRel,
  relSegments,
  lshareRoot,
  parseLsharePath,
  lsharePath,
  lshareChild,
  relInProject,
  LSHARE_LIMITS
} from '../liveSharePath'

describe('liveSharePath', () => {
  it('tells virtual paths from local ones', () => {
    expect(isLsharePath('lshare://p1')).toBe(true)
    expect(isLsharePath('C:\\x')).toBe(false)
    expect(isVirtualPath('lshare://p1\\a')).toBe(true)
    expect(isVirtualPath('ssh://ssh-1/home/me')).toBe(true)
    expect(isVirtualPath('C:\\Users\\me')).toBe(false)
    expect(isVirtualPath(null)).toBe(false)
  })

  it('accepts ordinary names and refuses what Windows reads otherwise', () => {
    for (const ok of ['a.js', '.env', '.tessel', 'TESSEL~1', 'my file.txt', ' lead', 'x'.repeat(255), 'nulx', 'con-fig', 'com10']) expect(segmentOk(ok), ok).toBe(true)
    const bad = ['', '.', '..', 'a:b', 'notes.md::$DATA', 'trail.', 'trail ', 'a/b', 'a\\b', 'tab\tx', 'nl\nx', 'del\u007fx', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'x'.repeat(256)]
    for (const b of bad) expect(segmentOk(b), JSON.stringify(b)).toBe(false)
    for (const dev of ['con', 'CON', 'prn', 'aux', 'nul', 'nul.txt', 'Nul .txt', 'com1', 'COM9.log', 'lpt1', 'com\u00b9', 'lpt\u00b3', 'conin$', 'CONOUT$', 'clock$']) expect(segmentOk(dev), dev).toBe(false)
  })

  it('reads wire paths strictly: relative, "/" only, every segment checked', () => {
    expect(cleanRel('')).toBe('')
    expect(cleanRel('src/a.js')).toBe('src/a.js')
    for (const bad of ['/etc/passwd', 'C:/Windows', 'C:\\Windows', '\\\\server\\share', '//server/share', '\\\\?\\C:\\x', '..', 'a/../b', './a', 'a//b', 'a/', 'src\\a.js', 'a/b:c', null, 42, {}]) expect(cleanRel(bad), JSON.stringify(bad)).toBe(null)
    expect(cleanRel('a/'.repeat(2048) + 'b')).toBe(null) // over 4096 characters
    expect(relSegments('')).toEqual([])
    expect(relSegments('a/b')).toEqual(['a', 'b'])
    expect(relSegments('a/..')).toBe(null)
  })

  it('parses virtual paths with either separator and builds them with "\\"', () => {
    expect(lshareRoot('proj-1')).toBe('lshare://proj-1')
    expect(lshareRoot('a b')).toBe(null)
    expect(parseLsharePath('lshare://proj-1')).toEqual({ project: 'proj-1', rel: '' })
    expect(parseLsharePath('lshare://proj-1\\src\\a.js')).toEqual({ project: 'proj-1', rel: 'src/a.js' })
    expect(parseLsharePath('lshare://proj-1/src/a.js')).toEqual({ project: 'proj-1', rel: 'src/a.js' })
    expect(parseLsharePath('lshare://proj-1\\src\\')).toEqual({ project: 'proj-1', rel: 'src' })
    for (const bad of ['lshare://', 'lshare://p\\..\\x', 'lshare://p\\a\\.\\b', 'lshare://p\\C:', 'lshare://p\\a:b', 'lshare://p q\\a', 'lshare://p\\nul', 'lshare://p\\a\u0000b', 'ssh://ssh-1/x', 'C:\\x']) expect(parseLsharePath(bad), bad).toBe(null)
    expect(lsharePath('p', 'src/a.js')).toBe('lshare://p\\src\\a.js')
    expect(lsharePath('p', '')).toBe('lshare://p')
    expect(lsharePath('p', '../x')).toBe(null)
    expect(lshareChild('lshare://p\\src', 'a.js')).toBe('lshare://p\\src\\a.js')
    expect(lshareChild('lshare://p\\src', '../a.js')).toBe(null)
  })

  it('takes a path in its own project only', () => {
    expect(relInProject('p', 'lshare://p\\src\\a.js')).toBe('src/a.js')
    expect(relInProject('p', 'lshare://other\\src\\a.js')).toBe(null)
    expect(relInProject('p', 'src\\a.js')).toBe('src/a.js')
    expect(relInProject('p', 'src/a.js')).toBe('src/a.js')
    expect(relInProject('p', '/src/a.js')).toBe(null)
    expect(relInProject('p', 'C:\\src\\a.js')).toBe(null)
    expect(relInProject('p', '..\\a.js')).toBe(null)
  })

  it('keeps the write cap under a guest message', () => {
    expect(LSHARE_LIMITS.writeBytes).toBeLessThan(1024 * 1024)
  })
})
