// SPDX-License-Identifier: MIT

package bench

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/ypy-develop/ypy/internal/browsers"
)

// smokeFilter picks the scenarios that carry the deterministic metrics: the
// event count, focus preservation of the small morphs and the session.
const smokeFilter = `^(request\.events|morph\.(inner|outer)\.(10|100)$|session\.500)$`

// deterministic matches the metrics that do not depend on the machine: how many
// events a request dispatches, how many times a morph lost the focus, the nodes
// and listeners a session leaves behind and the size of the build. They are
// compared with threshold 0.
var deterministic = regexp.MustCompile(`^(request\.events\..+|.+\.preserve_failures|session\.(nodes|listeners)_retained|size\..+)$`)

// LatestReference finds the reference result in dir: the most recent full run
// (not a quick or filtered one, not a profile). Results sort by date, then by
// the time they record, then by modification time.
func LatestReference(dir string) (*Result, string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, "", err
	}
	type found struct {
		r    *Result
		path string
		mod  time.Time
	}
	var list []found
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, "profile-") {
			continue
		}
		path := filepath.Join(dir, name)
		r, err := ReadResult(path)
		if err != nil || r.Config.Quick || r.Config.Filter != nil {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		list = append(list, found{r, path, info.ModTime()})
	}
	if len(list) == 0 {
		return nil, "", fmt.Errorf("no full benchmark result in %s", dir)
	}
	sort.SliceStable(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if a.r.Date != b.r.Date {
			return a.r.Date > b.r.Date
		}
		if a.r.Time != b.r.Time {
			return a.r.Time > b.r.Time
		}
		return a.mod.After(b.mod)
	})
	return list[0].r, list[0].path, nil
}

// Smoke is the "bench-smoke" gate: a quick run of the scenarios with
// deterministic metrics against the most recent result in bench/results, with
// threshold 0. skipped says why the gate could not run (no Chrome, no
// reference); err is a regression or a failed run.
func Smoke(ctx context.Context, o RunOptions) (skipped string, err error) {
	resultsDir := filepath.Join(o.Root, "bench", "results")
	ref, refPath, err := LatestReference(resultsDir)
	if err != nil {
		return err.Error() + " (record one with ypy bench)", nil
	}
	tmp, err := os.MkdirTemp("", "ypy-bench-smoke-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)
	o.Quick, o.Filter, o.Out, o.Label, o.List = true, smokeFilter, tmp, "smoke", false
	if o.Out2 == nil {
		o.Out2 = discard()
	}
	// the run prints its own table; the gate prints only the comparison
	run := o
	run.Out2 = discard()
	out, err := Run(ctx, run)
	var unavailable *browsers.Unavailable
	if errors.As(err, &unavailable) {
		return unavailable.Error(), nil
	}
	if err != nil {
		return "", err
	}
	if out.Failed {
		return "", errors.New("a scenario failed")
	}
	fmt.Fprintf(o.Out2, "reference: %s (%s @ %s)\n", displayPath(o.Root, refPath), ref.Date, ref.SHA)
	c := Compare(o.Out2, ref, out.Result, CompareOptions{Threshold: 0, Only: deterministic, Terse: true})
	if c.Compared == 0 {
		return "", fmt.Errorf("the reference %s has none of the deterministic metrics", displayPath(o.Root, refPath))
	}
	if c.Regressions > 0 {
		return "", fmt.Errorf("%d deterministic metric(s) got worse than %s; if that is intended, record a new reference with ypy bench", c.Regressions, displayPath(o.Root, refPath))
	}
	return "", nil
}
