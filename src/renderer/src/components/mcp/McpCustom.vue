<script setup>
// Settings > MCP servers > Custom: any other server, by command or URL, with
// its variables or headers (masked), tested before adding if you like, and
// the same add bar as the catalog. What is wrong shows once you typed it (or
// tried Add), never on an empty form.
import { ref, reactive, computed } from 'vue'
import McpAddBar from './McpAddBar.vue'
import McpKeyValueRows from './McpKeyValueRows.vue'
import { t } from '../../i18n'
import { AGENT_NAME, NO_SSE, SERVER_NAME_RE, agentList, testState, testLabel, testTitle } from './mcpShared'

const props = defineProps({
  m: { type: Object, required: true }, // useMcpState()
  cwd: { type: String, default: null }
})
const emit = defineEmits(['added'])

const form = reactive({ name: '', transport: 'stdio', commandLine: '', url: '', bearerEnvVar: '' })
const env = ref([])
const headers = ref([])
const touched = reactive({ name: false, url: false, command: false })
const submitted = ref(false)
const targets = reactive({}) // agent -> chosen (on until turned off)
const scope = ref('user')
const formError = ref('')
const tried = ref(null) // the answer of the last test before adding
const envRows = ref(null)
const headerRows = ref(null)

const isHttp = computed(() => form.transport !== 'stdio')
const agents = computed(() => props.m.addable)
const noSseLabel = (agent) => t('mcp.custom.noSse', '{{agent}} only connects to streamable HTTP servers', { agent: AGENT_NAME[agent] })
const blocked = computed(() => ({
  ...props.m.unwritable,
  ...(form.transport === 'sse' ? Object.fromEntries(agents.value.filter((a) => NO_SSE.includes(a)).map((a) => [a, noSseLabel(a)])) : {})
}))
const isOn = (a) => targets[a] !== false
const chipTargets = computed(() => Object.fromEntries(agents.value.map((a) => [a, isOn(a)])))
const chosen = computed(() => agents.value.filter((a) => isOn(a) && !blocked.value[a]))
const existsLabel = (names) => t('mcp.custom.exists', 'Already in {{agents}}: adding it there again replaces it or fails.', { agents: names })

