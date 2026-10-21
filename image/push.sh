#!/usr/bin/env bash
# Builds the runner image and pushes it to Vercel Container Registry for the linked project.
# Run from a directory linked with `vercel link` (e.g. dispatcher/).
#
# Usage: image/push.sh [tag]           (default tag: v0.1)
# Env:   RUNNER_VERSION=2.338.0        pin actions/runner (default: latest)
#        CARDINAL_IMAGE_REF=<ref>      skip discovery and push here, e.g. vcr.vercel.com/<team>/<project>/cardinal-runner
set -euo pipefail

tag="${1:-v0.1}"
repo="cardinal-runner"
here="$(cd "$(dirname "$0")" && pwd)"

if [[ -z "${CARDINAL_IMAGE_REF:-}" ]]; then
  project_json=".vercel/project.json"
  [[ -f "$project_json" ]] || { echo "no $project_json here; run from a directory linked with 'vercel link'" >&2; exit 1; }
  project="$(jq -r .projectName "$project_json")"
  org_id="$(jq -r .orgId "$project_json")"
  team="$(vercel teams ls --format json 2>/dev/null | jq -r --arg id "$org_id" '.teams[] | select(.id == $id) | .slug')"
  [[ -n "$team" ]] || { echo "could not resolve team slug for $org_id; set CARDINAL_IMAGE_REF" >&2; exit 1; }
  CARDINAL_IMAGE_REF="vcr.vercel.com/$team/$project/$repo"

  vercel vcr add "$repo" >/dev/null 2>&1 || true   # no-op if it already exists
  vercel vcr login docker
fi

echo "building $CARDINAL_IMAGE_REF:$tag"
docker buildx build \
  --platform linux/amd64 \
  --build-arg "RUNNER_VERSION=${RUNNER_VERSION:-latest}" \
  --provenance=false \
  -t "$CARDINAL_IMAGE_REF:$tag" \
  --push \
  "$here"

echo
echo "pushed. set CARDINAL_IMAGE=$repo:$tag in the dispatcher project."
