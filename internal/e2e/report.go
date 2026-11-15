// SPDX-License-Identifier: MIT

package e2e

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// report prints the matrix scenario x app per browser, the failures, and writes
// the markdown copy when asked. It returns the number of failed scenarios.
func report(out io.Writer, mdFile string, outcomes []Outcome) int {
	var md []string
	failedCount := 0
	var order []string
	for _, oc := range outcomes {
		if !contains(order, oc.Browser) {
			order = append(order, oc.Browser)
		}
	}
	for _, browser := range order {
		var cols []Outcome
		for _, app := range AppOrder {
			for _, oc := range outcomes {
				if oc.Browser == browser && oc.App == app {
					cols = append(cols, oc)
				}
			}
		}
		var scenarios []string
		for _, c := range cols {
			for _, r := range c.Results {
				if !contains(scenarios, r.Scenario) {
					scenarios = append(scenarios, r.Scenario)
				}
			}
		}
		nameW := 8
		for _, s := range scenarios {
			if len(s) > nameW {
				nameW = len(s)
			}
		}
		cell := func(c Outcome, s string) string {
			for _, r := range c.Results {
				if r.Scenario == s {
					if r.Pass {
						return "ok"
					}
					return "FAIL"
				}
			}
			return "-"
		}
		var heads []string
		for _, c := range cols {
			heads = append(heads, c.App)
		}
		fmt.Fprintf(out, "Browser: %s\n", browser)
		fmt.Fprintf(out, "%-*s  %s\n", nameW, "scenario", padAll(heads))
		for _, s := range scenarios {
			var cells []string
			for _, c := range cols {
				cells = append(cells, cell(c, s))
			}
			fmt.Fprintf(out, "%-*s  %s\n", nameW, s, padAll(cells))
		}
		var totals, versions []string
		for _, c := range cols {
			n := 0
			for _, r := range c.Results {
				if r.Pass {
					n++
				}
			}
			totals = append(totals, fmt.Sprintf("%d/%d", n, len(c.Results)))
			v := c.Version
			if v == "" {
				v = "?"
			}
			versions = append(versions, v)
		}
		fmt.Fprintf(out, "%-*s  %s\n", nameW, "passed", padAll(totals))
		fmt.Fprintf(out, "%-*s  %s\n\n", nameW, "ypy.version", padAll(versions))

		md = append(md, "### "+browser, "", "| scenario | "+strings.Join(heads, " | ")+" |", "|---|"+strings.Repeat("---|", len(heads)))
		for _, s := range scenarios {
			var cells []string
			for _, c := range cols {
				cells = append(cells, cell(c, s))
			}
			md = append(md, "| "+s+" | "+strings.Join(cells, " | ")+" |")
		}
		md = append(md, "| passed | "+strings.Join(totals, " | ")+" |", "")

		var failures []struct {
			App string
			Result
		}
		for _, c := range cols {
			for _, r := range c.Results {
				if !r.Pass {
					failures = append(failures, struct {
						App string
						Result
					}{c.App, r})
				}
			}
		}
		failedCount += len(failures)
		if len(failures) > 0 {
			fmt.Fprintln(out, "Failures")
			md = append(md, "Failures", "")
			for _, f := range failures {
				fmt.Fprintf(out, "  [%s] %s: %s\n", f.App, f.Scenario, f.Error)
				for i, l := range f.Console {
					if i == 3 {
						break
					}
					if len(l) > 200 {
						l = l[:200]
					}
					fmt.Fprintf(out, "      console> %s\n", l)
				}
				md = append(md, fmt.Sprintf("- `%s` `%s`: %s", f.App, f.Scenario, f.Error))
			}
			fmt.Fprintln(out)
			md = append(md, "")
		}
	}
	if mdFile != "" {
		_ = os.WriteFile(mdFile, []byte(strings.Join(md, "\n")+"\n"), 0o644)
	}
	fmt.Fprintf(out, "failures: %d\n", failedCount)
	return failedCount
}

func padAll(cells []string) string {
	parts := make([]string, len(cells))
	for i, c := range cells {
		parts[i] = fmt.Sprintf("%-16s", c)
	}
	return strings.Join(parts, " ")
}
