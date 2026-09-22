/** Quote one argument for the POSIX shell SSH uses to dispatch a command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Select Bash before loading any login files. Starting with `sh -lc` already
 * evaluates .profile under dash, so switching shells inside that script is too late
 * for a profile containing Bash's `source`. The selector is non-login POSIX sh;
 * the payload stays one argument (and stdin stays available for archive uploads).
 * Without Bash, sh's login loader uses POSIX `.` and only its own profile files.
 */
export function remoteShellCommand(script: string): string {
  const select = 'if command -v bash >/dev/null 2>&1; then exec bash -lc "$1"; else exec sh -lc "$1"; fi';
  return `sh -c ${shellQuote(select)} fastvibe-ssh ${shellQuote(script)}`;
}

/**
 * Print the environment an interactive login shell ends up with, between markers.
 *
 * Only a compatible shell is asked to load interactive configuration. Login Bash does
 * not necessarily read .bashrc — where Node managers, and just as often proxy settings,
 * commonly live. Zsh already reads its own rc (including ZDOTDIR); sh must never read
 * either one's rc files.
 *
 * `awk` dumps `ENVIRON` as `export NAME='value'` lines: every value single-quoted, so
 * sourcing them back can never execute anything, and names limited to identifiers. A
 * value spanning lines is skipped, which keeps the output filterable line by line.
 */
export function loginEnvProbe(): string[] {
  const dump = [
    'printf "\\n__FV_ENV__\\n"',
    `awk -v q="'" ${shellQuote('BEGIN { for (k in ENVIRON) { v = ENVIRON[k]; if (k !~ /^[A-Za-z_][A-Za-z0-9_]*$/ || index(v, "\\n")) continue; gsub(q, q "\\\\" q q, v); print "export " k "=" q v q } }')}`,
    'printf "__FV_ENV_END__\\n"',
  ].join("; ");
  return [
    'PROBE_SHELL="${SHELL:-}"',
    'case "${PROBE_SHELL##*/}" in bash|zsh) [ -x "$PROBE_SHELL" ] || PROBE_SHELL="" ;; *) PROBE_SHELL="" ;; esac',
    'if [ -z "$PROBE_SHELL" ]; then PROBE_SHELL=$(command -v bash 2>/dev/null || command -v sh); fi',
    'case "${PROBE_SHELL##*/}" in',
    `  bash) exec "$PROBE_SHELL" -ilc ${shellQuote(`[ ! -r "$HOME/.bashrc" ] || . "$HOME/.bashrc"; ${dump}`)} ;;`,
    `  *) exec "$PROBE_SHELL" -ilc ${shellQuote(dump)} ;;`,
    'esac',
  ];
}

/**
 * Names that describe this session or the probing shell itself, not the user's setup.
 * They keep the values of the SSH session running the script.
 */
const SESSION_VARIABLES = "PWD|OLDPWD|SHLVL|_|PS[1-4]|PROMPT_COMMAND|TERM|HOME|USER|LOGNAME|SHELL|MAIL|COLUMNS|LINES|ENV|HIST[A-Z_]*|SSH_[A-Z_]*|BASH[A-Z_]*|ZSH[A-Z_]*|FASTVIBE_[A-Z_]*";

/**
 * Define `load_login_env`: apply the user's interactive login environment to this script.
 *
 * `ssh host cmd` runs a login shell at most, so anything the user sets in .bashrc or
 * .zshrc — Node managers, JAVA_HOME, and above all `https_proxy`, without which a host
 * behind the GFW cannot reach GitHub or nodejs.org — is missing unless loaded here. The
 * probe runs in the background with a ten-second budget, so an rc file that waits for
 * input cannot hang a connect; its stderr is dropped. PATH keeps the rc's entries first
 * and the session's after them, as a terminal would have it.
 *
 * Proxy variables are then mirrored between cases: curl reads `HTTPS_PROXY` or
 * `https_proxy`, but wget only the lower-case one, and `http_proxy` only lower-case in
 * curl too. The proxy in use is logged with any credentials masked.
 */
export function loginEnvironment(): string[] {
  return [
    'load_login_env() {',
    '  FV_ENV_TMP=$(mktemp 2>/dev/null) || return 0',
    '  (',
    ...loginEnvProbe().map((line) => `    ${line}`),
    '  ) >"$FV_ENV_TMP" 2>/dev/null </dev/null &',
    '  FV_ENV_PID=$!',
    '  N=0',
    '  while [ "$N" -lt 100 ]; do',
    '    grep -q "^__FV_ENV_END__$" "$FV_ENV_TMP" 2>/dev/null && break',
    '    kill -0 "$FV_ENV_PID" 2>/dev/null || break',
    '    N=$((N+1)); sleep 0.1',
    '  done',
    '  kill "$FV_ENV_PID" 2>/dev/null || true',
    '  if grep -q "^__FV_ENV_END__$" "$FV_ENV_TMP" 2>/dev/null; then',
    `    sed -n '/^__FV_ENV__$/,/^__FV_ENV_END__$/p' "$FV_ENV_TMP" | grep '^export ' | grep -Ev ${shellQuote(`^export (${SESSION_VARIABLES})=`)} >"$FV_ENV_TMP.env"`,
    '    FV_SESSION_PATH=$PATH',
    '    . "$FV_ENV_TMP.env"',
    '    PATH="$PATH:$FV_SESSION_PATH"; export PATH',
    '    echo "已加载登录 shell 的环境变量"',
    '  fi',
    '  rm -f "$FV_ENV_TMP" "$FV_ENV_TMP.env"',
    ...['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].map((lower) => {
      const upper = lower.toUpperCase();
      return `  if [ -z "\${${lower}:-}" ] && [ -n "\${${upper}:-}" ]; then ${lower}=$${upper}; export ${lower}; elif [ -z "\${${upper}:-}" ] && [ -n "\${${lower}:-}" ]; then ${upper}=$${lower}; export ${upper}; fi`;
    }),
    '  FV_PROXY="${https_proxy:-${all_proxy:-${http_proxy:-}}}"',
    `  if [ -n "$FV_PROXY" ]; then printf "使用代理：%s\\n" "$(printf "%s" "$FV_PROXY" | sed 's|//[^@/]*@|//***@|')"; fi`,
    '}',
  ];
}

