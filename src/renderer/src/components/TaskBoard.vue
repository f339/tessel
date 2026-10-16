<script setup>
// The Agent Task Board: a 4-column kanban (todo / doing / review / done) rendered
// from the shared reactive store. It owns only the add-task control and the
// column layout; each task is a TaskCard that talks to the store itself. Tasks
// are bucketed once per change (O(n)) and rendered with a stable :key, so a
// single task update re-renders just that card, not the whole board.
// Given a source (a Live Share host's board, taskBoardSource.js), it shows
// that board's cards and offers only what the source lets you do.

import { ref, computed, inject, watch } from 'vue'
import { COLUMNS } from '../../../shared/taskModel'
import { tasks, addTask, moveTask, removeTask, boardState } from '../taskBoardStore'
import { cardsOf, canOf } from '../taskBoardSource'
import { accessStateText } from '../liveShareGuestAccess'
import PanelState from './ui/PanelState.vue'
import TaskCard from './TaskCard.vue'
import OrchestrationCard from './OrchestrationCard.vue'
import JobCostLine from './JobCostLine.vue'
import { useJobCost, refreshJobCost, sumJobCosts, withLiveTime } from '../jobCost'
import { useNow } from '../chat/orca/composables/use-now'
import { t } from '../i18n'

const props = defineProps({
  // Agent panes available for assignment, forwarded to every card.
  agentPanes: { type: Array, default: () => [] },
  // Each workspace has its own board: show and add tasks for this one.
  // (null shows every task.)
  workspaceId: { type: String, default: null },
  // Another board than this computer's (taskBoardSource.js): its cards, and
  // only what it lets you do. null: this computer's board.
  source: { type: Object, default: null }
})

const emit = defineEmits(['new-task', 'focus-pane', 'review'])
const newTitle = ref('')

// The cards shown and what may be done to them: a source's (only its
// project's cards, nothing of this computer's), else the store's.
const cards = computed(() => (props.source ? cardsOf(props.source) : tasks))
const can = computed(() => canOf(props.source))
const loaded = computed(() => (props.source ? props.source.loaded !== false : boardState.loaded))
const loadError = computed(() => (props.source ? props.source.error || '' : boardState.error))
const sourceState = computed(() => (props.source && props.source.state && props.source.state !== 'ok' ? props.source.state : null))

// One pass over tasks → { todo: [...], doing: [...], ... }. Reads only each
// task's column, so renaming/assigning a task doesn't invalidate the grouping.
const grouped = computed(() => {
  const groups = Object.fromEntries(COLUMNS.map((c) => [c, []]))
  for (const task of cards.value) {
    if (!props.source && props.workspaceId && task.wsId !== props.workspaceId) continue
    if (groups[task.column]) groups[task.column].push(task)
  }
  // Each column in the order cards arrived in it (Done: the order they were
  // finished), the latest at the bottom. Cards from before this was recorded
  // keep their place at the top.
  for (const c of COLUMNS) groups[c].sort((a, b) => (a.columnSince || 0) - (b.columnSince || 0))
  return groups
})

// What each visible card's work used (tokens, time, estimated cost), asked
// for the cards on this board, again when a card moves or changes agent, and
// when the main process says the figures changed (jobCost.js, throttled).
const visibleTasks = computed(() => COLUMNS.flatMap((c) => grouped.value[c]))
// A source's cards are not this computer's: no figures asked for them.
const fetchedCost = useJobCost('cards', () => (props.source ? [] : visibleTasks.value.map((task) => task.id)))
// A card in Doing: its time goes on between two reads (a clock only while one is).
const clock = useNow(15000, () => visibleTasks.value.some((task) => task.column === 'doing'))
const costOf = (task) => (props.source ? null : withLiveTime(fetchedCost(task.id), task, clock.value))
watch(
  () => visibleTasks.value.map((task) => `${task.id}:${task.column}:${task.paneId || ''}`).join('|'), // i18n-ignore
  () => refreshJobCost()
)
// The total of the visible cards, at the top of the board.
const costTotal = computed(() => sumJobCosts(props.source ? [] : visibleTasks.value.map((task) => costOf(task))))
const costTotalTitle = computed(() => {
  const total = costTotal.value
  const lines = [total.count === 1
      ? t('jobCost.total.cards', '{{count}} task with usage', { count: 1 })
      : t('jobCost.total.cards', '{{count}} tasks with usage', { count: total.count })]
  if (total.unknownCount)
    lines.push(t('jobCost.total.unknown', '{{count}} of them with an unknown cost (not counted)', { count: total.unknownCount }))
  return lines.join('\n')
})

