#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Runs every gate on this machine, the same ones as the GitHub workflow.
# Same as: go run ./cmd/ypy ci [options]   (see --help)
# The Go toolchain is the one go.mod pins, even if GOTOOLCHAIN says otherwise.
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
tc="$(awk '$1 == "toolchain" { print $2 }' go.mod)"
[ -n "$tc" ] && export GOTOOLCHAIN="$tc"
exec go run ./cmd/ypy ci "$@"
