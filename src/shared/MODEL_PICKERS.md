# Additional agent model catalogs

Checked on 2026-09-29. No prompts or paid turns were sent.

- Pi: `pi --list-models`, six-column provider/model table; thinking only on
  rows marked `yes`. Qualified model IDs use `--model`; effort uses `--thinking`.
  The conservative levels follow the reference parser (off, low, medium, high,
  xhigh). [CLI documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).
- Cursor: `cursor-agent --list-models`, `id - label` rows. Existing seed option
  mappings remain; new IDs get no guessed effort suffixes.
- Antigravity: `agy models`, current `id<TAB>label` rows only. The old human-name
  format is deliberately ignored to preserve strict shell-safe model values.
  Checked with agy 1.3.5 on 2026-10-15 (print-mode `/model` and `/effort`,
  no turn): each effort is its own row (`gemini-4-argon-high`), so the pickers
  group the variants into one model with the efforts it lists
  (`antigravityModels.js`); `--model <base> --effort <level>` picks the
  variant, while a variant id with another `--effort`, or an effort the model
  lacks, is refused at launch. A model listed once has no effort option.
- Muse Code: `muse serve` answers `model/list` (its session protocol, a query:
  no session, no turn) with each model id, its label, its ordered efforts
  (`variants`) and its default effort; launched as `--model <id>
  --reasoning-effort <level>`, switched in a session with `/model <id>` and
  `/effort <level>`. From its protocol reference and SDK types (1.4.9); Muse
  was not installed here, so the probe is covered by a fake `muse serve`.
- Amp: reference fixed modes smart/rush/large/deep, `--mode`; `--effort` only on
  large/deep. Availability and these flags could not be checked locally.
- Kimi: installed `kimi --help` confirms `-m`/`--model`, but does not advertise
  thinking/effort flags, so those controls are omitted. The reference managed
  model `kimi-code/kimi-for-coding` (Kimi K2.6) remains a seed; its availability
  depends on the user's config/account and was not tested with a prompt.
- Copilot: installed 1.0.89 help confirms `--model` and `--reasoning-effort`.
  The fixed reference model list and GPT-5 effort range are conservative seeds,
  not an account entitlement check. Both effort aliases override the picker,
  as documented in the [CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference).

Pi, Cursor and Amp were absent from PATH (Antigravity was checked later, above). Their probe formats and
flags are covered by synthetic fixtures derived from the reference sources,
not represented as recordings of locally installed CLIs. No unverified
mid-session command is added for Amp or Kimi. Untouched pickers add no flags.

Reference implementation: Orca shared model parsers and agent specifications,
MIT, Copyright (c) 2026 Lovecast Inc.; attribution also appears in the code.

# The model and effort an agent runs with now

Checked on 2026-10-16. What the pane header shows, and with it the team
roster, the sender identity of team messages and activity, the hover card,
Conversations and Past conversations. Best first: the agent's screen (where it
draws its model), its running session, its `--model` (with `--effort`,
`--reasoning-effort` or `--thinking`), what it picked last, its settings.
Readers: `src/main/agentModel.js`, `src/main/agentModelSources.js`, the
screen parsers in `src/shared` (codexScreen, cursorModels, antigravityModels,
screenModel). Each watched file calls the agent's panes back within about a
second (a database every 5 s), else every 20 s and when a turn ends.

| Agent | Session (follows /model) | Settings / last pick | Effort | Verified here |
| --- | --- | --- | --- | --- |
| Claude Code | transcript: each answer, `/model`, `/effort` | settings.json (folder, user) | perTurnEffort, effortLevel, `--effort` | yes |
| Codex | screen footer; rollout turn_context | config.toml | footer, turn, `model_reasoning_effort` | yes |
| Cursor | screen status line | cli-config.json | the name's effort word | yes |
| Antigravity | screen footer; transcript Model Selection notes | settings.json label | the label's `(High)` | yes |
| Muse Code | session log | settings.json | log, `--reasoning-effort` | installed (earlier reader) |
| Copilot | events.jsonl (pane's id, else the open one): answers, `session.model_change` | settings.json / config.json `model` | the latest model_change's reasoningEffort | yes |
| OpenCode | opencode.db: newest message, session model column | state model.json (recent + variant) | the variant | yes |
| Kilo | kilo.db: the folder's session since the pane started | state model.json, kilo.json(c) | the variant | yes (files, no CLI) |
| ZCode | db.sqlite (OpenCode's tables) | | the variant | from docs |
| Cline | sessions.db (running pid) | providers.json | `reasoning.effort` (off: none) | yes |
| Gemini CLI | chats/session-*-<id8>.jsonl: each answer's model | settings.json `model.name` | none shown | format from installed 0.64 source; no chat file here |
| Qwen Code | projects/<p>/chats/<id>.jsonl: each answer's model | settings.json `model.name` | none shown | from docs |
| Kimi Code | sessions/<ws>/<id>/agents/main/wire.jsonl: profile.bind, config.update | config.toml default_model, [thinking], display_name | thinkingEffort (off: none) | format from installed Kimi Code's code; no session here |
| Pi, OMP | session JSONL: model_change, thinking_level_change, answers | Pi settings.json | thinking level | format checked on OpenClaw's files |
| OpenClaw | sessions.json newest + its JSONL | openclaw.json agents.defaults.model | thinking level | yes |
| Droid | sessions/<folder>/<id>.settings.json | settings.json | reasoningEffort | from docs |
| OpenClaude, Qoder | Claude Code transcript in their folder | OpenClaude settings.json | as Claude Code writes it | from docs |
| Continue (cn) | | index/globalContext.json cliSelectedModel, config.yaml | none | yes |
| Crush | | data crush.json models.large, then project/global | reasoning_effort | from docs |
| Goose | | config.yaml GOOSE_MODEL | none | from docs |
| Aider | | .aider.conf.yml model | reasoning-effort | from docs |
| Mistral Vibe | | config.toml active_model | none | from docs |
| Amp | `--mode` (smart, rush, large, deep) | | `--effort` | from docs |
| Ollama | `ollama run <model>`, else its only running model | | none | yes |

Agents with none of these (Grok, Auggie, Kiro, Codebuff, Freebuff, Rovo,
Hermes, Devin, Trae, Autohand, Command Code, OpenCode 2, MiMo, Prime Agent,
Ante, DeepSeek Harness): their `--model`, else the model name their status
bar or banner prints (screenModel.js). On an SSH host only Claude Code's and
Codex's files are read; the others show their `--model` and effort flag or
their screen.
