#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
# WebBubbles dev sign-in
#
# Stores the BlueBubbles server URL and password in the macOS login keychain
# so `npm run dev` can sign itself in. Nothing is written to the project.
#
# Usage:
#   ./scripts/dev-login.sh <server-url>    # prompts for the password (hidden)
#   ./scripts/dev-login.sh --remove        # deletes both keychain items
# ─────────────────────────────────────────────

SERVICE="webbubbles-dev"

if ! command -v security &>/dev/null; then
  echo "Error: this script needs the macOS 'security' tool."
  exit 1
fi

if [[ "${1:-}" == "--remove" ]]; then
  security delete-generic-password -s "$SERVICE" -a server-url &>/dev/null || true
  security delete-generic-password -s "$SERVICE" -a password &>/dev/null || true
  echo "Removed the WebBubbles dev sign-in from the keychain."
  exit 0
fi

URL="${1:-}"
if [[ -z "$URL" ]]; then
  read -r -p "BlueBubbles server URL: " URL
fi
URL="${URL%/}"
if [[ ! "$URL" =~ ^https?:// ]]; then
  echo "Error: the server URL must start with http:// or https://"
  exit 1
fi

security add-generic-password -U -s "$SERVICE" -a server-url -w "$URL"

echo "Enter the BlueBubbles server password (input is hidden, asked twice)."
# -w with no value makes `security` prompt, so the password never touches
# the command line or shell history.
security add-generic-password -U -s "$SERVICE" -a password -w

echo ""
echo "Saved. 'npm run dev' will now sign in to $URL on its own."
