// SPDX-License-Identifier: MIT

package gen

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/ypy-develop/ypy/internal/cli"
)

const helpText = `ypy gen: generate the editor data from the table of names

Usage:
  ypy gen [options]

Options:
  --root DIR       repository root, the directory that holds src/ (default: the current directory)
  --check          write nothing; exit 1 when a generated file differs from the table, when
                   src/ypy.d.ts disagrees with it, or when the sources use a name it lacks
  -h, --help       this help

The table is src/attributes.json (the core) plus one fragment per extension in
src/attributes.d/<extension>.json. From it ypy gen writes:

  editors/vscode/ypy.html-data.json            VS Code HTML Custom Data
  src/editors/jetbrains/ypy.web-types.json     JetBrains web-types
  src/editors/schema/ypy.config.schema.json    JSON Schema of the ypy-config meta tag

It also checks that the events and the config keys of src/ypy.d.ts are the ones of the
table, and that src/ypy.js and src/ext/*.js do not use a ypy- name the table does not know.
See https://ypy.dev/docs/reference/editors.
`

// Command is the "gen" subcommand.
func Command() cli.Command {
	return cli.Command{Name: "gen", Summary: "generate editor data and the config schema from the table of names", Run: run}
}

func run(_ context.Context, args []string, io cli.IO) int {
	fs := flag.NewFlagSet("gen", flag.ContinueOnError)
	fs.SetOutput(io.Err)
	fs.Usage = func() {}
	var (
		root        string
		check, help bool
	)
	fs.StringVar(&root, "root", "", "")
	fs.BoolVar(&check, "check", false, "")
	fs.BoolVar(&help, "h", false, "")
	fs.BoolVar(&help, "help", false, "")
	rest, err := cli.ParseInterspersed(fs, args)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy gen: %v\nTry --help.\n", err)
		return cli.ExitUsage
	}
	if help {
		fmt.Fprint(io.Out, helpText)
		return cli.ExitOK
	}
	if len(rest) > 0 {
		fmt.Fprintf(io.Err, "ypy gen: unexpected argument %q\nTry --help.\n", rest[0])
		return cli.ExitUsage
	}
	base := io.Dir
	if base == "" {
		base, _ = os.Getwd()
	}
	if root == "" {
		root = "."
	}
	if !filepath.IsAbs(root) {
		root = filepath.Join(base, root)
	}

	table, err := Load(root)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy gen: %v\n", err)
		return cli.ExitFailure
	}
	out, err := Render(table)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy gen: %v\n", err)
		return cli.ExitFailure
	}
	code := cli.ExitOK
	paths := make([]string, 0, len(out))
	for p := range out {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	if check {
		for _, p := range paths {
			have, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(p)))
			if err != nil || string(have) != string(out[p]) {
				fmt.Fprintf(io.Err, "ypy gen: %s is out of date; run ypy gen\n", p)
				code = cli.ExitFailure
			}
		}
	} else {
		for _, p := range paths {
			full := filepath.Join(root, filepath.FromSlash(p))
			if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
				fmt.Fprintf(io.Err, "ypy gen: %v\n", err)
				return cli.ExitFailure
			}
			if err := os.WriteFile(full, out[p], 0o644); err != nil {
				fmt.Fprintf(io.Err, "ypy gen: %v\n", err)
				return cli.ExitFailure
			}
		}
	}

	problems, err := CheckDTS(table, root)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy gen: %v\n", err)
		return cli.ExitFailure
	}
	scan, err := ScanSources(table, root)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy gen: %v\n", err)
		return cli.ExitFailure
	}
	problems = append(problems, scan.Problems...)
	for _, p := range problems {
		fmt.Fprintf(io.Err, "ypy gen: %s\n", p)
		code = cli.ExitFailure
	}
	for _, w := range scan.Warnings {
		fmt.Fprintf(io.Err, "ypy gen: warning: %s\n", w)
	}
	if code == cli.ExitOK {
		if check {
			fmt.Fprintf(io.Out, "editor data is up to date (%s)\n", table.Summary())
		} else {
			fmt.Fprintf(io.Out, "wrote %d files (%s)\n", len(out), table.Summary())
		}
	}
	return code
}

// Summary counts the entries of the table.
func (t *Table) Summary() string {
	return fmt.Sprintf("%d attributes, %d events, %d headers, %d config keys, %d extensions",
		len(t.Attributes), len(t.Events), len(t.Headers), len(t.Config), len(t.Extensions))
}
