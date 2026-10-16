// The tokenizer files Settings > Context downloads (hfTokenizers.js), one
// set per tokenizer of src/shared/tokenCounters.js that does not ship with
// Tessel. Each comes from an ungated Hugging Face repository at a pinned
// revision, with each file's size and hash (sha256 for a file Hugging Face
// keeps in LFS, else git's blob sha1), so a file is used only if it is
// exactly the one checked here. Checked on 2026-10-16: every loader gave the
// same counts as the Python references (tiktoken, tokenizers) on a fixed
// corpus of English, French, Chinese, code, JSON, Markdown and emoji.
// None of these files ships with Tessel; their licences bind the download.
export const TOKENIZER_FILES = Object.freeze({
  kimi: {
    repo: 'moonshotai/Kimi-K2.6',
    rev: '7eb5002f6aadc958aed6a9177b7ed26bb94011bb',
    licence: 'Modified MIT (Kimi K2.6)',
    format: 'tiktoken',
    files: {
      'tiktoken.model': { size: 2795286, sha256: 'b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103' },
      'tokenizer_config.json': { size: 4862, sha1: 'c4d32fcaffbe72d4050388e6464bb719408e361e' },
      'chat_template.jinja': { size: 4022, sha1: '039939fb0cbca410595f7cefc0d62018d142b931' }
    }
  },
  'deepseek-v4': {
    repo: 'deepseek-ai/DeepSeek-V4-Pro',
    rev: 'b5968e9190ef611bbf34a7229255be88a0e937c1',
    licence: 'MIT',
    files: {
      'tokenizer.json': { size: 6367146, sha1: '628e3364caad11bdf9e67cea06eae7878122811d' },
      'tokenizer_config.json': { size: 801, sha1: 'f3dad388a2bbfd6a8605bd02754acd86d9ca5112' }
    }
  },
  qwen3: {
    repo: 'Qwen/Qwen3-Coder-480B-A35B-Instruct',
    rev: '9d90cf8fca1bf7b7acca42d3fc9ae694a2194069',
    licence: 'Apache-2.0',
    files: {
      'tokenizer.json': { size: 7032399, sha1: '90c73275ae7b61cd2b6c4f263018057d516f0c95' },
      'tokenizer_config.json': { size: 13055, sha1: 'cc8cf0649efea42a8c099d852b1525fcfc42c222' },
      'chat_template.jinja': { size: 6211, sha1: '49b0e8d0ee7e655434942233b4b0ab2104d5247e' }
    }
  },
  'qwen3.5': {
    repo: 'Qwen/Qwen3.6-35B-A3B',
    rev: '995ad96eacd98c81ed38be0c5b274b04031597b0',
    licence: 'Apache-2.0',
    files: {
      'tokenizer.json': { size: 12807982, sha256: '5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42' },
      'tokenizer_config.json': { size: 16718, sha1: '28d96ff303d1d20350185caf4bf037045916ed35' },
      'chat_template.jinja': { size: 7764, sha1: 'a8755d827c0a7b614c246c4060dfd58ab352a8ff' }
    }
  },
  glm5: {
    repo: 'zai-org/GLM-5.2',
    rev: 'cf457fa734ab149ffef225f80893eb38c6ff5cdc',
    licence: 'MIT',
    files: {
      'tokenizer.json': { size: 20217442, sha256: '19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d' },
      'tokenizer_config.json': { size: 761, sha1: 'e375fa0a4e16660ce0e2026e39374d35dad4c079' },
      'chat_template.jinja': { size: 5076, sha1: '672034e3a1196d8b9fc0116ddc037cb554227f89' }
    }
  },
  'minimax-m': {
    repo: 'MiniMaxAI/MiniMax-M3',
    rev: 'f0e1c1e04d40177e4673a22097036854f536e9c0',
    licence: 'MiniMax community licence',
    files: {
      'tokenizer.json': { size: 9731500, sha1: '9065e14e5a73c490eb304429d903d3d08b977ab4' },
      'tokenizer_config.json': { size: 11288, sha1: '44840ad83c3832759b922a5695ed968a5e0ee2ec' },
      'chat_template.jinja': { size: 11756, sha1: '93022eb9ceec98f50e7a510841850f7f2e952d9d' }
    }
  },
  mimo: {
    repo: 'XiaomiMiMo/MiMo-V2.6-Flash-RL',
    rev: 'dcd3fd83fb181622fbc606fbb1709901982a62c2',
    licence: 'MIT',
    files: {
      'tokenizer.json': { size: 11423823, sha256: 'ff15eb925890d6b71b5160de4b846fbd13178438ab463b38ecc953e8cd1dcb3e' },
      'tokenizer_config.json': { size: 12150, sha1: '39a944cb3f85e797da58bd4ebd0091c60f7bd6d0' },
      'chat_template.jinja': { size: 3868, sha1: 'f23265d928b22848e4879cc0f1d6cfe999bf7429' }
    }
  },
  tekken: {
    repo: 'mistralai/Devstral-Small-2-24B-Instruct-2512',
    rev: '55c5b41e98c2dbd21b0c8afffc540dcfc9eb5128',
    licence: 'Apache-2.0',
    files: {
      'tokenizer.json': { size: 17077420, sha256: '99cf274236c60277fcfad861a5a1007518687ad06ba8938760f50b55ffa0b1ef' },
      'tokenizer_config.json': { size: 21177, sha1: '2b58a126f960d39faf6d80a62d24f5f8499c39a1' },
      'chat_template.jinja': { size: 11362, sha1: '30350c5745f683c099079f355710bf625ec70424' }
    }
  },
  glimmer: {
    repo: 'meta-models/Muse-Glimmer-30B',
    rev: 'a4e59da52a7bc87ae7251dd5545c0dd437c44b68',
    licence: 'Apache-2.0',
    files: {
      'tokenizer.json': { size: 28129897, sha256: 'c9dbee66967b58f31a7c27f723c3760da3526ccd0427578e8905b0abb0031c4d' },
      'tokenizer_config.json': { size: 79936, sha1: 'fe7f0bb90fb0d0288e3a505974ae0e4baf1d3e61' },
      'chat_template.jinja': { size: 9992, sha1: '7507f3c9f38809152732c045df3977848f3916a6' }
    }
  },
  llama3: {
    repo: 'unsloth/Llama-3.2-1B-Instruct',
    rev: '5a8abab4a5d6f164389b1079fb721cfab8d7126c',
    licence: 'Llama 3.2 Community License',
    files: {
      'tokenizer.json': { size: 17209920, sha256: '6b9e4e7fb171f92fd137b777cc2714bf87d11576700a1dcd7a399e7bbe39537b' },
      'tokenizer_config.json': { size: 54669, sha1: '3dc1faa6025cdb195c0889dd8d3d13ca26af9225' },
      'chat_template.jinja': { size: 3827, sha1: '1bad6a0f648dccdbec523ca79ba90fbcfc806af0' }
    }
  },
  // Gemini's local tokenizers, as Google's own SDK maps them
  // (google-genai _local_tokenizer_loader.py): counted as text, no template.
  gemma3: {
    repo: 'unsloth/gemma-3-27b-it',
    rev: '7a5a3053dbd5d1d58e48159e87b9df2fc545a49a',
    licence: 'Gemma Terms of Use',
    noTemplate: true,
    files: {
      'tokenizer.json': { size: 33384568, sha256: '4667f2089529e8e7657cfb6d1c19910ae71ff5f28aa7ab2ff2763330affad795' },
      'tokenizer_config.json': { size: 1158492, sha1: '9c2583b0aa47578c1bbbb86f1881e8334b42574d' }
    }
  },
  gemma4: {
    repo: 'google/gemma-4-E4B-it',
    rev: 'ee0ef6023621cff504d758262d4e04895a5af4a2',
    licence: 'Apache-2.0',
    noTemplate: true,
    files: {
      'tokenizer.json': { size: 32169626, sha256: 'cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f' },
      'tokenizer_config.json': { size: 3082, sha1: '6068e357379d36f823c377e30efb101fa2c67fe4' }
    }
  }
})
