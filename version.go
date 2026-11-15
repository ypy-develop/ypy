// SPDX-License-Identifier: MIT

// Package ypy holds the one version of the repository. The file VERSION at the
// root is the source: the build stamps it into the core (ypy.version), `ypy gen`
// writes it into the editor data, and the tools report it through Version.
package ypy

import (
	_ "embed"
	"strings"
)

//go:embed VERSION
var version string

// Version is the content of the VERSION file, for example "0.1.1".
func Version() string { return strings.TrimSpace(version) }
