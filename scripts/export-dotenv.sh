# export-dotenv.sh — SOURCE this to export a .env file without shell-interpreting the values.
#
#   DOTENV_FILE=/run/secrets/dotenv; . scripts/export-dotenv.sh
#
# The file path MUST arrive via $DOTENV_FILE, not as an argument. POSIX leaves `.` arguments
# undefined and dash (Debian/Ubuntu /bin/sh — what the build image runs) silently ignores them:
# the sourced script sees the CALLER's positional parameters, so a `${1:-}` reads empty, the
# guard below returns early, and nothing gets exported — with exit 0 and no message. bash DOES
# pass source arguments, which makes the argument form work everywhere except production.
#
# Why this exists. The image build used `set -a; . "$envfile"; set +a`, which asks the shell to
# PARSE the env file as a script. Any unquoted value holding a shell metacharacter then changes
# the meaning of the line. A Neon connection string ends in
#     ?sslmode=require&channel_binding=require
# and that `&` splits the line into an asynchronous list: the assignment runs in a subshell and
# the parent shell never receives it. The build dies with "DATABASE_URL: Required" while the
# value sits in plain sight in the file, and only the keys AFTER the `&` survive — a genuinely
# confusing failure to read off a build log.
#
# docker compose's `env_file` parser does not shell-interpret values, so the very same file works
# at runtime and fails only at build time. This reader matches compose's behaviour: split on the
# first `=`, take the remainder literally, and strip at most one layer of surrounding quotes.
# Values are therefore safe unquoted, which is what every managed-Postgres provider hands you.
#
# POSIX sh only (the build stage runs under /bin/sh). Variables are prefixed and unset at the end
# so sourcing this cannot collide with the caller's names.

# $DOTENV_FILE is required (see header); ${1:-} remains as a bash convenience for local use.
__dotenv_file="${DOTENV_FILE:-${1:-}}"
[ -n "$__dotenv_file" ] && [ -f "$__dotenv_file" ] || return 0

__dotenv_cr="$(printf '\r')"

while IFS= read -r __dotenv_line || [ -n "$__dotenv_line" ]; do
  # Tolerate CRLF files — an operator editing .env.production on Windows would otherwise put a
  # trailing carriage return inside every value (a CR in DATABASE_URL breaks the connection).
  __dotenv_line="${__dotenv_line%"$__dotenv_cr"}"

  case "$__dotenv_line" in
    '' | '#'*) continue ;;
    *=*) ;;
    *) continue ;;
  esac

  __dotenv_key="${__dotenv_line%%=*}"
  __dotenv_val="${__dotenv_line#*=}"

  # Accept `export FOO=bar` as well as `FOO=bar`.
  case "$__dotenv_key" in
    'export '*) __dotenv_key="${__dotenv_key#export }" ;;
  esac

  # Skip anything that is not a plain shell identifier: prose, indented keys, stray `=` in a
  # comment. Exporting those would either fail or inject junk into the environment.
  case "$__dotenv_key" in
    '' | *[!A-Za-z0-9_]*) continue ;;
  esac

  # Strip one layer of surrounding quotes, as compose does. Values keep every other character
  # literally — no expansion, no word splitting, no globbing.
  case "$__dotenv_val" in
    '"'*'"') __dotenv_val="${__dotenv_val#\"}" ; __dotenv_val="${__dotenv_val%\"}" ;;
    "'"*"'") __dotenv_val="${__dotenv_val#\'}" ; __dotenv_val="${__dotenv_val%\'}" ;;
  esac

  export "$__dotenv_key=$__dotenv_val"
done < "$__dotenv_file"

unset __dotenv_file __dotenv_cr __dotenv_line __dotenv_key __dotenv_val DOTENV_FILE
