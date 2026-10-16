# Settings pages

`../SettingsDialog.vue` is the shell: the sidebar (Back, search, the pages by
group), the search and which page shows. Each page is a component here.

| File | What |
| --- | --- |
| `Settings<Page>.vue` | One page each (`SettingsGeneral.vue`, `SettingsAgents.vue`, …). |
| `settingsPages.js` | `PAGES` (title, description, icon), `GROUPS` (the sidebar), `PAGE_TITLES_EN`. |
| `settingsShell.js` | `useSettingsShell()`: what a page gets from the shell. |
| `settingsFields.js` | `setNumber` / `setRange` for number fields. |
| `settingsList.css` | The list rows (`.sl-*`), imported first by `style.css`. |
| `SettingsListItem.vue` | One list row with slots (optional). |

The other shared classes (`.set-*`, `.tag`, `.chip`, `.exit-btn.*`) are in
`../../style.css`, in its Settings and button sections.

## A page

```vue
<script setup>
import { t } from '../../i18n'
import { settings } from '../../settings'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const { shown, emit } = useSettingsShell()
</script>

<template>
  <section id="set-example" class="set-page" data-page="example" :hidden="!shown('example')" aria-labelledby="set-example-title">
    <header class="set-page-head">
      <h2 id="set-example-title">{{ PAGES.example.title }}</h2>
      <p class="set-page-desc">{{ PAGES.example.desc }}</p>
    </header>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.example.group', 'Group title') }}</h3>
      <p class="set-group-desc">{{ t('settings.example.groupDesc', 'One sentence about the whole group.') }}</p>
      <div class="set-card">
        <label class="set-row">
          <span class="set-label">{{ t('settings.example.thing', 'Do the thing') }}
            <span class="set-hint">{{ t('settings.example.thingHint', 'One line, about 90 characters at most.') }}</span>
          </span>
          <input v-model="settings.example" type="checkbox" class="set-switch" />
        </label>
      </div>
    </div>
  </section>
</template>
```

`useSettingsShell()` gives `page` (a ref), `searching`, `shown(id)`, `go(id)`,
`openMcpTab(tab)`, `mcpTab` and `emit`: the shell's emit, since App.vue
listens on SettingsDialog only (`emit('open-tool', 'tools')`). Data the page
needs from App.vue comes as props, passed by the shell.

A new page: add it to `PAGES`, `GROUPS` and `PAGE_TITLES_EN`, import it in
the shell and put its tag in the shell's `<main>`, in sidebar order.

### What the search needs

The search (in the shell) reads the rendered text of every page, so:

- Every page renders all the time, hidden when not shown (`:hidden="!shown(id)"`).
  Something heavy renders only while its page is open
  (`v-if="page === 'x' && !searching"`), with a `v-else` row that says what
  it is and opens it (`go('x')`), so the search still finds it.
- The markup: `section.set-page[data-page]` > `header.set-page-head h2`, then
  `.set-group` as direct children; in a group, `.set-group-title` and the
  rows. A row is `.set-row` (or `.agent-set`, `.orch-example`, `.orch-tools li`,
  `.account-provider`: `ITEM` in the shell). A match shows its row; a group
  title that matches shows the whole group; a page title (or its English
  title) shows the whole page.
- `useSettingsShell()` runs the search again when the page re-renders.
- The shell counts the rows it shows and highlights the words found in them
  (a CSS Custom Highlight, `::highlight(settings-search)`): nothing is added
  to a page's DOM, so no page needs to do anything for it.

## Shared classes

**Page and groups.** `.set-page-head` (h2 22/600) + `.set-page-desc`;
`.set-group` (22 px apart), `.set-group-title` 13/600, `.set-group-desc`
under the title, outside the card; `.set-card` (radius 10, `--surface-2`,
padding `2px 18px`; `.set-card-pad` for a card holding something else). A
card below 520 px wide lets a row's control go under its label.

