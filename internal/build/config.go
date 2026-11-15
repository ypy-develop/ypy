// SPDX-License-Identifier: MIT

package build

// The build is driven by this table: which sources feed which outputs. Adding
// an extension to the max bundle is a change here, not in the
// pipeline.

const (
	// coreSource is the framework source, relative to the repository root.
	coreSource = "src/ypy.js"
	// typesSource is copied as-is next to the core.
	typesSource = "src/ypy.d.ts"
	// extDir holds one file per extension; every *.js in it is published.
	extDir = "src/ext"
	// editorsDir and skillsDir are copied to dist/editors and dist/skills.
	editorsDir = "src/editors"
	skillsDir  = "src/skills"
)

// Output names.
const (
	outCore       = "ypy.js"
	outCoreMin    = "ypy.min.js"
	outESM        = "ypy.esm.js"
	outESMMin     = "ypy.esm.min.js"
	outMax        = "ypy.max.js"
	outMaxMin     = "ypy.max.min.js"
	outTypes      = "ypy.d.ts"
	outExtDir     = "ext"
	outEditorsDir = "editors"
	outSkillsDir  = "skills"
)

// maxExtensions is the list of extensions bundled into ypy.max, in order.
var maxExtensions = []string{
	"ypy-stream", "ypy-sse", "ypy-ws", "ypy-preload", "ypy-browser-indicator", "ypy-download",
	"ypy-pending", "ypy-targets", "ypy-live", "ypy-history-cache", "ypy-upsert",
	"ypy-alpine-compat", "ypy-retry", "ypy-lock", "ypy-signals", "ypy-layers",
	"ypy-nav", "ypy-progress", "ypy-persist", "ypy-lazy", "ypy-cache", "ypy-optimistic", "ypy-validate", "ypy-upload", "ypy-csrf", "ypy-poll", "ypy-list", "ypy-telemetry",
}

// maxPreamble is written between the core and the extensions of the bundle.
const (
	maxPreamble = "\nypy.version += \"-max\";\nypy.config.historyCache ??= { disable: true };\n"
	esmEpilogue = "\nif (typeof window !== \"undefined\") window.ypy = ypy;\nexport default ypy;\n"
)

// Size budgets, in bytes of min+gzip (1 kB = 1024 B).
const (
	coreBudget = 18 * 1024
	extBudget  = 6 * 1024
)

// brotliQuality and brotliWindow mirror the settings of the previous
// pipeline (maximum quality, 4 MB window).
const (
	brotliQuality = 11
	brotliWindow  = 22
)
