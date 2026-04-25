if [ -z "${__WT_SCRIPT_DIR:-}" ]; then
  if [ -n "${BASH_SOURCE:-}" ]; then
    __WT_SOURCE="${BASH_SOURCE[0]}"
  elif [ -n "${ZSH_VERSION:-}" ]; then
    __WT_SOURCE="${(%):-%x}"
  else
    __WT_SOURCE=""
  fi

  if [ -n "$__WT_SOURCE" ]; then
    __WT_SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$__WT_SOURCE")" && pwd)"
  fi

  unset __WT_SOURCE
fi

wt() {
  local wt_target
  local wt_executable
  wt_executable="$(command -v wt 2>/dev/null || true)"

  if [ "$#" -eq 1 ] && { [ "$1" = "status" ] || [ "$1" = "--help" ] || [ "$1" = "-h" ] || [ "$1" = "help" ]; }; then
    if [ -n "$wt_executable" ] && [ "$wt_executable" != "wt" ]; then
      "$wt_executable" "$@"
    else
      if [ -z "${__WT_SCRIPT_DIR:-}" ]; then
        echo "wt: cannot locate wt executable" >&2
        return 127
      fi

      node "$__WT_SCRIPT_DIR/../bin/wt.js" "$@"
    fi
    return $?
  fi

  if [ -n "$wt_executable" ] && [ "$wt_executable" != "wt" ]; then
    wt_target="$("$wt_executable" --resolve "$@")" || return $?
  else
    if [ -z "${__WT_SCRIPT_DIR:-}" ]; then
      echo "wt: cannot locate wt executable" >&2
      return 127
    fi

    wt_target="$(node "$__WT_SCRIPT_DIR/../bin/wt.js" --resolve "$@")" || return $?
  fi

  cd "$wt_target" || return $?
}
