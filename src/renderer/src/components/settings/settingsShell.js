// What a Settings page gets from SettingsDialog.vue, the shell around it:
//   page        the page shown (a ref: 'general', 'agents', …)
//   searching   true while the search box has text
//   shown(id)   whether a page shows now (its own page, or a search match)
//   go(id)      open another page
//   openMcpTab(tab), mcpTab   the MCP servers page, on one of its tabs
//   anchor      the part of a page Settings was opened on (a ref: an element
//               id, e.g. 'set-agent-terminal'), for a page with tabs to show
//               the tab that holds it
//   emit        the shell's emit: App.vue listens on SettingsDialog only, so
//               a page reports there (emit('open-tool', 'tools'), …)
// Every page renders all the time (hidden when not shown) so the search can
// read its text; a page's own re-render runs the search again, which the
// shell's onUpdated alone would miss.
import { inject, onUpdated } from 'vue'

export const SETTINGS_SHELL = Symbol('settings-shell')

export function useSettingsShell() {
  const shell = inject(SETTINGS_SHELL)
  onUpdated(shell.refreshSearch)
  return shell
}
