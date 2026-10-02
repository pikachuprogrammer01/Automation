# 运行记录与 node 解析，被各 wrapper source。设计见 docs/OBSERVABILITY.md。
# 原则：观测层不允许改变任务的退出码，也不允许因为自己挂掉而让任务失败。

# 目录也算"可执行"，所以必须排掉目录：nvm 目录不存在时 `ls -1d <空>` 会列出当前目录，
# 返回 "."，旧代码的 -x 判断会把它当成 node。
_node_is_usable() {
  [[ -n "$1" && ! -d "$1" && -x "$1" ]]
}

# 解析一个可用的 node 到全局 NODE：NODE_BIN → nvm 最新版 → Homebrew → /usr/local → PATH。
resolve_node() {
  local n="${NODE_BIN:-}"
  if ! _node_is_usable "$n"; then
    local dir="$HOME/.nvm/versions/node"
    if [[ -d "$dir" ]]; then
      local v="$(ls -1 "$dir" 2>/dev/null | sort -V | tail -1)"
      [[ -n "$v" ]] && _node_is_usable "$dir/$v/bin/node" && n="$dir/$v/bin/node"
    fi
  fi
  if ! _node_is_usable "$n"; then
    local c
    for c in /opt/homebrew/bin/node /usr/local/bin/node; do
      if _node_is_usable "$c"; then n="$c"; break; fi
    done
  fi
  if ! _node_is_usable "$n"; then
    n="$(command -v node || true)"
    _node_is_usable "$n" || n=""
  fi
  NODE="$n"
}

run_ctx_init() {
  local site="$1" default_task="$2"
  AUTOMATION_TASK="${AUTOMATION_TASK:-$default_task}"
  # runId 带进程号：同一任务同一秒跑两次（比如手点和定时重叠）会撞名，证据文件会互相覆盖。
  AUTOMATION_RUN_ID="${AUTOMATION_RUN_ID:-$AUTOMATION_TASK-$(date +%Y%m%d-%H%M%S)-$$}"
  AUTOMATION_STARTED_AT="${AUTOMATION_STARTED_AT:-$(date +%s)}"
  if [[ -z "${AUTOMATION_TRIGGER:-}" ]]; then
    # 父进程是 launchd 就是定时触发；管理器会显式传 manager/test。
    case "$(ps -o comm= -p "$PPID" 2>/dev/null)" in
      *launchd) AUTOMATION_TRIGGER=launchd ;;
      *) AUTOMATION_TRIGGER=manual ;;
    esac
  fi
  # 只有没人盯着的定时运行才弹通知：界面点和终端手跑当场就能看到结果。
  if [[ "$AUTOMATION_TRIGGER" == launchd ]]; then AUTOMATION_NOTIFY=1; else AUTOMATION_NOTIFY=0; fi
  export AUTOMATION_TASK AUTOMATION_RUN_ID AUTOMATION_STARTED_AT AUTOMATION_TRIGGER AUTOMATION_NOTIFY
  export AUTOMATION_SITE="$site"
}

run_record() {
  local node="$1" script="$2" code="$3"
  _node_is_usable "$node" || return 0
  [[ -f "$script" ]] || return 0
  printf '%s' "${RUNNER_RESULT:-}" | AUTOMATION_EXIT_CODE="$code" AUTOMATION_PID="$$" \
    "$node" "$script" >/dev/null 2>&1 || true
  return 0
}
