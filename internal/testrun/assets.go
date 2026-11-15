// SPDX-License-Identifier: MIT

package testrun

import "embed"

// assets holds the files the runner serves under /__ypy__/: the mocha and chai
// browser builds (MIT, with their licenses next to them) and the two small
// scripts of the runner itself.
//
//go:embed assets/boot.js assets/runner.js assets/mocha.js assets/chai.js assets/LICENSE-mocha assets/LICENSE-chai
var assets embed.FS
