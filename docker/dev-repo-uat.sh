#!/usr/bin/env bash
# End-to-end UAT for the dev-repo docker container.
#
# Usage: dev-repo-uat.sh [-v]. Silent by default; with -v it prints each
# test as it runs so a human can follow along. It runs the full lifecycle of
# a throwaway project in /tmp/dev-repo-test-<timestamp>/main (empty git
# repo): dev-repo up, verify the running stack, seed a stale host key,
# dev-repo up again, verify the recreated stack, dev-repo down --force, and
# verify teardown. On success it prints "all tests (N/N) pass"; on failure
# it prints which test failed, its command, and its captured output. The
# /tmp dir and the host-side artifacts (herdr machine, ssh config entry,
# known_hosts entry) are removed on exit, success or failure.
#
# Prerequisites: docker, herdr, and the host model server (models/serve.sh)
# must be running; the container's opencode talks to it via
# host.docker.internal:8778.

set -euo pipefail

verbose=0
if [[ "${1-}" == "-v" ]]; then
    verbose=1
elif [[ -n "${1-}" ]]; then
    echo "usage: dev-repo-uat.sh [-v]" >&2
    exit 2
fi

for tool in docker herdr ssh jq git curl awk mktemp timeout ssh-keygen; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "UAT failed: required tool not found: $tool" >&2
        exit 1
    }
done

if ! curl -sf http://127.0.0.1:8778/v1/models >/dev/null 2>&1; then
    echo "UAT failed: model server not reachable at 127.0.0.1:8778 (start it with models/serve.sh)" >&2
    exit 1
fi

timestamp="$(date +%Y%m%d%H%M%S)"
project_dir="/tmp/dev-repo-test-${timestamp}"
main_dir="${project_dir}/main"
project="$(basename -- "$project_dir")"

rm -rf -- "$project_dir"
mkdir -p -- "$main_dir"
git init -q -- "$main_dir"

