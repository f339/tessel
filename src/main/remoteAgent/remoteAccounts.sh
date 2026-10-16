# Accounts of the agents on an SSH host or a WSL distro (remoteAccounts.js).
# POSIX sh; appended to remoteShell.js's prelude, and run alone in WSL.
#
# Read-only identity: each field is taken from the agent's own file by its
# key name (a pattern per key kept), so a token, a key or any other field
# never leaves the host. A key or token is only ever tested for presence
# (grep -q prints nothing). The one token handled here, Codex's id_token, is
# cut to its claims (the part between the dots, no signature) before it is
# decoded, and only its email and plan are printed.
#
# Output, one record per place an agent keeps a sign-in:
#   @h <os> <home>
#   @a <agent> <scope> <id|-> <mtime seconds|-> <folder>
#   v <key> <value>
# scope: default (the agent's own folder), env (CLAUDE_CONFIG_DIR / CODEX_HOME
# set by the login shell), tessel (a folder Tessel made for one account,
# ~/.tessel-server/accounts/<agent>/<id>, see __t_acctmk).
__ta_flat() { head -c 8388608 "$1" 2>/dev/null | tr -d '\n\r'; }
__ta_str() { grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" 2>/dev/null | head -n 1 | sed 's/^"[^"]*"[[:space:]]*:[[:space:]]*"//; s/"$//'; }
__ta_obj() { grep -o "\"$1\"[[:space:]]*:[[:space:]]*{[^{}]*}" 2>/dev/null | head -n 1; }
__ta_set() { grep -q "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]" 2>/dev/null && echo 1; }
__ta_v() { [ -n "$2" ] && printf 'v %s %s\n' "$1" "$2"; return 0; }
__ta_mt() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
# A command given at most $1 seconds (its output once it ended). The shell's
# own watchdog: stock macOS and BusyBox have no timeout command. Self-made
# (this file also runs alone, in WSL, without the prelude's helpers).
__ta_tmo() {
  __ts=$1; shift
  __tf=$(mktemp "${TMPDIR:-/tmp}/tessel-acct.XXXXXX" 2>/dev/null) || return 1
  "$@" </dev/null >"$__tf" 2>/dev/null &
  __tp=$!
  ( sleep "$__ts"; kill -TERM "$__tp" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
  __tw=$!
  wait "$__tp"; __tr=$?
  kill "$__tw" 2>/dev/null
  cat "$__tf" 2>/dev/null; rm -f "$__tf"
  return "$__tr"
}
__ta_b64d() {
  if printf 'QQ==' | base64 -d >/dev/null 2>&1; then base64 -d
  elif printf 'QQ==' | base64 -D >/dev/null 2>&1; then base64 -D
  elif command -v openssl >/dev/null 2>&1; then tr -d '\n' | openssl base64 -d -A
  else cat >/dev/null; return 1; fi
}
__ta_head() {
  case $5 in *'
'*) return 1 ;; esac
  __m=$(__ta_mt "$4"); [ -n "$__m" ] || __m=-
  printf '@a %s %s %s %s %s\n' "$1" "$2" "$3" "$__m" "$5"
}
# $1 scope, $2 id, $3 config folder, $4 its .claude.json
__ta_claude() {
  __j=$4; __c="$3/.credentials.json"
  if [ "$1" != tessel ] && [ ! -f "$__j" ] && [ ! -f "$__c" ]; then return 0; fi
  __ta_head claude "$1" "$2" "$__j" "$3" || return 0
  if [ -f "$__j" ] && [ -r "$__j" ]; then
    __o=$(__ta_flat "$__j" | __ta_obj oauthAccount)
    if [ -n "$__o" ]; then
      __ta_v email "$(printf '%s' "$__o" | __ta_str emailAddress)"
      __ta_v org "$(printf '%s' "$__o" | __ta_str organizationName)"
      __ta_v orgId "$(printf '%s' "$__o" | __ta_str organizationUuid)"
      __ta_v account "$(printf '%s' "$__o" | __ta_str accountUuid)"
      __ta_v name "$(printf '%s' "$__o" | __ta_str displayName)"
      __ta_v billing "$(printf '%s' "$__o" | __ta_str billingType)"
    fi
    [ "$(__ta_flat "$__j" | __ta_set primaryApiKey)" = 1 ] && __ta_v method apikey
  fi
  if [ -f "$__c" ] && [ -r "$__c" ]; then
    [ "$(__ta_flat "$__c" | __ta_set refreshToken)" = 1 ] || [ "$(__ta_flat "$__c" | __ta_set accessToken)" = 1 ] && __ta_v cred file
    __ta_v plan "$(__ta_flat "$__c" | __ta_str subscriptionType)"
    __ta_v tier "$(__ta_flat "$__c" | __ta_str rateLimitTier)"
  fi
  return 0
}
# $1 scope, $2 id, $3 CODEX_HOME
__ta_codex() {
  __f="$3/auth.json"
  if [ "$1" != tessel ] && [ ! -f "$__f" ]; then return 0; fi
  __ta_head codex "$1" "$2" "$__f" "$3" || return 0
  [ -f "$__f" ] && [ -r "$__f" ] || return 0
  [ "$(__ta_flat "$__f" | __ta_set refresh_token)" = 1 ] && __ta_v cred file
  [ "$(__ta_flat "$__f" | __ta_set OPENAI_API_KEY)" = 1 ] && __ta_v method apikey
  __ta_v mode "$(__ta_flat "$__f" | __ta_str auth_mode)"
  __ta_v account "$(__ta_flat "$__f" | __ta_str account_id)"
  __t=$(__ta_flat "$__f" | __ta_str id_token)
  [ -n "$__t" ] || return 0
  case $__t in *.*.*) ;; *) __t=; return 0 ;; esac
  __p=${__t#*.}; __p=${__p%%.*}; __t=
  __p=$(printf '%s' "$__p" | tr '_-' '/+')
  case $((${#__p} % 4)) in 2) __p="$__p==" ;; 3) __p="$__p=" ;; esac
  __cl=$(printf '%s\n' "$__p" | __ta_b64d 2>/dev/null | tr -d '\n\r'); __p=
  __ta_v email "$(printf '%s' "$__cl" | __ta_str email)"
  __ta_v plan "$(printf '%s' "$__cl" | __ta_str chatgpt_plan_type)"
  __ta_v org "$(printf '%s' "$__cl" | __ta_str workspace_name)"
  __cl=
  return 0
}
# The other agents: their own folder only (no account folders).
__ta_others() {
  __f="$HOME/.gemini/google_accounts.json"; __g="$HOME/.gemini/oauth_creds.json"
  if [ -f "$__f" ] || [ -f "$__g" ]; then
    __ta_head gemini default - "$__f" "$HOME/.gemini" && {
      __ta_v email "$(__ta_flat "$__f" | __ta_str active)"
      [ "$(__ta_flat "$__g" | __ta_set refresh_token)" = 1 ] && __ta_v cred file
    }
  fi
  __f="$HOME/.copilot/config.json"
  if [ -f "$__f" ]; then
    __o=$(__ta_flat "$__f" | __ta_obj last_logged_in_user)
    if [ -n "$__o" ]; then
      __ta_head copilot default - "$__f" "$HOME/.copilot" && {
        __ta_v login "$(printf '%s' "$__o" | __ta_str login)"
        __ta_v site "$(printf '%s' "$__o" | __ta_str host)"
      }
    fi
  fi
  __f="${GROK_HOME:-$HOME/.grok}/auth.json"
  if [ -f "$__f" ]; then
    __ta_head grok default - "$__f" "${GROK_HOME:-$HOME/.grok}" && {
      __ta_v email "$(__ta_flat "$__f" | __ta_str email)"
      [ "$(__ta_flat "$__f" | __ta_set key)" = 1 ] && __ta_v cred file
    }
  fi
  for __f in "${XDG_CONFIG_HOME:-$HOME/.config}/cursor/cli-config.json" "$HOME/.cursor/cli-config.json"; do
    [ -f "$__f" ] || continue
    __o=$(__ta_flat "$__f" | __ta_obj authInfo)
    [ -n "$__o" ] || continue
    __ta_head cursor default - "$__f" "${__f%/*}" && {
      __ta_v email "$(printf '%s' "$__o" | __ta_str email)"
      __ta_v name "$(printf '%s' "$__o" | __ta_str displayName)"
    }
    break
  done
  __f="${KIMI_CODE_HOME:-$HOME/.kimi-code}/credentials/kimi-code.json"
  [ -f "$__f" ] && __ta_head kimi default - "$__f" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" && __ta_v cred file
  __f="$HOME/.qwen/oauth_creds.json"
  [ -f "$__f" ] && __ta_head qwen default - "$__f" "$HOME/.qwen" && { [ "$(__ta_flat "$__f" | __ta_set refresh_token)" = 1 ] && __ta_v cred file; }
  __f="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"
  if [ -f "$__f" ]; then
    __ta_head opencode default - "$__f" "${__f%/*}" && __ta_flat "$__f" | grep -o '"[A-Za-z0-9_.-]*"[[:space:]]*:[[:space:]]*{[[:space:]]*"type"[[:space:]]*:[[:space:]]*"[a-z]*"' 2>/dev/null | head -n 20 | sed 's/^"\([^"]*\)".*"\([a-z]*\)"$/v provider \1 \2/'
  fi
  return 0
}
# Folders Tessel made for one account each: the marker names the agent and id.
__ta_mark() { [ -f "$1/.tessel-account" ] && [ ! -L "$1/.tessel-account" ] && [ "$(head -c 200 "$1/.tessel-account" 2>/dev/null)" = "tessel-account $2 $3" ]; }
__ta_id() { case $1 in ''|*[!0-9a-z]*) return 1 ;; esac; [ ${#1} -le 40 ]; }
__t_accts() {
  printf '@h %s %s\n' "$(uname -s 2>/dev/null | tr -d ' ')" "$HOME"
  __lc=; __lx=
  if [ "$1" = login ]; then
    __sh=${SHELL:-/bin/sh}; __lf=-lc
    case ${__sh##*/} in csh|tcsh) __lf=-c ;; esac
    __le=$(__ta_tmo 6 "$__sh" "$__lf" 'printf "@@E %s\n@@F %s\n" "$CLAUDE_CONFIG_DIR" "$CODEX_HOME"' </dev/null 2>/dev/null)
    __lc=$(printf '%s\n' "$__le" | sed -n 's/^@@E //p' | tail -n 1)
    __lx=$(printf '%s\n' "$__le" | sed -n 's/^@@F //p' | tail -n 1)
  fi
  [ -n "$__lc" ] || __lc=$CLAUDE_CONFIG_DIR
  [ -n "$__lx" ] || __lx=$CODEX_HOME
  __ta_claude default - "$HOME/.claude" "$HOME/.claude.json"
  case $__lc in /*) case $__lc in "$HOME/.claude"|"$HOME/.claude/"|"$HOME"/.tessel-server/*) ;; *) __ta_claude env - "${__lc%/}" "${__lc%/}/.claude.json" ;; esac ;; esac
  __ta_codex default - "$HOME/.codex"
  case $__lx in /*) case $__lx in "$HOME/.codex"|"$HOME/.codex/"|"$HOME"/.tessel-server/*) ;; *) __ta_codex env - "${__lx%/}" ;; esac ;; esac
  for __ag in claude codex; do
    __r="$HOME/.tessel-server/accounts/$__ag"
    [ -d "$__r" ] && [ ! -L "$__r" ] || continue
    __n=0
    for __d in "$__r"/*; do
      [ -d "$__d" ] && [ ! -L "$__d" ] || continue
      __n=$((__n+1)); [ "$__n" -le 50 ] || break
      __i=${__d##*/}
      __ta_id "$__i" && __ta_mark "$__d" "$__ag" "$__i" || continue
      if [ "$__ag" = claude ]; then __ta_claude tessel "$__i" "$__d" "$__d/.claude.json"; else __ta_codex tessel "$__i" "$__d"; fi
    done
  done
  __ta_others
  return 0
}
# Make (new) or repair the folder of one account: ~/.tessel-server/accounts/
# <agent>/<id>, mode 700, with its marker. Claude Code: its conversations,
# plugins, skills... are the default folder's (links into ~/.claude), as on
# the PC, so a pane goes on with its conversation on another account; its
# .claude.json and sign-in are its own. Codex: its settings, hooks and
# instructions are the default ones (links into ~/.codex); its sign-in and
# conversations are its own, as a Codex account's are on the PC
# (remoteShell.js __t_tfile finds them there). Prints the folder.
__t_acctmk() {
  case $1 in claude|codex) ;; *) return 90 ;; esac
  __ta_id "$2" || return 90
  __s="$HOME/.tessel-server"
  for __x in "$__s" "$__s/accounts" "$__s/accounts/$1" "$__s/accounts/$1/$2"; do
    [ -L "$__x" ] && return 98
    if [ -e "$__x" ]; then
      [ -d "$__x" ] && [ -O "$__x" ] || return 98
    else
      [ "$__x" != "$__s/accounts/$1/$2" ] || [ "$3" = new ] || return 91
      ( umask 077; mkdir "$__x" ) || return 98
    fi
    chmod 700 "$__x" || return 98
  done
  __d="$__s/accounts/$1/$2"
  if [ -e "$__d/.tessel-account" ] || [ -L "$__d/.tessel-account" ]; then
    __ta_mark "$__d" "$1" "$2" || return 98
  else
    [ "$3" = new ] || return 91
    [ -z "$(ls -A "$__d" 2>/dev/null)" ] || return 98
    ( umask 077; printf 'tessel-account %s %s\n' "$1" "$2" >"$__d/.tessel-account" ) || return 98
  fi
  if [ "$1" = claude ]; then
    __b="$HOME/.claude"
    [ -d "$__b" ] || ( umask 077; mkdir -p "$__b" ) || return 98
    for __n in projects session-env file-history shell-snapshots todos tasks plans transcripts paste-cache plugins skills agents commands output-styles ide chrome; do
      if [ -e "$__d/$__n" ] || [ -L "$__d/$__n" ]; then continue; fi
      [ -d "$__b/$__n" ] || ( umask 077; mkdir -p "$__b/$__n" ) 2>/dev/null || continue
      ln -s "$__b/$__n" "$__d/$__n" 2>/dev/null
    done
    for __n in settings.json settings.local.json CLAUDE.md keybindings.json; do
      if [ -e "$__d/$__n" ] || [ -L "$__d/$__n" ]; then continue; fi
      [ -f "$__b/$__n" ] && ln -s "$__b/$__n" "$__d/$__n" 2>/dev/null
    done
  else
    __b="$HOME/.codex"
    for __n in config.toml hooks.json AGENTS.md skills prompts rules; do
      if [ -e "$__d/$__n" ] || [ -L "$__d/$__n" ]; then continue; fi
      [ -e "$__b/$__n" ] && ln -s "$__b/$__n" "$__d/$__n" 2>/dev/null
    done
  fi
  printf '%s\n' "$__d"
}
# Remove a folder Tessel made (its marker checked; never another folder, and
# never the agent's own). Its links go, never what they point to (rm does not
# follow them). Codex: its conversations go to the default folder first.
__t_acctrm() {
  case $1 in claude|codex) ;; *) return 90 ;; esac
  __ta_id "$2" || return 90
  __s="$HOME/.tessel-server"
  for __x in "$__s" "$__s/accounts" "$__s/accounts/$1"; do
    [ -d "$__x" ] && [ ! -L "$__x" ] && [ -O "$__x" ] || return 91
  done
  __d="$__s/accounts/$1/$2"
  [ -d "$__d" ] && [ ! -L "$__d" ] && [ -O "$__d" ] || return 91
  __ta_mark "$__d" "$1" "$2" || return 98
  if [ "$1" = codex ] && [ -d "$__d/sessions" ] && [ ! -L "$__d/sessions" ]; then
    ( umask 077; mkdir -p "$HOME/.codex/sessions" ) && cp -Rp "$__d/sessions/." "$HOME/.codex/sessions/" || return 98
  fi
  rm -rf -- "$__d" || return 98
  [ ! -e "$__d" ] || return 98
}
# Sign the agent out of its own default login there (Tessel asks you first):
# its credentials file only, as its own logout does.
__t_acctout() {
  case $1 in
    claude) __f="$HOME/.claude/.credentials.json" ;;
    codex) __f="$HOME/.codex/auth.json" ;;
    *) return 90 ;;
  esac
  [ -L "$__f" ] && return 98
  [ -f "$__f" ] || return 91
  rm -f -- "$__f" || return 98
}