function onAdd() {
  const title = newTitle.value.trim()
  // Guard before calling the store — createTask throws on an empty title, and a
  // blank submit should simply be a no-op.
  if (!title || !can.value.add) return
  if (props.source) props.source.add({ title })
  else addTask({ title, wsId: props.workspaceId })
  newTitle.value = ''
}

// Dropping a dragged card (TaskCard) on a column moves it there.
const TASK_DRAG_TYPE = 'application/x-tessel-task'
// A drag that ends anywhere (dropped elsewhere, Esc) clears it (dragend on
// the board, in the template).
const dropColumn = ref(null)
function isTaskDrag(e) {
  return can.value.move && !!e.dataTransfer && [...e.dataTransfer.types].includes(TASK_DRAG_TYPE)
}
function onDragOver(e, column) {
  if (!isTaskDrag(e)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  dropColumn.value = column
}
function onDragLeave(e, column) {
  // Only when the pointer really leaves the column (not into one of its cards).
  if (dropColumn.value === column && !e.currentTarget.contains(e.relatedTarget)) dropColumn.value = null
}
function onDrop(e, column) {
  dropColumn.value = null
  if (!isTaskDrag(e)) return
  e.preventDefault()
  const id = e.dataTransfer.getData(TASK_DRAG_TYPE)
  const task = cards.value.find((t) => t.id === id)
  if (!task || task.column === column) return
  if (props.source) props.source.move(id, column)
  else moveTask(id, column)
}

// Done > Select: tick finished cards and delete them together.
const selecting = ref(false)
const picked = ref([]) // task ids
const deleteTasks = inject('deleteTasks', null)
function startSelect() {
  selecting.value = true
  picked.value = []
}
function stopSelect() {
  selecting.value = false
  picked.value = []
}
function togglePick(id) {
  picked.value = picked.value.includes(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id]
}
const allPicked = computed(() => grouped.value.done.length > 0 && grouped.value.done.every((t) => picked.value.includes(t.id)))
function pickAll() {
  picked.value = allPicked.value ? [] : grouped.value.done.map((t) => t.id)
}
async function deletePicked() {
  const ids = picked.value.slice()
  if (!ids.length) return
  // A source's board: its host deletes them (and asks nothing here).
  if (props.source) {
    if (!can.value.remove) return
    ids.forEach((id) => props.source.remove(id))
    return stopSelect()
  }
  // The app asks once and cleans up copies; alone (tests), direct.
  const done = deleteTasks ? await deleteTasks(ids) : (ids.forEach((id) => removeTask(id)), true)
  if (done) stopSelect()
}
// A card that left Done (moved, deleted) is no longer picked; nothing left
// in Done ends the selection.
watch(
  () => grouped.value.done.map((t) => t.id),
  (ids) => {
    picked.value = picked.value.filter((id) => ids.includes(id))
    if (!ids.length) selecting.value = false
  }
)
// Deleting taken away (a source's): the selection ends.
watch(
  () => can.value.remove,
  (on) => {
    if (!on) stopSelect()
  }
)

function columnLabel(column) {
  const labels = {
    todo: t('tasks.column.todo', 'To do'),
    doing: t('tasks.column.doing', 'Doing'),
    review: t('tasks.column.review', 'Review'),
    done: t('tasks.column.done', 'Done')
  }
  return labels[column] || column
}

const deleteLabel = computed(() =>
  picked.value.length
    ? t('tasks.board.deleteCount', 'Delete ({{count}})', { count: picked.value.length })
    : t('tasks.board.delete', 'Delete')
)
</script>

<template>
  <div class="task-board" @dragend="dropColumn = null" @keydown.escape="selecting && stopSelect()">
    <div v-if="!source" class="task-board-head">
      <button
        class="task-board-new"
        type="button"
        :title="t('tasks.board.newTaskHint', 'Give a task to an agent, in its own copy of the project')"
        @click="emit('new-task')"
      >
        {{ t('tasks.board.newTask', 'New task…') }}
      </button>
    </div>
    <div v-if="costTotal.count" class="task-board-total" data-test="task-board-cost" :title="costTotalTitle">
      <span class="job-cost">{{ t('jobCost.total.label', 'Total:') }}</span>
      <JobCostLine :entry="costTotal" />
    </div>
    <p v-if="source && !sourceState && !can.any" class="task-board-readonly" data-test="board-read-only">
      {{ t('tasks.board.readOnly', 'Read-only: the host has not let you manage tasks.') }}
    </p>
    <form v-if="can.add && !sourceState" class="task-board-add" data-test="add-task-form" @submit.prevent="onAdd">
      <input
        v-model="newTitle"
        class="task-board-input"
        type="text"
        :placeholder="t('tasks.board.addPlaceholder', 'Add a task…')"
        data-test="new-task-input"
      />
      <button class="task-board-add-btn" type="submit">{{ t('tasks.board.add', 'Add') }}</button>
    </form>

    <!-- Orchestration: a lead's workers (allow, stop, go to them). -->
    <OrchestrationCard v-if="!source" :workspace-id="workspaceId" />

    <!-- A source's board the host no longer shares (or cannot). -->
    <PanelState v-if="sourceState" kind="error" :retry="false" :text="accessStateText(sourceState)" data-test="board-access" />
    <!-- The saved board is still being read at launch: not "No tasks" yet. -->
    <PanelState v-else-if="!loaded" :rows="2" data-test="board-loading" />
    <PanelState
      v-else-if="loadError"
      kind="error"
      :retry="false"
      :text="source ? t('tasks.board.sourceFailed', 'The host’s task board could not be read: {{error}}', { error: loadError }) : t('tasks.board.loadFailed', 'The saved task board could not be read: {{error}}', { error: loadError })"
      data-test="board-error"
    />

    <div v-if="loaded && !sourceState" class="task-board-columns">
      <section
        v-for="column in COLUMNS"
        :key="column"
        class="task-column"
        :class="{ 'drop-here': dropColumn === column }"
        data-test="column"
        :data-column="column"
        @dragover="(e) => onDragOver(e, column)"
        @dragleave="(e) => onDragLeave(e, column)"
        @drop="(e) => onDrop(e, column)"
      >
        <header class="task-column-head">
          <span class="task-column-title">{{ columnLabel(column) }}</span>
          <span class="task-column-count">{{ grouped[column].length }}</span>
          <span v-if="column === 'done' && grouped.done.length && can.remove" class="task-column-tools">
            <template v-if="!selecting">
              <button type="button" class="task-head-btn" data-test="select-done" :title="t('tasks.board.selectHint', 'Pick finished tasks to delete them together')" @click="startSelect">
                {{ t('tasks.board.select', 'Select') }}
              </button>
            </template>
            <template v-else>
              <button type="button" class="task-head-btn" data-test="pick-all" @click="pickAll">
                {{ allPicked ? t('tasks.board.pickNone', 'None') : t('tasks.board.pickAll', 'All') }}
              </button>
              <button
                type="button"
                class="task-head-btn danger"
                data-test="delete-picked"
                :disabled="!picked.length"
                @click="deletePicked"
              >
                {{ deleteLabel }}
              </button>
              <button type="button" class="task-head-btn" data-test="cancel-select" @click="stopSelect">{{ t('tasks.board.cancel', 'Cancel') }}</button>
            </template>
          </span>
        </header>
        <div class="task-column-body">
          <TaskCard
            v-for="task in grouped[column]"
            :key="task.id"
            :task="task"
            :agent-panes="agentPanes"
            :selectable="selecting && column === 'done'"
            :selected="picked.includes(task.id)"
            :cost="costOf(task)"
            :source="source"
            @toggle-select="togglePick"
            @focus-pane="(id) => emit('focus-pane', id)"
            @review="(id) => emit('review', id)"
          />
          <p v-if="!grouped[column].length" class="task-column-empty">{{ t('tasks.board.empty', 'No tasks') }}</p>
        </div>
      </section>
    </div>
  </div>
</template>
