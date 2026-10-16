// How much of a terminal's output the window keeps for each pane (ptyStore.js
// replays it when the pane is mounted again), so the most a re-attach needs to
// send it (main's pty:attach: the host serializes the whole 5000-line
// history, several hundred KB per agent).
export const PANE_HISTORY_CHARS = 200_000
