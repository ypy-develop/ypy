// SPDX-License-Identifier: MIT

package gates

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	spdxHeader  = regexp.MustCompile(`SPDX-License-Identifier:\s*MIT\b`)
	spdxSources = regexp.MustCompile(`^src/.*\.(js|mjs|ts|py)$`)
)

// gateSPDX: sources created by YPY (the framework in src/, the Go tools and the
// examples) carry SPDX-License-Identifier: MIT in their first lines.
func gateSPDX(ctx context.Context, e *Env) Result {
	files, err := trackedFiles(ctx, e.Root)
	if err != nil {
		return Result{Err: err}
	}
	checked := 0
	var missing []string
	for _, f := range files {
		goSource := strings.HasSuffix(f, ".go") && !strings.Contains(f, "/testdata/")
		if !goSource && !spdxSources.MatchString(f) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(e.Root, f))
		if err != nil {
			continue
		}
		checked++
		lines := strings.SplitN(string(b), "\n", 6)
		if len(lines) > 5 {
			lines = lines[:5]
		}
		if !spdxHeader.MatchString(strings.Join(lines, "\n")) {
			missing = append(missing, f)
		}
	}
	fmt.Fprintf(e.Out, "SPDX header (SPDX-License-Identifier: MIT in the first lines)\n  %d of %d files have it\n", checked-len(missing), checked)
	if len(missing) == 0 {
		return Result{}
	}
	for i, f := range missing {
		if i == 25 {
			fmt.Fprintf(e.Out, "  ... and %d more\n", len(missing)-25)
			break
		}
		fmt.Fprintf(e.Out, "  missing: %s\n", f)
	}
	return Result{Err: fmt.Errorf("%d source file(s) lack the SPDX MIT header", len(missing))}
}
