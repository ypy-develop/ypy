// SPDX-License-Identifier: MIT

package bench

import (
	"fmt"
	"io"
	"math"
	"regexp"
	"strings"
)

// CompareOptions tune a comparison.
type CompareOptions struct {
	// Threshold is the difference in percent above which a metric counts as
	// worse (or better).
	Threshold float64
	// Only keeps the metrics whose id matches; nil keeps all.
	Only *regexp.Regexp
	// Terse leaves out the lists of metrics only one of the results has.
	Terse bool
}

// Comparison is the outcome of comparing two results.
type Comparison struct {
	Regressions int
	Faster      int
	Compared    int
}

func delta(from, to float64) float64 {
	if from == to {
		return 0
	}
	if from == 0 {
		return math.Inf(1)
	}
	return (to - from) / math.Abs(from) * 100
}

func pct(v float64) string {
	switch {
	case v == 0:
		return "0.0%"
	case math.IsInf(v, 0) || math.IsNaN(v):
		return "new"
	case v > 0:
		return "+" + toFixed(v, 1) + "%"
	}
	return toFixed(v, 1) + "%"
}

// Compare prints, for every metric both results have, the median of each, the
// difference in percent and a flag. A is the reference, B the build under
// review. Every metric is "lower is better" unless the result says otherwise:
//
//	REGRESSION  B is more than the threshold worse than A
//	faster      B is more than the threshold better than A
//	(blank)     inside the threshold
//
// A trailing "~" means the noise between the rounds of either run (the
// interquartile range of the round medians, stored in the result) is at least
// as large as the difference: the flag is not trustworthy, run again with more
// rounds. The p95 difference is shown too, since a median can hide a worse tail.
func Compare(w io.Writer, a, b *Result, o CompareOptions) Comparison {
	rows := [][]string{{"metric", "unit", "A " + a.SHA, "B " + b.SHA, "median", "p95", "flag"}}
	var c Comparison
	for _, id := range a.Metrics.Keys() {
		ma, _ := a.Metrics.Get(id)
		mb, ok := b.Metrics.Get(id)
		if !ok || (o.Only != nil && !o.Only.MatchString(id)) {
			continue
		}
		dm := delta(ma.Median, mb.Median)
		dp := delta(ma.P95, mb.P95)
		worse := dm
		if !ma.Lower() {
			worse = -dm
		}
		noisy := math.Max(ma.NoisePct, mb.NoisePct) >= math.Abs(dm) && !math.IsInf(dm, 0) && !math.IsNaN(dm)
		flag := ""
		switch {
		case worse > o.Threshold:
			flag = "REGRESSION"
			c.Regressions++
		case worse < -o.Threshold:
			flag = "faster"
			c.Faster++
		}
		if flag != "" && noisy {
			flag += " ~"
		}
		c.Compared++
		rows = append(rows, []string{id, ma.Unit, formatNum(ma.Median), formatNum(mb.Median), pct(dm), pct(dp), flag})
	}
	describe := func(label string, r *Result) {
		fmt.Fprintf(w, "%s: %s @ %s (%s, %s)\n", label, r.Build, r.SHA, r.Date, r.Environment.Chrome)
	}
	describe("A", a)
	describe("B", b)
	fmt.Fprintf(w, "threshold %s%%, rounds %d vs %d\n\n", trimFloat(o.Threshold), a.Config.Rounds, b.Config.Rounds)
	fmt.Fprintln(w, table(rows, "llrrrrl"))
	fmt.Fprintf(w, "\n%d regression(s), %d faster, %d compared\n", c.Regressions, c.Faster, c.Compared)
	if o.Terse {
		return c
	}
	if only := missing(a, b); len(only) > 0 {
		fmt.Fprintf(w, "only in A: %s\n", strings.Join(only, ", "))
	}
	if only := missing(b, a); len(only) > 0 {
		fmt.Fprintf(w, "only in B: %s\n", strings.Join(only, ", "))
	}
	return c
}

// missing lists the metrics of a that b does not have.
func missing(a, b *Result) []string {
	var out []string
	for _, id := range a.Metrics.Keys() {
		if _, ok := b.Metrics.Get(id); !ok {
			out = append(out, id)
		}
	}
	return out
}

func trimFloat(v float64) string {
	s := toFixed(v, 6)
	s = strings.TrimRight(s, "0")
	return strings.TrimSuffix(s, ".")
}

// Show prints a stored result as a table; md makes it a Markdown table.
func Show(w io.Writer, r *Result, md bool) {
	rows := [][]string{{"metric", "unit", "median", "p95", "min", "noise %"}}
	for _, id := range r.Metrics.Keys() {
		m, _ := r.Metrics.Get(id)
		rows = append(rows, []string{id, m.Unit, formatNum(m.Median), formatNum(m.P95), formatNum(m.Min), noiseText(m)})
	}
	fmt.Fprintf(w, "build %s  sha %s  %s  %s  %s  rounds %d\n\n", r.Build, r.SHA, r.Date, r.Environment.Chrome, r.Environment.CPU, r.Config.Rounds)
	if md {
		line := func(row []string) string { return "| " + strings.Join(row, " | ") + " |" }
		fmt.Fprintln(w, line(rows[0]))
		sep := make([]string, len(rows[0]))
		for i := range sep {
			sep[i] = "---:"
			if i < 2 {
				sep[i] = "---"
			}
		}
		fmt.Fprintln(w, line(sep))
		for _, row := range rows[1:] {
			fmt.Fprintln(w, line(row))
		}
	} else {
		fmt.Fprintln(w, table(rows, "ll"))
	}
	for _, name := range r.Notes.Keys() {
		note, _ := r.Notes.Get(name)
		fmt.Fprintf(w, "\nnote %s: %s\n", name, note)
	}
}
