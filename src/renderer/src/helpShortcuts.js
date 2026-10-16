// Keyboard shortcuts and help (components/HelpDialog.vue): the shortcuts by
// group, in the interface's language, how each key is named there, and the
// search over them.
import { t } from './i18n'

// Each row: its keys ('Ctrl+Shift+T'; alternatives split by ' / ') and what
// they do. Panes and Terminal first, then Workspaces, Editor and App: two
// columns of about the same height.
export function shortcutGroups() {
  return [
    {
      title: t('app.help.panes', 'Panes'),
      rows: [
        ['Ctrl+Shift+T', t('app.help.newPane', 'New pane: the default agent, or the default shell')],
        ['Ctrl+Shift+Space', t('app.help.launcher', 'Open a terminal or agent')],
        ['Ctrl+Shift+P', t('app.help.palette', 'Command palette: find panes, workspaces, commands')],
        ['Ctrl+Shift+J', t('app.help.finder', "Jump to a file of the workspace's project")],
        ['Ctrl+Shift+E', t('app.help.splitRight', 'Split right')],
        ['Ctrl+Shift+O', t('app.help.splitDown', 'Split down')],
        ['Ctrl+Shift+W', t('app.help.closePane', 'Close pane')],
        ['Ctrl+Shift+R', t('app.help.restartPane', 'Restart pane')],
        ['Alt+Arrows', t('app.help.movePanes', 'Move between panes')],
        ['Esc', t('app.help.restoreMax', 'Restore a maximized pane')],
        ['Ctrl+`', t('app.help.floatingTerminal', 'Show or hide the floating terminal (the key left of 1)')]
      ]
    },
    {
      title: t('app.help.terminal', 'Terminal'),
      rows: [
        ['Ctrl+Shift+F', t('app.help.find', 'Find')],
        ['Ctrl+Shift+C', t('app.help.copy', 'Copy')],
        ['Ctrl+Shift+V', t('app.help.paste', 'Paste')],
        ['Ctrl+=', t('app.help.bigger', 'Bigger text')],
        ['Ctrl+-', t('app.help.smaller', 'Smaller text')],
        ['Ctrl+0', t('app.help.resetSize', 'Reset text size')],
        ['Shift+PageUp', t('app.help.scrollUp', 'Scroll up in the pane')],
        ['Shift+PageDown', t('app.help.scrollDown', 'Scroll down in the pane')]
      ]
    },
    {
      title: t('app.help.workspaces', 'Workspaces'),
      rows: [
        ['Ctrl+Shift+N', t('app.help.newWorkspace', 'New workspace')],
        ['Ctrl+PageUp', t('app.help.prevWorkspace', 'Previous workspace')],
        ['Ctrl+PageDown', t('app.help.nextWorkspace', 'Next workspace')]
      ]
    },
    {
      title: t('app.help.editor', 'Editor'),
      rows: [
        ['Ctrl+S', t('app.help.save', 'Save the file')],
        ['Ctrl+W', t('app.help.closeTab', 'Close the editor tab')],
        ['Ctrl+F', t('app.help.findInFile', 'Find in the file')],
        ['Ctrl+H', t('app.help.replace', 'Replace')],
        ['Ctrl+G', t('app.help.goToLine', 'Go to line')],
        ['Alt+Z', t('app.help.wordWrap', 'Word wrap on or off')],
        ['F7 / Shift+F7', t('app.help.nextChange', 'Next / previous change (a diff)')],
        ['Ctrl+Shift+A', t('app.help.reviewNote', 'Add Review Note (a diff: the selected lines)')]
      ]
    },
    {
      title: t('app.help.app', 'App'),
      rows: [
        ['Ctrl+Shift+B', t('app.help.broadcast', 'Broadcast typing to all panes')],
        ['Alt+A', t('app.help.chatApproval', 'In a chat pane: go to the request waiting for your answer')],
        ['Ctrl+Shift+K', t('app.help.taskBoard', 'Task board')],
        ['Ctrl+Shift+X', t('app.help.fileExplorer', 'File explorer')],
        ['Ctrl+Shift+G', t('app.help.sourceControl', 'Source Control (the git changes)')],
        ['Ctrl+,', t('app.help.settings', 'Settings')],
        ['Win+H', t('app.help.voice', 'Voice typing (Windows)')],
        ['F1', t('app.help.thisHelp', 'This help')]
      ]
    }
  ]
}

// A key's name as printed on the keyboard in the interface's language.
export function keyName(key) {
  switch (key) {
    case 'Ctrl':
      return t('app.help.key.ctrl', 'Ctrl')
    case 'Shift':
      return t('app.help.key.shift', 'Shift')
    case 'Alt':
      return t('app.help.key.alt', 'Alt')
    case 'Esc':
      return t('app.help.key.esc', 'Esc')
    case 'Space':
      return t('app.help.key.space', 'Space')
    case 'PageUp':
      return t('app.help.key.pageUp', 'Page Up')
    case 'PageDown':
      return t('app.help.key.pageDown', 'Page Down')
    case 'Arrows':
      return t('app.help.key.arrows', 'Arrow keys')
    default:
      return key
  }
}
// 'F7 / Shift+F7' -> [['F7'], ['Shift', 'F7']], each key named.
export function chordsOf(keys) {
  return String(keys)
    .split(' / ')
    .map((chord) => chord.split('+').map(keyName))
}

const fold = (text) =>
  String(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
// The groups with their rows ({ keys, text, chords }) that match a search,
// by what they do or by their keys as shown ("maj+t", "ctrl t").
export function filterShortcuts(groups, query) {
  const words = fold(query).split(/[\s+]+/).filter(Boolean)
  return groups
    .map((g) => ({
      title: g.title,
      rows: g.rows
        .map(([keys, text]) => ({ keys, text, chords: chordsOf(keys) }))
        .filter((row) => {
          if (!words.length) return true
          const hay = fold(`${g.title} ${row.text} ${row.chords.map((c) => c.join(' ')).join(' ')}`)
          return words.every((w) => hay.includes(w))
        })
    }))
    .filter((g) => g.rows.length)
}
