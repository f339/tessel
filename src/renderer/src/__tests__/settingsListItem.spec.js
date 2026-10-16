// SettingsListItem.vue: one row of a Settings list (settingsList.css), its
// details under it while open.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { h } from 'vue'
import SettingsListItem from '../components/settings/SettingsListItem.vue'

describe('SettingsListItem', () => {
  it('a row button with its name, tags, description and meta; the details only while open', async () => {
    const w = mount(SettingsListItem, {
      props: { name: 'github', desc: 'npx @modelcontextprotocol/server-github', 'data-server': 'github' },
      slots: {
        icon: () => h('span', { class: 'icon' }),
        tags: () => h('span', { class: 'tag tag-ok' }, 'Running'),
        meta: () => h('span', { class: 'tag tag-scope' }, 'All projects'),
        default: () => h('p', { class: 'inside' }, 'Details')
      }
    })
    expect(w.element.tagName).toBe('LI')
    expect(w.attributes('data-server')).toBe('github')
    const row = w.get('button.sl-row')
    expect(row.attributes('aria-expanded')).toBe('false')
    expect(w.get('.sl-row-name').text()).toBe('github')
    expect(w.get('.sl-row-top .tag-ok').text()).toBe('Running')
    expect(w.get('.sl-row-desc').attributes('title')).toBe('npx @modelcontextprotocol/server-github')
    expect(w.get('.sl-row-meta').text()).toBe('All projects')
    expect(w.find('.sl-row-icon .icon').exists()).toBe(true)
    expect(w.find('.sl-details').exists()).toBe(false)

    await row.trigger('click')
    expect(w.emitted('toggle')).toHaveLength(1)
    await w.setProps({ open: true })
    expect(w.classes()).toContain('open')
    expect(row.attributes('aria-expanded')).toBe('true')
    const details = w.get('.sl-details')
    expect(details.attributes('id')).toBe(row.attributes('aria-controls'))
    expect(details.attributes('aria-labelledby')).toBe(row.attributes('id'))
    expect(details.get('.inside').text()).toBe('Details')
  })

  it('leaves out the parts it was not given', () => {
    const w = mount(SettingsListItem, { props: { name: 'pdf' } })
    expect(w.find('.sl-row-icon').exists()).toBe(false)
    expect(w.find('.sl-row-desc').exists()).toBe(false)
    expect(w.find('.sl-row-meta').exists()).toBe(false)
    expect(w.vm.row).toBe(w.get('button.sl-row').element)
  })
})
