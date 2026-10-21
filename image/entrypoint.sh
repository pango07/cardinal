#!/usr/bin/env bash
# Runs exactly one GitHub Actions job from a JIT config, then exits.
#
# Env:
#   CARDINAL_JIT_CONFIG      required; encoded_jit_config from generate-jitconfig
#   CARDINAL_IDLE_TIMEOUT    seconds to wait for a job before giving up (default 300).
#                            JIT runners take any queued job with matching labels, so if the
#                            job that triggered us was cancelled or taken by a sibling, we'd
#                            otherwise sit idle until the sandbox timeout.
set -euo pipefail

# The dispatcher runs us as root (sudo) so we don't depend on the sandbox's default user;
# drop to `runner` so jobs see the same uid/sudo setup as a GitHub-hosted runner.
if [[ "$(id -u)" == "0" ]]; then
  exec runuser -u runner -- env HOME=/home/runner USER=runner \
    CARDINAL_JIT_CONFIG="${CARDINAL_JIT_CONFIG:-}" \
    CARDINAL_IDLE_TIMEOUT="${CARDINAL_IDLE_TIMEOUT:-}" \
    bash "$0" "$@"
fi

: "${CARDINAL_JIT_CONFIG:?missing JIT config}"
idle_timeout="${CARDINAL_IDLE_TIMEOUT:-300}"
cd /home/runner

ts() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
echo "cardinal: runner v$(cat .runner-version) starting at $(ts)"

log="$(mktemp)"
# --jitconfig = ephemeral, single-job, self-deregistering. Exits when the job finishes.
./run.sh --jitconfig "$CARDINAL_JIT_CONFIG" > >(tee "$log") 2>&1 &
runner_pid=$!
unset CARDINAL_JIT_CONFIG

# Forward stop signals so the runner can report the job as cancelled rather than vanish.
trap 'kill -TERM "$runner_pid" 2>/dev/null || true' TERM INT

listening=0
for ((i = 0; i < idle_timeout; i++)); do
  kill -0 "$runner_pid" 2>/dev/null || break
  if (( !listening )) && grep -q "Listening for Jobs" "$log"; then
    listening=1
    echo "cardinal: listening at $(ts)"
  fi
  if grep -q "Running job:" "$log"; then
    echo "cardinal: job started at $(ts)"
    break
  fi
  sleep 1
done

if kill -0 "$runner_pid" 2>/dev/null && ! grep -q "Running job:" "$log"; then
  echo "cardinal: no job within ${idle_timeout}s, shutting down" >&2
  kill -TERM "$runner_pid" 2>/dev/null || true
fi

set +e
wait "$runner_pid"
code=$?
# A trapped signal interrupts `wait` early; keep waiting until the runner has actually exited.
while kill -0 "$runner_pid" 2>/dev/null; do
  wait "$runner_pid"
  code=$?
done
echo "cardinal: runner exited $code at $(ts)"
exit "$code"
