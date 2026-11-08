#!/usr/bin/env bash
# Starts the Throngs office and opens it in your browser.
cd "$(dirname "$0")"
exec node bin/sm.js office "$@"
