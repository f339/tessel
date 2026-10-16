// A task board that is not this computer's (a Live Share host's): the board
// (TaskBoard.vue) and its cards (TaskCard.vue) take a `source` instead of the
// store (taskBoardStore.js). Without one they show and change this computer's
// board, as always.
//
//   source = {
//     tasks,                 the cards (taskModel shape): an array (reactive)
//                            or a function returning one; only this project's
//     loaded?: boolean,      false while the first cards are on their way
//     error?: string,        why they could not be read
//     state?: 'ok' | 'no-access' | 'outdated-host' | 'ended',
//     // What may be done, each only when given (none: read-only). The
//     // host checks each again.
//     add?({ title }),
//     move?(id, column),
//     edit?(id, { title }),
//     remove?(id),
//     answer?(id, answer),   a question the agent asked (team_task_gate)
//   }
//
// The source can be reactive: a mutator taken away (set to null) hides its
// controls at once.

export function cardsOf(source) {
  const list = source ? (typeof source.tasks === 'function' ? source.tasks() : source.tasks) : null
  return Array.isArray(list) ? list : []
}

const ALL = Object.freeze({ add: true, move: true, edit: true, remove: true, answer: true, any: true })

// What the board lets you do: everything for this computer's board.
export function canOf(source) {
  if (!source) return ALL
  const can = {}
  for (const k of ['add', 'move', 'edit', 'remove', 'answer']) can[k] = typeof source[k] === 'function'
  can.any = Object.values(can).some(Boolean)
  return can
}
