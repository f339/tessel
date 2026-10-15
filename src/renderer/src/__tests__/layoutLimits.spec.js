// How wide the side panels may be dragged, on any screen size.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { sidebarMaxWidth } from '../layoutLimits'

describe('panel widths on any screen', () => {
  it('the workspace sidebar: 500 px, or a third of a wide or ultrawide window', () => {
    expect(sidebarMaxWidth(1280)).toBe(500)
    expect(sidebarMaxWidth(1920)).toBe(576)
    expect(sidebarMaxWidth(5120)).toBe(1536)
    expect(sidebarMaxWidth(0)).toBe(500)
  })

  it('the right panel has no fixed ceiling: all but the terminals\' room next to the sidebar', () => {
    const app = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
    expect(app).not.toContain('TASK_PANEL_MAX')
    expect(app).toMatch(/const max = Math\.max\(TASK_PANEL_MIN, winWidth\.value - side - 420\)/)
  })
})
