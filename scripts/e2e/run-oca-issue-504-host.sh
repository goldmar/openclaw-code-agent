#!/bin/sh
# Counted private entry for a fresh remote-heavy-run --toolchain none workspace.
# Usage: sh scripts/e2e/run-oca-issue-504-host.sh --expected-sha SHA --node-floor FLOOR --mode host|gates|focused
set -eu
umask 077
# Caller environment can never select an existing root.
owned_root=$(/usr/bin/python3 -I - <<'PYROOT'
import json, os, secrets, stat
cwd = os.getcwd()
fd = os.open(cwd, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
parents = []
for name in [None, '.reports', 'issue504']:
    if name:
        try: os.mkdir(name, 0o700, dir_fd=fd)
        except FileExistsError: pass
        nxt = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd); fd = nxt; cwd = os.path.join(cwd, name)
    st = os.fstat(fd); assert st.st_uid == os.getuid()
    parents.append({'path': cwd, 'dev': st.st_dev, 'ino': st.st_ino, 'uid': st.st_uid})
name = 'slim.' + secrets.token_hex(12)
os.mkdir(name, 0o700, dir_fd=fd)
root_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
st = os.fstat(root_fd)
for file, data in [('.owner', 'oca504-slim-v1\n'), ('.identity', json.dumps({'dev': st.st_dev, 'ino': st.st_ino, 'uid': st.st_uid, 'parents': parents}))]:
    with os.fdopen(os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root_fd), 'w') as target: target.write(data)
print(os.path.join(cwd, name))
PYROOT
)
exec env -i PATH=/usr/bin:/bin LANG=C.UTF-8 OCA504_OWNED_ROOT="$owned_root" sh -s -- "$@" <<'PRIVATE_BOOTSTRAP'
set -eu
umask 077
task_root=$OCA504_OWNED_ROOT
case "$task_root" in "$PWD"/.reports/issue504/slim.*) ;; *) exit 1 ;; esac
[ "$(cat "$task_root/.owner")" = oca504-slim-v1 ]
# Failures remain owned by canonical workdir retention; shell exit is not cleanup proof.
trap 'printf "%s\n" "ISSUE504_BOOTSTRAP_BLOCKED; retained storage UNPROVEN" >&2' 0
floor= mode= sha= previous=
for arg do
  case "$previous" in --node-floor) floor=$arg ;; --mode) mode=$arg ;; --expected-sha) sha=$arg ;; esac
  previous=$arg
done
case "$floor" in
  24.16.0) node_hash=2faf6a387e9b62b888e21c54f01249fb27537ffecf1842f29f4c919d0a59a0ff ;;
  26.1.0) node_hash=62d555c329e05e3625109f2e3a8b5195b368d5ef38266292469d32f63cd98ffd ;;
  *) exit 1 ;;
esac
case "$mode" in host|gates|focused) ;; *) exit 1 ;; esac
[ "$(git rev-parse HEAD)" = "$sha" ] && [ -z "$(git status --porcelain --untracked-files=no)" ]
export HOME="$task_root/home" OPENCLAW_HOME="$task_root/home" OPENCLAW_STATE_DIR="$task_root/state"
export OPENCLAW_CONFIG_PATH="$task_root/config.json" CODEX_HOME="$task_root/codex"
export XDG_CONFIG_HOME="$task_root/config" XDG_DATA_HOME="$task_root/data" XDG_STATE_HOME="$task_root/xdg-state" XDG_CACHE_HOME="$task_root/cache"
export XDG_RUNTIME_DIR="$task_root/runtime"
export TMPDIR="$task_root/tmp" TMP="$task_root/tmp" TEMP="$task_root/tmp" GH_CONFIG_DIR="$task_root/gh"
export GIT_CONFIG_GLOBAL="$task_root/gitconfig" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
export NPM_CONFIG_USERCONFIG="$task_root/npm-user.conf" NPM_CONFIG_GLOBALCONFIG="$task_root/npm-global.conf"
export NPM_CONFIG_CACHE="$task_root/npm-cache" NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
export OPENCLAW_DISABLE_BONJOUR=1 OPENCLAW_EXEC_SHELL_SNAPSHOT=0 OPENCLAW_NO_RESPAWN=1 OPENCLAW_SKIP_CHANNELS=1
export OCA504_FIXTURE_KEY=synthetic-local-fixture-only
mkdir -p "$HOME" "$OPENCLAW_STATE_DIR" "$CODEX_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" "$TMPDIR" "$GH_CONFIG_DIR"
if [ "$mode" != host ]; then
  # Ordinary temp fixtures must not inherit the candidate's module/Git scope.
  printf '{"type":"commonjs"}\n' > "$TMPDIR/package.json"
  export GIT_CEILING_DIRECTORIES="$TMPDIR"
fi
: > "$GIT_CONFIG_GLOBAL"; : > "$NPM_CONFIG_GLOBALCONFIG"
printf 'verify-deps-before-run=error\nstore-dir=%s/store\n' "$task_root" > "$NPM_CONFIG_USERCONFIG"
curl --fail --silent --show-error --max-time 120 --max-filesize 134217728 --proto '=https' --tlsv1.2 "https://nodejs.org/dist/v$floor/node-v$floor-linux-x64.tar.gz" -o "$task_root/node.tar.gz"
printf '%s  %s\n' "$node_hash" "$task_root/node.tar.gz" | sha256sum -c - > "$task_root/node-check.log"
mkdir "$task_root/node"; tar -xzf "$task_root/node.tar.gz" --strip-components=1 -C "$task_root/node"
export PATH="$task_root/node/bin:$task_root/pm/node_modules/.bin:/usr/bin:/bin"
[ "$(node --version)" = "v$floor" ] || { printf '%s\n' 'Private Node runtime prerequisite unavailable (including libatomic.so.1 on Node26)' >&2; exit 1; }
curl --fail --silent --show-error --max-time 120 --max-filesize 67108864 --proto '=https' --tlsv1.2 https://registry.npmjs.org/pnpm/-/pnpm-11.15.1.tgz -o "$task_root/pnpm.tgz"
pnpm_sri='gTULB+U8lTigLx8jA7QpD6LXvgTlbiqXDEzEtBfcdh3hlu2r1J1Vx9yVgNuBAHxEFD5OPX5GKzAA0jwlUSLQZQ=='
[ "$(openssl dgst -sha512 -binary "$task_root/pnpm.tgz" | openssl base64 -A)" = "$pnpm_sri" ]
npm install --prefix "$task_root/pm" --ignore-scripts --no-audit --no-fund "$task_root/pnpm.tgz" > "$task_root/pm-install.log" 2>&1
[ "$(pnpm --version)" = 11.15.1 ]
if [ "$mode" != host ]; then
  pnpm install --frozen-lockfile --store-dir "$task_root/store"
else
  pnpm install --frozen-lockfile --store-dir "$task_root/store" > "$task_root/frozen-install.log" 2>&1
fi
trap - 0
exec "$task_root/node/bin/node" --import tsx scripts/e2e/oca-issue-504-host-acceptance.ts "$@"
PRIVATE_BOOTSTRAP
