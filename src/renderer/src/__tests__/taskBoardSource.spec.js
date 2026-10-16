// The task board (TaskBoard.vue, TaskCard.vue) given a source (a Live Share
// host's board, taskBoardSource.js): its cards, and only what the source lets
// you do: read-only without mutators, each control back when its mutator is,
// live. Without a source, this computer's board as before.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive, nextTick } from 'vue'
import TaskBoard from '../components/TaskBoard.vue'
import { setTasks, addTask, tasks } from '../taskBoardStore'
import { cardsOf, canOf } from '../taskBoardSource'

const DRAG = 'application/x-tessel-task'
function hostCards() {
  return [
    { id: 'h1', title: 'Host todo', column: 'todo', columnSince: 1 },
    { id: 'h2', title: 'Host doing', column: 'doing', columnSince: 2, paneId: 'hp1' },
    { id: 'h3', title: 'Host done', column: 'done', columnSince: 3 },
    { id: 'h4', title: 'Needs you', column: 'review', columnSince: 4, gate: { status: 'pending', question: 'Ship it?', options: ['Yes', 'No'] } }
  ]
}
function dropEvent(id) {
  const data = { [DRAG]: id }
  return { dataTransfer: { types: [DRAG], getData: (t) => data[t] || '', dropEffect: '' } }
}
const has = (w, sel) => w.find(`[data-test="${sel}"]`).exists()
const card = (w, id) => w.get(`[data-task-id="${id}"]`)

beforeEach(() => setTasks([]))

describe('taskBoardSource', () => {
  it('reads the cards from an array or a function, and allows only the mutators given', () => {
    expect(cardsOf({ tasks: [{ id: 'a' }] })).toEqual([{ id: 'a' }])
    expect(cardsOf({ tasks: () => [{ id: 'b' }] })).toEqual([{ id: 'b' }])
    expect(cardsOf({ tasks: 'nope' })).toEqual([])
    expect(canOf(null)).toMatchObject({ add: true, move: true, edit: true, remove: true, answer: true, any: true })
    expect(canOf({ tasks: [] })).toMatchObject({ add: false, move: false, edit: false, remove: false, answer: false, any: false })
    expect(canOf({ tasks: [], move: () => {} })).toMatchObject({ move: true, add: false, any: true })
  })
})

describe('a board from a source without mutators: read only', () => {
  it("shows the source's cards, never this computer's, and nothing to change them", async () => {
    addTask({ title: 'My own local card' })
    const w = mount(TaskBoard, { props: { source: { tasks: hostCards() }, workspaceId: 'ws-local' } })
    await flushPromises()
    expect(w.text()).toContain('Host todo')
    expect(w.text()).toContain('Host doing')
    expect(w.text()).not.toContain('My own local card')
    expect(has(w, 'board-read-only')).toBe(true)
    expect(has(w, 'add-task-form')).toBe(false)
    expect(w.find('.task-board-new').exists()).toBe(false)
    expect(has(w, 'select-done')).toBe(false)
    expect(has(w, 'delete-task')).toBe(false)
    expect(has(w, 'edit-title')).toBe(false)
    expect(has(w, 'assign-select')).toBe(false)
    expect(has(w, 'review-task')).toBe(false)
    expect(card(w, 'h1').attributes('draggable')).toBe('false')
    // The question is shown, not answerable.
    expect(card(w, 'h4').text()).toContain('Ship it?')
    expect(card(w, 'h4').find('.task-gate-options').exists()).toBe(false)
    expect(card(w, 'h4').find('.task-gate-own').exists()).toBe(false)
    // A drop does nothing, a keyboard move neither.
    await w.get('[data-column="doing"]').trigger('drop', dropEvent('h1'))
    await card(w, 'h1').trigger('keydown', { key: 'ArrowRight', altKey: true })
    expect(card(w, 'h1').attributes('data-column')).toBe('todo')
    w.unmount()
  })

  it('a board the host no longer shares says so', async () => {
    const w = mount(TaskBoard, { props: { source: { tasks: hostCards(), state: 'no-access' } } })
    expect(w.get('[data-test="board-access"]').text()).toContain('You no longer have access to this project.')
    expect(w.find('[data-test="column"]').exists()).toBe(false)
    w.unmount()
  })

  it('still on its way: loading, not "No tasks"; failed: why', async () => {
    const source = reactive({ tasks: [], loaded: false, error: '' })
    const w = mount(TaskBoard, { props: { source } })
    expect(has(w, 'board-loading')).toBe(true)
    source.loaded = true
    source.error = 'timeout'
    await nextTick()
    expect(w.get('[data-test="board-error"]').text()).toContain('timeout')
    w.unmount()
  })
})

