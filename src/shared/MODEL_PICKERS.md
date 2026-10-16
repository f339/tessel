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