**Rows.** `.set-row` > `.set-label` (13 px) with `.set-hint` (11.5 px, one
line), the control on the right. A longer hint: its first sentence, the rest
in a disclosure:

```html
<span class="set-hint">{{ t('…', 'First sentence.') }}</span>
<details class="set-more">
  <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
  <p>{{ t('…', 'The rest.') }}</p>
</details>
```

**Controls.** A boolean is `input.set-switch` (never Off/On segments or a
native checkbox); 2 or 3 short choices `.launch-seg.set-seg`; more or longer
ones `ThemedSelect`; numbers `.set-number` (unit and range in the hint, then
`setNumber(key, $event)`); a path or command `.sl-path` with a title and a
copy button; a command to try, in a hint, `code.set-code` (one line each).
Page tabs are `.launch-seg` with `role="tablist"` and `aria-selected`.

**Buttons.** `.exit-btn` (secondary, 28 px), `.exit-btn.small` (24 px, for
lists and details), `.exit-btn.primary` (one per view at most),
`.exit-btn.danger` (removes or signs out: always behind `askConfirm`). Icon
buttons: `.tb-icon`. A text link (`.sl-link`) only navigates. Every button,
seg and row shows a 2 px accent ring on keyboard focus (`:focus-visible`).

**Tags and chips.** `span.tag` for a state, scope, version or origin, with
`.tag-scope` (outlined), `.tag-ok`, `.tag-info`, `.tag-purple`, `.tag-warn`,
`.tag-danger`, `.tag-update` (Update available), `.tag-off`. `button.chip`
(`.on` while pressed, `.chip-count` inside) for filters and multi-selects.

**Callouts.** `.set-callout.info | .warn | .danger`, an optional icon first,
then `.set-callout-text`: one human sentence; a raw error goes behind a
Details disclosure.

**Lists** (`settingsList.css`, the Settings > Skills look): rows that open
their details under them.

```vue
<ul class="sl-list">
  <SettingsListItem v-for="s in servers" :key="s.id" :open="openId === s.id" :name="s.name" :desc="s.target" @toggle="toggle(s.id)">
    <template #icon><BrandIcon :kind="s.agent" :size="20" /></template>
    <template #tags><span class="tag tag-info">{{ s.transport }}</span></template>
    <template #meta><span class="sl-icons"><BrandIcon v-for="a in s.agents" :key="a" :kind="a" :size="14" /></span></template>
    <div class="sl-section-head">
      <span>{{ t('…', 'Used by') }}</span>
      <button type="button" class="exit-btn small">{{ t('…', 'Test') }}</button>
    </div>
    <ul class="sl-subs">
      <li class="sl-sub">
        <div class="sl-sub-line">…title and tags…</div>
        <div class="sl-sub-foot">
          <span class="sl-sub-path"><span class="sl-path" :title="path">{{ path }}</span>…copy…</span>
          <span class="sl-actions">…buttons…</span>
        </div>
      </li>
    </ul>
  </SettingsListItem>
</ul>
```

Or write the markup yourself with the same classes (SkillsDialog.vue does,
for its keyboard moves): `li.sl-item(.open) > button.sl-row` with
`.sl-row-icon`, `.sl-row-main > .sl-row-top > .sl-row-name + .tag…`,
`.sl-row-desc`, `.sl-row-meta`, `.sl-chevron`, then `.sl-details`
(`.sl-details-desc`, `.sl-section-head`, `.sl-subs > .sl-sub`). While the list
loads: `li.sl-item.sl-skeleton` with `.sl-skel-icon` and `.sl-skel-lines`.

**States.** Loading: `PanelState` or skeleton rows, never an empty list or
"nothing found". Error: `PanelState kind="error"` with Retry, a human
sentence first, the raw message behind Details. Empty: one sentence and one
action, never red.

**Text.** Sentence case ("Add target", not "Add Target"); `--text-dim` is
#8a92a0; times with `intlLocale()`; plurals with `_one`/`_other`. Check FR at
900 px: French runs about a third longer.