describe('a board from a source with mutators', () => {
  function makeSource() {
    return reactive({
      tasks: hostCards(),
      add: vi.fn(),
      move: vi.fn(),
      edit: vi.fn(),
      remove: vi.fn(),
      answer: vi.fn()
    })
  }

  it('each change goes to the source, never to the store', async () => {
    const source = makeSource()
    const w = mount(TaskBoard, { props: { source }, attachTo: document.body })
    expect(has(w, 'board-read-only')).toBe(false)
    // Add
    await w.get('[data-test="new-task-input"]').setValue('From the guest')
    await w.get('[data-test="add-task-form"]').trigger('submit')
    expect(source.add).toHaveBeenCalledWith({ title: 'From the guest' })
    expect(tasks).toHaveLength(0)
    // Move: a drop, and the keyboard
    await w.get('[data-column="doing"]').trigger('drop', dropEvent('h1'))
    expect(source.move).toHaveBeenCalledWith('h1', 'doing')
    await card(w, 'h1').trigger('keydown', { key: 'ArrowRight', altKey: true })
    expect(source.move).toHaveBeenLastCalledWith('h1', 'doing')
    // Rename (To do only)
    await card(w, 'h1').get('[data-test="edit-title"]').trigger('click')
    await card(w, 'h1').get('[data-test="title-input"]').setValue('Renamed')
    await card(w, 'h1').get('[data-test="title-input"]').trigger('keydown', { key: 'Enter' })
    expect(source.edit).toHaveBeenCalledWith('h1', { title: 'Renamed' })
    // Delete
    await card(w, 'h2').get('[data-test="delete-task"]').trigger('click')
    expect(source.remove).toHaveBeenCalledWith('h2')
    // Answer the question
    await card(w, 'h4').findAll('.task-gate-options .task-btn')[0].trigger('click')
    expect(source.answer).toHaveBeenCalledWith('h4', 'Yes')
    // Done > Select > delete
    await w.get('[data-test="select-done"]').trigger('click')
    await w.get('[data-test="pick-all"]').trigger('click')
    await w.get('[data-test="delete-picked"]').trigger('click')
    expect(source.remove).toHaveBeenLastCalledWith('h3')
    // The host's agent is shown, never chosen here.
    expect(has(w, 'assign-select')).toBe(false)
    w.unmount()
  })

  it('a mutator taken away hides its control at once (rights flip live)', async () => {
    const source = makeSource()
    const w = mount(TaskBoard, { props: { source } })
    expect(has(w, 'add-task-form')).toBe(true)
    expect(has(w, 'delete-task')).toBe(true)
    source.add = null
    source.remove = null
    await nextTick()
    expect(has(w, 'add-task-form')).toBe(false)
    expect(has(w, 'delete-task')).toBe(false)
    expect(has(w, 'select-done')).toBe(false)
    expect(has(w, 'board-read-only')).toBe(false) // it can still move, rename, answer
    source.move = null
    source.edit = null
    source.answer = null
    await nextTick()
    expect(has(w, 'board-read-only')).toBe(true)
    expect(card(w, 'h1').attributes('draggable')).toBe('false')
    source.answer = vi.fn()
    await nextTick()
    expect(card(w, 'h4').find('.task-gate-options').exists()).toBe(true)
    w.unmount()
  })
})

describe('without a source', () => {
  it("is this computer's board, every control as before", async () => {
    addTask({ title: 'Local card' })
    const w = mount(TaskBoard)
    expect(w.text()).toContain('Local card')
    expect(w.find('.task-board-new').exists()).toBe(true)
    expect(has(w, 'add-task-form')).toBe(true)
    expect(has(w, 'board-read-only')).toBe(false)
    expect(has(w, 'delete-task')).toBe(true)
    expect(has(w, 'edit-title')).toBe(true)
    expect(has(w, 'assign-select')).toBe(true)
    await w.get('[data-test="new-task-input"]').setValue('Another')
    await w.get('[data-test="add-task-form"]').trigger('submit')
    expect(tasks.map((t) => t.title)).toEqual(['Local card', 'Another'])
    w.unmount()
  })
})
