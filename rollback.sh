#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
# WebBubbles Rollback
#
# Usage:
#   ./rollback.sh              # Lists recent tags, lets you pick one
#   ./rollback.sh <tag>        # Rolls back directly to the given tag
#   ./rollback.sh --list       # Just lists recent tags
# ─────────────────────────────────────────────

REPO="indiefan/WebBubbles"
IMAGE="ghcr.io/${REPO,,}"  # lowercase for ghcr

list_tags() {
  echo "Recent image tags (newest first):"
  echo ""
  gh api \
    -H "Accept: application/vnd.github+json" \
    "/orgs/${REPO%%/*}/packages/container/${REPO##*/}/versions" \
    --paginate -q '.[].metadata.container.tags[]' 2>/dev/null \
  || gh api \
    -H "Accept: application/vnd.github+json" \
    "/users/${REPO%%/*}/packages/container/${REPO##*/}/versions" \
    --paginate -q '.[] | select(.metadata.container.tags | length > 0) | .metadata.container.tags[] | select(. != "latest")' 2>/dev/null \
  | head -20
  echo ""
}

trigger_rollback() {
  local tag="$1"
  echo "Triggering rollback to tag: ${tag}"
  gh workflow run rollback.yml \
    -R "$REPO" \
    -f "tag=${tag}"
  echo ""
  echo "Rollback triggered. Monitor progress at:"
  echo "  https://github.com/${REPO}/actions/workflows/rollback.yml"
}

# --- Main ---

if ! command -v gh &>/dev/null; then
  echo "Error: GitHub CLI (gh) is required. Install it: https://cli.github.com"
  exit 1
fi

case "${1:-}" in
  --list|-l)
    list_tags
    ;;
  "")
    list_tags
    echo "Enter the tag to roll back to (or Ctrl+C to cancel):"
    read -r TAG
    if [[ -z "$TAG" ]]; then
      echo "No tag provided. Aborting."
      exit 1
    fi
    trigger_rollback "$TAG"
    ;;
  *)
    trigger_rollback "$1"
    ;;
esac
