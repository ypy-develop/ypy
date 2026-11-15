// SPDX-License-Identifier: MIT

package build

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"path"
	"strings"
)

// SizeRow is one measured file against its budget.
type SizeRow struct {
	File   string
	Min    int
	Gzip   int
	Budget int
	OK     bool
}

// Sizes measures the min+gzip size (level 9) of the budgeted files of out:
// the core (ypy.min.js, at most 18 kB) and every extension (ext/*.min.js, at
// most 6 kB each; 1 kB = 1024 B). The max bundle and the module
// build have no budget. Only files that are in out are measured.
func Sizes(out Output) []SizeRow {
	var rows []SizeRow
	add := func(name string, budget int) {
		b := out[name]
		g := gzipSize(b)
		rows = append(rows, SizeRow{File: name, Min: len(b), Gzip: g, Budget: budget, OK: g <= budget})
	}
	if _, ok := out[outCoreMin]; ok {
		add(outCoreMin, coreBudget)
	}
	for _, name := range out.Names() {
		if path.Dir(name) == outExtDir && strings.HasSuffix(name, ".min.js") {
			add(name, extBudget)
		}
	}
	return rows
}

func gzipSize(b []byte) int {
	var buf bytes.Buffer
	w, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	_, _ = w.Write(b)
	_ = w.Close()
	return buf.Len()
}

// WriteSizes prints the table and the budgets, and reports whether every file
// is within its budget.
func WriteSizes(w io.Writer, rows []SizeRow) bool {
	ok := true
	heads := []string{"file", "min B", "gzip B", "gzip", "budget B", "used", "status"}
	body := make([][]string, 0, len(rows))
	for _, r := range rows {
		status := "ok"
		if !r.OK {
			status = "OVER"
			ok = false
		}
		body = append(body, []string{
			"dist/" + r.File,
			fmt.Sprint(r.Min), fmt.Sprint(r.Gzip), fmt.Sprintf("%.2f kB", float64(r.Gzip)/1024),
			fmt.Sprint(r.Budget), fmt.Sprintf("%d%%", int(float64(r.Gzip)/float64(r.Budget)*100+0.5)), status,
		})
	}
	widths := make([]int, len(heads))
	for i, h := range heads {
		widths[i] = len(h)
	}
	for _, row := range body {
		for i, c := range row {
			widths[i] = max(widths[i], len(c))
		}
	}
	line := func(cells []string) {
		var b strings.Builder
		for i, c := range cells {
			pad := strings.Repeat(" ", widths[i]-len(c))
			if i == 0 || i == len(cells)-1 {
				b.WriteString(c + pad)
			} else {
				b.WriteString(pad + c)
			}
			if i < len(cells)-1 {
				b.WriteString("  ")
			}
		}
		fmt.Fprintln(w, strings.TrimRight(b.String(), " "))
	}
	fmt.Fprintln(w, "Size gate (min+gzip)")
	line(heads)
	seps := make([]string, len(heads))
	for i := range heads {
		seps[i] = strings.Repeat("-", widths[i])
	}
	line(seps)
	for _, row := range body {
		line(row)
	}
	fmt.Fprintf(w, "budgets: core %d B (18 kB), each extension %d B (6 kB)\n", coreBudget, extBudget)
	return ok
}
