// SPDX-License-Identifier: MIT

package gates

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ypy-develop/ypy/internal/bench"
)

// gateBenchSmoke: a quick run of the benchmark scenarios whose metrics do not
// depend on the machine (events per request, focus preservation, nodes and
// listeners left by a session, size of the build), compared with the latest
// result in bench/results at threshold 0. Off by default; run it with
// "ypy ci bench-smoke". When a change makes one of them worse on purpose,
// record a new reference with "ypy bench".
func gateBenchSmoke(ctx context.Context, e *Env) Result {
	dir := e.IO.Dir
	if dir == "" {
		dir, _ = os.Getwd()
	}
	root := e.Root
	if !filepath.IsAbs(root) {
		root = filepath.Join(dir, root)
	}
	skipped, err := bench.Smoke(ctx, bench.RunOptions{
		Root: root, ChromePath: e.ChromePath, Out2: e.Out, Err: e.Err, IsTTY: false, Env: e.IO.Env,
	})
	if err != nil {
		return Result{Err: fmt.Errorf("bench-smoke: %w", err)}
	}
	return Result{Skipped: skipped}
}