/** The only GitHub mirror used: its prefix is put in front of a full github.com URL. */
export const GITHUB_MIRROR = "https://gh-proxy.com/";
/** npmmirror's copy of nodejs.org/dist, SHASUMS256.txt included. */
export const NODE_MIRROR = "https://cdn.npmmirror.com/binaries/node";

/**
 * Shell functions for a download that reports progress and falls back to a mirror.
 *
 * - `fv_download PHASE OUT URL [MIRROR_URL]` fetches the official URL first. Only when that
 *   fails — no connection, an HTTP error, or a transfer stuck below 10 KB/s for 20 s — is
 *   the mirror tried, with more patient limits. `FV_SOURCE` names the URL that worked.
 * - While a transfer runs, one `FASTVIBE_PROGRESS PHASE BYTES TOTAL` line is printed per
 *   second (TOTAL empty when the server sent no length). The desktop turns those into a
 *   progress bar and keeps them out of the log.
 *
 * The official source is tried with a short fuse on purpose: a host that cannot reach
 * GitHub or nodejs.org should reach the mirror in seconds, not after a string of retries.
 */
export function downloadHelpers(): string[] {
  return [
    'if command -v curl >/dev/null 2>&1; then FETCH=curl; elif command -v wget >/dev/null 2>&1; then FETCH=wget; else FETCH=""; fi',
    'fv_host() { printf "%s" "$1" | sed "s|^[a-z]*://\\([^/]*\\).*|\\1|"; }',
    'fv_size() { if [ -f "$1" ]; then wc -c < "$1" | tr -d " "; else echo 0; fi; }',
    // Redirects print several header blocks; the last Content-Length is the file's.
    'fv_length() { sed -n "s/^ *[Cc]ontent-[Ll]ength: *\\([0-9][0-9]*\\).*/\\1/p" "$1" 2>/dev/null | tail -n 1; }',
    // fv_fetch STRICT URL OUT HEADERS: one attempt, in the background (FV_FETCH_PID).
    'fv_fetch() {',
    '  rm -f "$3" "$4"',
    '  if [ "$FETCH" = curl ]; then',
    '    if [ "$1" = 1 ]; then curl -fsSL --connect-timeout 10 --speed-limit 10240 --speed-time 20 -D "$4" -o "$3" "$2" & else curl -fsSL --connect-timeout 15 --retry 2 --retry-delay 1 --speed-limit 1024 --speed-time 30 -D "$4" -o "$3" "$2" & fi',
    '  else',
    '    if [ "$1" = 1 ]; then wget -q -S --timeout=15 --tries=1 -O "$3" "$2" 2>"$4" & else wget -q -S --timeout=30 --tries=2 -O "$3" "$2" 2>"$4" & fi',
    '  fi',
    '  FV_FETCH_PID=$!',
    '}',
    'fv_progress() { printf "FASTVIBE_PROGRESS %s %s %s\\n" "$1" "$(fv_size "$2")" "$(fv_length "$3")"; }',
    // fv_attempt PHASE STRICT URL OUT: fetch and report progress until it ends.
    'fv_attempt() {',
    '  fv_fetch "$2" "$3" "$4" "$4.headers"',
    '  while kill -0 "$FV_FETCH_PID" 2>/dev/null; do fv_progress "$1" "$4" "$4.headers"; sleep 1; done',
    '  wait "$FV_FETCH_PID"; FV_STATUS=$?',
    '  if [ "$FV_STATUS" = 0 ] && [ -s "$4" ]; then fv_progress "$1" "$4" "$4.headers"; rm -f "$4.headers"; return 0; fi',
    '  rm -f "$4" "$4.headers"',
    '  return 1',
    '}',
    'fv_download() {',
    '  [ -n "$FETCH" ] || { echo "远程主机缺少 curl 或 wget，无法下载" >&2; return 127; }',
    '  FV_SOURCE="$3"',
    '  fv_attempt "$1" 1 "$3" "$2" && return 0',
    '  [ -n "${4:-}" ] || return 1',
    '  echo "$(fv_host "$3") 下载失败，改用镜像源 $(fv_host "$4")…"',
    '  FV_SOURCE="$4"',
    '  fv_attempt "$1" 0 "$4" "$2"',
    '}',
  ];
}