# Resolve this repo's dev-repo (following symlinks): the UAT tests the
# code in this checkout, not whatever happens to be on PATH.
script_source="$0"
while [[ -L "$script_source" ]]; do
    link_dir="$(cd -- "$(dirname -- "$script_source")" && pwd -P)"
    script_source="$(readlink -- "$script_source")"
    [[ "$script_source" == /* ]] || script_source="$link_dir/$script_source"
done
repo_root="$(cd -- "$(dirname -- "$script_source")/.." && pwd -P)"
dev_repo="${repo_root}/docker/dev-repo"
if [[ ! -x "$dev_repo" ]]; then
    echo "UAT failed: dev-repo not executable at ${repo_root}/docker/dev-repo" >&2
    exit 1
fi

host=""
ssh_port=""

cleanup() {
    trap - EXIT
    if [[ -n "$host" ]]; then
        local profile_id
        profile_id="$(herdr machine list --json 2>/dev/null \
            | jq -r --arg host "$host" '[ .[] | select(.target == $host) ] | .[0].id' 2>/dev/null)" || profile_id=""
        if [[ "$profile_id" =~ ^[a-f0-9]+$ ]]; then
            herdr machine remove "$profile_id" >/dev/null 2>&1 || true
        fi

        local config_file="$HOME/.ssh/config"
        if [[ -f "$config_file" ]] && grep -qxF "Host $host" "$config_file"; then
            local tmp
            tmp="$(mktemp)"
            awk -v host="$host" '
                $0 == "Host " host { skipping = 1; next }
                {
                    if (skipping) {
                        if ($0 ~ /^Host /) skipping = 0
                        else next
                    }
                    print
                }
            ' "$config_file" > "$tmp"
            cat -- "$tmp" > "$config_file"
            rm -f -- "$tmp"
        fi

        ssh-keygen -R "[127.0.0.1]:${ssh_port}" >/dev/null 2>&1 || true
    fi

    # If dev-repo up died mid-flight, the container may still exist; tear it
    # down so its port range is not left occupied.
    (cd -- "$main_dir" && "$dev_repo" down --force) >/dev/null 2>&1 || true

    rm -rf -- "$project_dir"
}
trap cleanup EXIT

TOTAL_TESTS=24
test_no=0
pass_no=0

# Announce the test as it starts (with -v) and advance the test counter.
begin_test() {
    test_no=$((test_no + 1))
    if [[ "$verbose" == 1 ]]; then
        printf 'test %2d/%d: %s\n' "$test_no" "$TOTAL_TESTS" "$1"
    fi
}

ok_test() {
    pass_no=$((pass_no + 1))
}

fail_test() {
    # $1: description, $2: command, $3: captured output
    local desc="$1" cmd="${2-}" out="${3-}"
    echo "UAT failed at test ${test_no} of ${TOTAL_TESTS}: ${desc}" >&2
    if [[ -n "$cmd" ]]; then
        printf '  command: %s\n' "$cmd" >&2
    fi
    if [[ -n "$out" ]]; then
        printf '  output:\n' >&2
        printf '%s\n' "$out" | sed 's/^/    /' >&2
    else
        printf '  output: (none)\n' >&2
    fi
    exit 1
}

# Verify the full stack for a running container: docker ps, herdr machine,
# ssh (landing in /workspace/main), uid match, devtools in PATH, opencode
# inference, and the version file. Runs seven tests and sets VERSION.
verify_stack() {
    local host="$1" ssh_port="$2"

    begin_test "container $host-dev-1 is running"
    local names
    if ! names="$(docker ps --filter "name=$host" --format '{{.Names}}' 2>&1)"; then
        fail_test "docker ps failed" "docker ps --filter name=$host" "$names"
    fi
    [[ "$names" == "$host-dev-1" ]] \
        || fail_test "container $host-dev-1 is not running" "docker ps --filter name=$host" "$names"
    ok_test

    begin_test "herdr machine $host is registered"
    local herdr_list
    if ! herdr_list="$(herdr machine list --json 2>&1)"; then
        fail_test "herdr machine list failed" "herdr machine list --json" "$herdr_list"
    fi
    if ! jq -e --arg host "$host" '[ .[] | select(.target == $host) ] | length > 0' \
        <<<"$herdr_list" >/dev/null 2>&1; then
        fail_test "herdr machine $host not registered" "herdr machine list --json" "$herdr_list"
    fi
    ok_test

    # ssh stdin is always /dev/null: remote command execution needs no stdin,
    # and a terminal stdin makes "timeout ssh" hang (timeout runs ssh in its
    # own process group, and ssh then does not exit after the remote command
    # finishes).
    # Interactive ssh lands in /workspace/main (non-interactive ssh does not
    # read .bashrc, hence bash -i).
    begin_test "interactive ssh lands in /workspace/main"
    local cwd_out
    if ! cwd_out="$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$host" 'bash -ic pwd 2>/dev/null' </dev/null 2>&1)"; then
        fail_test "ssh to $host failed" "ssh $host 'bash -ic pwd'" "$cwd_out"
    fi
    [[ "$cwd_out" == "/workspace/main" ]] \
        || fail_test "interactive ssh session started in $cwd_out, expected /workspace/main" "ssh $host 'bash -ic pwd'" "$cwd_out"
    ok_test

    # Container user matches the host user.
    begin_test "container uid matches host uid"
    local uid_out
    if ! uid_out="$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$host" 'id -u' </dev/null 2>&1)"; then
        fail_test "ssh to $host failed (id -u)" "ssh $host 'id -u'" "$uid_out"
    fi
    [[ "$uid_out" == "$(id -u)" ]] \
        || fail_test "container uid $uid_out does not match host uid $(id -u)" "ssh $host 'id -u'" "$uid_out"
    ok_test

    # Devtools are installed in the container (rsync'd into /home/agent/bin,
    # which .bashrc prepends to PATH: interactive shell).
    begin_test "new-worktree.sh is in the container PATH"
    local nw_out
    if ! nw_out="$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$host" 'bash -ic "command -v new-worktree.sh" 2>/dev/null' </dev/null 2>&1)"; then
        fail_test "ssh to $host failed (command -v new-worktree.sh)" "ssh $host 'bash -ic \"command -v new-worktree.sh\"'" "$nw_out"
    fi
    [[ -n "$nw_out" && "$nw_out" == /* ]] \
        || fail_test "new-worktree.sh not in container /home/agent/bin" "ssh $host 'bash -ic \"command -v new-worktree.sh\"'" "$nw_out"
    ok_test

    # Opencode inference works.
    begin_test "opencode inference works"
    local oc_out
    # 600s: the model server queues concurrent inference, so a single run can
    # take much longer than the usual few seconds when other runs are active.
    if ! oc_out="$(timeout 600 ssh -o BatchMode=yes -o ConnectTimeout=15 "$host" 'opencode run hi' </dev/null 2>&1)"; then
        fail_test "opencode inference failed" "ssh $host 'opencode run hi'" "$oc_out"
    fi
    ok_test

    # Container version file is present and well-formed.
    begin_test "container version file is well-formed"
    local version
    if ! version="$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$host" 'cat /home/agent/.container_version.txt' </dev/null 2>&1)"; then
        fail_test "could not read /home/agent/.container_version.txt" "ssh $host 'cat /home/agent/.container_version.txt'" "$version"
    fi
    [[ "$version" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}$ ]] \
        || fail_test "unexpected container version: $version" "ssh $host 'cat /home/agent/.container_version.txt'" "$version"
    ok_test

    VERSION="$version"
}

# 1. dev-repo up (fresh container).
begin_test "dev-repo up (fresh container)"
if up_output="$(cd -- "$main_dir" && "$dev_repo" up 2>&1)"; then
    ok_test
else
    fail_test "dev-repo up (fresh container)" "dev-repo up" "$up_output"
fi

# 2. Container name matches the expected pattern.
begin_test "container name matches the expected pattern"
if ! container="$(docker ps --filter "name=dev-${project}" --format '{{.Names}}' 2>&1)"; then
    fail_test "docker ps failed" "docker ps --filter name=dev-${project}" "$container"
fi
if [[ "$container" =~ ^dev-[a-z0-9][a-z0-9_-]*-[0-9]{4,}-dev-1$ ]]; then
    host="${container%-dev-1}"
    range="${host##*-}"
    ssh_port=$((10#$range + 2))
    ok_test
else
    fail_test "expected one dev- container for project $project" "docker ps --filter name=dev-${project}" "$container"
fi

# 3. ssh config entry written by dev-repo.
begin_test "ssh config entry written by dev-repo"
config_err=""
if ! grep -qxF "Host $host" "$HOME/.ssh/config" 2>/dev/null; then
    config_err="$HOME/.ssh/config has no Host $host entry"
elif ! grep -qx "    Port $ssh_port" "$HOME/.ssh/config"; then
    config_err="$HOME/.ssh/config entry for $host does not have Port $ssh_port"
fi
[[ -z "$config_err" ]] || fail_test "ssh config entry for $host is wrong" "grep -qxF 'Host $host' ~/.ssh/config" "$config_err"
ok_test

# 4-10. Verify the running stack.
verify_stack "$host" "$ssh_port"
v1="$VERSION"

# Seed a stale host key for this port so the recreate step must detect and
# replace it: an earlier container assigned the same port range leaves its
# key in known_hosts, and keeping it makes ssh fail with "REMOTE HOST
# IDENTIFICATION HAS CHANGED".
ssh-keygen -R "[127.0.0.1]:${ssh_port}" >/dev/null 2>&1 || true
fake_key_file="$(mktemp -u)"
if ! ssh-keygen -t ed25519 -q -N "" -f "$fake_key_file" >/dev/null 2>&1; then
    echo "UAT failed during setup: could not generate a fake host key" >&2
    exit 1
fi
fake_key="$(awk '{print $2}' "$fake_key_file.pub" 2>/dev/null)"
if [[ -z "$fake_key" ]]; then
    echo "UAT failed during setup: could not read the generated fake host key" >&2
    exit 1
fi
printf '[127.0.0.1]:%s ssh-ed25519 %s\n' "$ssh_port" "$fake_key" >> "$HOME/.ssh/known_hosts"
rm -f -- "$fake_key_file" "$fake_key_file.pub"

# 11. dev-repo up again (recreate, stale host key in place).
begin_test "dev-repo up (recreate, stale host key in place)"
if up_output="$(cd -- "$main_dir" && "$dev_repo" up 2>&1)"; then
    ok_test
else
    fail_test "dev-repo up (recreate)" "dev-repo up" "$up_output"
fi

# 12. Recreated container reuses the same name and ports.
begin_test "recreated container reuses the same name and ports"
if ! container="$(docker ps --filter "name=dev-${project}" --format '{{.Names}}' 2>&1)"; then
    fail_test "docker ps failed" "docker ps --filter name=dev-${project}" "$container"
fi
[[ "$container" == "${host}-dev-1" ]] \
    || fail_test "recreated container is $container, expected ${host}-dev-1" "docker ps --filter name=dev-${project}" "$container"
ok_test

# 13-19. Re-verify the running stack.
verify_stack "$host" "$ssh_port"
v2="$VERSION"

# 20. Container version strictly newer.
begin_test "container version strictly newer"
[[ "$v2" > "$v1" ]] \
    || fail_test "container version did not get newer: was $v1, still $v2" "compare /home/agent/.container_version.txt" "$v1 -> $v2"
ok_test

# 21. dev-repo down --force.
begin_test "dev-repo down --force"
if down_output="$(cd -- "$main_dir" && "$dev_repo" down --force 2>&1)"; then
    ok_test
else
    fail_test "dev-repo down --force" "dev-repo down --force" "$down_output"
fi

# 22. Container is gone.
begin_test "container is gone after down"
if ! names="$(docker ps -a --filter "name=dev-${project}" --format '{{.Names}}' 2>&1)"; then
    fail_test "docker ps -a failed" "docker ps -a --filter name=dev-${project}" "$names"
fi
[[ -z "$names" ]] || fail_test "container $host still exists after down" "docker ps -a --filter name=dev-${project}" "$names"
ok_test

# 23. Volumes are gone.
begin_test "volumes are gone after down"
if ! volumes="$(docker volume ls --filter "name=${host}_" --format '{{.Name}}' 2>&1)"; then
    fail_test "docker volume ls failed" "docker volume ls --filter name=${host}_" "$volumes"
fi
[[ -z "$volumes" ]] || fail_test "volumes remain after down" "docker volume ls --filter name=${host}_" "$volumes"
ok_test

# 24. dev-repo ls no longer lists the host.
begin_test "dev-repo ls no longer lists the host"
if ! ls_output="$(cd -- "$main_dir" && "$dev_repo" ls 2>&1)"; then
    fail_test "dev-repo ls failed" "dev-repo ls" "$ls_output"
fi
if grep -qF -- "$host" <<<"$ls_output"; then
    fail_test "dev-repo ls still lists $host after down" "dev-repo ls" "$ls_output"
fi
ok_test

echo "all tests (${pass_no}/${TOTAL_TESTS}) pass"
