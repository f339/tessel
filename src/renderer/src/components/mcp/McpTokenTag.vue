<script setup>
// The context cost of a server's tool definitions ("≈ 1.2k tokens"), in
// Settings > MCP servers. A placeholder that draws nothing for now: the
// context cost feature (window.shellApi.mcpMeasure, src/main/contextCost)
// fills it in, without touching McpInstalled.vue.
//
// Where it is drawn:
//   variant="row"     in each server's row, beside its agent icons. The row
//                     is a <button>: a tag only here, nothing clickable.
//   variant="details" in each agent's line of the server's details: the tag,
//                     or a "Measure" action (it starts the server, so only
//                     on click).
defineProps({
  server: { type: String, required: true }, // the server's name
  agent: { type: String, default: null }, // the agent whose settings start it
  scope: { type: String, default: null }, // its scope there (user, local, project)
  cwd: { type: String, default: null }, // the project folder (project scope)
  variant: { type: String, default: 'row' } // 'row' | 'details'
})
</script>

<template>
  <!-- Nothing yet (see above): an empty slot renders nothing. -->
  <slot />
</template>