const nameError = computed(() => {
  const name = form.name.trim()
  if (!name) return submitted.value ? t('mcp.custom.nameMissing', 'Enter a name.') : ''
  if (touched.name && !SERVER_NAME_RE.test(name)) return t('mcp.custom.nameInvalid', 'Letters, digits, - and _ only (no spaces).')
  return ''
})
const nameTaken = computed(() => {
  const name = form.name.trim()
  if (!name || nameError.value) return ''
  const has = props.m.addedTo(name)
  return has.length ? existsLabel(agentList(has.map((a) => AGENT_NAME[a]))) : ''
})
const urlError = computed(() => {
  if (!isHttp.value) return ''
  const url = form.url.trim()
  if (!url) return submitted.value ? t('mcp.custom.urlMissing', 'Enter the server URL.') : ''
  if ((touched.url || submitted.value) && !/^https?:\/\//i.test(url)) return t('mcp.custom.urlInvalid', 'Start with http:// or https://')
  return ''
})
const commandError = computed(() =>
  !isHttp.value && submitted.value && !form.commandLine.trim() ? t('mcp.custom.commandMissing', 'Enter the command that starts the server.') : ''
)
// Every field the server needs, filled and valid.
function valid() {
  const name = form.name.trim()
  if (!SERVER_NAME_RE.test(name)) return false
  if (isHttp.value ? !/^https?:\/\//i.test(form.url.trim()) : !form.commandLine.trim()) return false
  const rows = isHttp.value ? headerRows.value : envRows.value
  return !(rows && rows.hasErrors())
}

const lines = (rows, sep) =>
  rows
    .filter((r) => r.key.trim())
    .map((r) => `${r.key.trim()}${sep}${r.value}`)
    .join('\n')
// What the main process gets: the same for the test and for each agent.
function spec() {
  return {
    name: form.name.trim(),
    transport: isHttp.value ? 'http' : 'stdio',
    sse: form.transport === 'sse',
    commandLine: form.commandLine,
    url: form.url.trim(),
    env: isHttp.value ? '' : lines(env.value, '='),
    headers: isHttp.value ? lines(headers.value, ': ') : '',
    bearerEnvVar: isHttp.value ? form.bearerEnvVar.trim() : '',
    cwd: props.cwd
  }
}

function setTransport(kind) {
  form.transport = kind
  tried.value = null
}
function toggleTarget(a) {
  targets[a] = !isOn(a)
}

const canTestFirst = computed(() => !!window.shellApi.mcpTestSpec)
async function testFirst() {
  touched.url = true
  if (isHttp.value ? !/^https?:\/\//i.test(form.url.trim()) : !form.commandLine.trim()) {
    submitted.value = true
    return
  }
  tried.value = { status: 'testing' }
  try {
    tried.value = await window.shellApi.mcpTestSpec(spec())
  } catch (err) {
    tried.value = { status: 'error', error: err && err.message }
  }
}
const triedClass = computed(() => ({ ok: 'tag-ok', auth: 'tag-warn', error: 'tag-danger' })[testState(tried.value)] || '')

async function add() {
  submitted.value = true
  touched.name = true
  touched.url = true
  formError.value = ''
  if (!chosen.value.length) {
    formError.value = t('mcp.chooseAgent', 'Choose at least one agent.')
    return
  }
  if (!valid()) return
  const m = props.m
  const base = spec()
  m.busy = 'custom'
  let out
  try {
    out = await m.addToAgents(chosen.value, (agent) => ({ ...base, agent, scope: agent === 'claude' ? scope.value : 'user' }))
  } finally {
    m.busy = ''
  }
  formError.value = m.failuresText(out)
  const done = m.addedNames(out)
  if (!done.length) return
  m.say(t('mcp.custom.added', 'Added "{{name}}" to {{agents}}. Restart running agent panes to load it.', { name: base.name, agents: agentList(done) }))
  if (!formError.value) {
    Object.assign(form, { name: '', commandLine: '', url: '', bearerEnvVar: '' })
    env.value = []
    headers.value = []
    Object.assign(touched, { name: false, url: false, command: false })
    submitted.value = false
    tried.value = null
    // Installed shows each agent's test (Needs sign-in, Sign in).
    emit('added')
  }
  await m.checkAdded(base.name, out)
}
</script>

<template>
  <form class="mcpf" novalidate @submit.prevent="add">
    <div class="mcpf-field">
      <label for="mcpf-name">{{ t('mcp.custom.name', 'Name') }}</label>
      <input
        id="mcpf-name"
        v-model="form.name"
        class="set-number mcpf-input"
        :class="{ invalid: nameError }"
        :placeholder="'my-server'"
        spellcheck="false"
        autocomplete="off"
        :aria-invalid="nameError ? 'true' : 'false'"
        aria-describedby="mcpf-name-hint"
        @input="touched.name = true"
      />
      <span v-if="nameError" id="mcpf-name-hint" class="mcpf-invalid" role="alert">{{ nameError }}</span>
      <span v-else-if="nameTaken" id="mcpf-name-hint" class="mcpf-warn">{{ nameTaken }}</span>
      <span v-else id="mcpf-name-hint" class="set-hint">{{ t('mcp.custom.nameHint', 'Letters, digits, - and _') }}</span>
    </div>

    <div class="mcpf-field">
      <span id="mcpf-type" class="mcpf-label">{{ t('mcp.custom.type', 'Type') }}</span>
      <div class="launch-seg set-seg mcpf-seg" role="radiogroup" aria-labelledby="mcpf-type">
        <button
          v-for="k in ['stdio', 'http', 'sse']"
          :key="k"
          type="button"
          role="radio"
          class="launch-seg-btn"
          :class="{ on: form.transport === k }"
          :aria-checked="form.transport === k ? 'true' : 'false'"
          @click="setTransport(k)"
        >
          {{ k === 'stdio' ? t('mcp.custom.command', 'Command') : k === 'http' ? t('mcp.custom.http', 'HTTP') : t('mcp.custom.sse', 'SSE') }}
        </button>
      </div>
      <span class="set-hint">{{
        form.transport === 'stdio'
          ? t('mcp.custom.stdioHint', 'A program on this computer (stdio).')
          : form.transport === 'http'
            ? t('mcp.custom.httpHint', 'A server on the web (streamable HTTP).')
            : t('mcp.custom.sseHint', 'An older web server (HTTP with server-sent events).')
      }}</span>
    </div>

    <div v-if="!isHttp" class="mcpf-field">
      <label for="mcpf-command">{{ t('mcp.custom.commandArgs', 'Command and arguments') }}</label>
      <input
        id="mcpf-command"
        v-model="form.commandLine"
        class="set-number mcpf-input mcpf-mono"
        :class="{ invalid: commandError }"
        :placeholder="'npx -y some-mcp-server'"
        spellcheck="false"
        autocomplete="off"
        :aria-invalid="commandError ? 'true' : 'false'"
        @input="tried = null"
      />
      <span v-if="commandError" class="mcpf-invalid" role="alert">{{ commandError }}</span>
      <span v-else class="set-hint">{{ t('mcp.custom.commandHint', 'npx commands are wrapped for Windows automatically') }}</span>
    </div>
    <div v-else class="mcpf-field">
      <label for="mcpf-url">URL</label>
      <input
        id="mcpf-url"
        v-model="form.url"
        class="set-number mcpf-input mcpf-mono"
        :class="{ invalid: urlError }"
        :placeholder="'https://example.com/mcp'"
        spellcheck="false"
        autocomplete="off"
        :aria-invalid="urlError ? 'true' : 'false'"
        @input="tried = null"
        @blur="touched.url = !!form.url.trim()"
      />
      <span v-if="urlError" class="mcpf-invalid" role="alert">{{ urlError }}</span>
    </div>

    <div class="mcpf-field">
      <span class="mcpf-label">{{ isHttp ? t('mcp.custom.headers', 'Headers') : t('mcp.custom.env', 'Environment') }}</span>
      <span class="set-hint">{{
        isHttp ? t('mcp.custom.headersHint2', 'Optional: sent with each request, an API key for example.') : t('mcp.custom.envHint2', 'Optional: variables the server reads, an API key for example.')
      }}</span>
      <McpKeyValueRows v-if="isHttp" ref="headerRows" :rows="headers" kind="header" :submitted="submitted" />
      <McpKeyValueRows v-else ref="envRows" :rows="env" kind="env" :submitted="submitted" />
    </div>

    <div v-if="isHttp && chipTargets.codex && !blocked.codex" class="mcpf-field">
      <label for="mcpf-bearer">{{ t('mcp.custom.tokenVar', 'Codex token variable') }}</label>
      <input id="mcpf-bearer" v-model="form.bearerEnvVar" class="set-number mcpf-input mcpf-mono mcpf-short" :placeholder="'MY_TOKEN'" spellcheck="false" autocomplete="off" />
      <span class="set-hint">{{ t('mcp.custom.tokenVarHint', 'Optional: environment variable holding a bearer token') }}</span>
    </div>

    <div v-if="tried" class="mcpf-tried" aria-live="polite">
      <span class="tag mcpf-tried-tag" :class="triedClass" :title="testTitle(tried)">{{ testLabel(tried) }}</span>
      <span v-if="testState(tried) === 'ok'" class="set-hint">{{ t('mcp.custom.triedOk', 'It answers: ready to add.') }}</span>
      <details v-if="testState(tried) === 'error' || testState(tried) === 'auth'" class="set-more mcpf-raw">
        <summary>{{ t('mcp.details', 'Details') }}</summary>
        <p>{{ testTitle(tried) }}</p>
      </details>
    </div>

    <McpAddBar
      v-model:scope="scope"
      :agents="agents"
      :targets="chipTargets"
      :blocked="blocked"
      :cwd="cwd"
      :label="t('mcp.custom.add', 'Add server')"
      :busy="m.busy === 'custom'"
      :disabled="!!m.busy"
      :error="formError"
      @toggle="toggleTarget"
      @add="add"
    >
      <template #secondary>
        <button v-if="canTestFirst" type="button" class="exit-btn mcpf-test" :disabled="tried && tried.status === 'testing'" @click="testFirst">
          {{ tried && tried.status === 'testing' ? t('mcp.test.testing', 'Testing…') : t('mcp.custom.testFirst', 'Test before adding') }}
        </button>
      </template>
    </McpAddBar>
  </form>
</template>

<style scoped>
.mcpf {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 12px;
}
.mcpf-field {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  max-width: 560px;
}
.mcpf-field > label,
.mcpf-label {
  color: var(--text-strong);
  font-size: 12.5px;
}
.mcpf-input {
  width: 100%;
  height: 28px;
  text-align: left;
}
.mcpf-short {
  width: 220px;
  max-width: 100%;
}
.mcpf-mono {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11.5px;
}
.mcpf-input.invalid {
  border-color: var(--danger);
}
.mcpf-invalid {
  color: #ffb4b6;
  font-size: 11.5px;
}
.mcpf-warn {
  color: #ffd98f;
  font-size: 11.5px;
}
.mcpf-tried {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}
.mcpf-raw {
  flex-basis: 100%;
}
.mcpf-raw p {
  margin: 4px 0 0;
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
</style>
