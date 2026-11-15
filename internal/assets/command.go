// SPDX-License-Identifier: MIT

package assets

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ypy-develop/ypy/internal/cli"
)

const helpText = `ypy gen assets: extract the CSS and the scripts that sit next to a template

Usage:
  ypy gen assets <dir> --out <dir> [options]

Options:
  --out DIR        where the hashed files and the manifest go (required)
  --manifest FILE  the manifest file (default: <out>/manifest.json); it has to be in
                   the --out directory or above it
  --strip-out DIR  also write a copy of every template with the marked blocks removed
  --group NAME     package (default): one stylesheet and one script per directory;
                   template: one pair per template file
  --check          write nothing; exit 1 when a file is missing, differs or is stale
  -h, --help       this help

What it reads, in <dir> and below (a directory that starts with "." and
node_modules and vendor are skipped):

  <style ypy-asset> ... </style>     in .html, .gohtml, .templ and .kyse.go files
  <script ypy-asset> ... </script>   the same
  name.ypy.css, name.ypy.js          next to name.html (or .gohtml, .templ, .kyse.go)

What it writes in --out:

  <name>.<hash>.css and <name>.<hash>.js   the hash is the first 10 hex digits of the
                                           SHA-256 of the content; <name> comes from the
                                           directory (or the template) it was made from
  manifest.json                            {"<origin>": {"css": "...", "js": "..."}}

The origin is the directory relative to <dir> ("." for <dir> itself) with --group
package, and the template path with --group template. The paths in the manifest are
relative to the directory of the manifest. The same input gives the same bytes.

Each script is wrapped in its own function scope, so two templates can declare the
same name; to publish a global, assign to window. Neither file is minified.

The templates keep their blocks unless --strip-out is given. A page served with the
blocks still in it has inline <style> and <script> and breaks a strict CSP, so serve
the copies in --strip-out (embed them) or have the server drop the blocks.
`

// Command is the "assets" subcommand.
func Command() cli.Command {
	return cli.Command{Name: "assets", Summary: "extract the CSS and scripts next to templates into hashed files", Run: run}
}

// Under returns parent with the subcommand "assets" added: "ypy gen assets" runs
// this tool and every other argument goes to parent unchanged.
func Under(parent cli.Command) cli.Command {
	sub := Command()
	run := parent.Run
	parent.Run = func(ctx context.Context, args []string, io cli.IO) int {
		if len(args) > 0 && args[0] == sub.Name {
			return sub.Run(ctx, args[1:], io)
		}
		return run(ctx, args, io)
	}
	parent.Summary += " (gen assets: hashed assets from templates)"
	return parent
}

func run(_ context.Context, args []string, io cli.IO) int {
	fs := flag.NewFlagSet("gen assets", flag.ContinueOnError)
	fs.SetOutput(io.Err)
	fs.Usage = func() {}
	var (
		out, manifest, stripOut, group string
		check, help                    bool
	)
	fs.StringVar(&out, "out", "", "")
	fs.StringVar(&manifest, "manifest", "", "")
	fs.StringVar(&stripOut, "strip-out", "", "")
	fs.StringVar(&group, "group", string(ByPackage), "")
	fs.BoolVar(&check, "check", false, "")
	fs.BoolVar(&help, "h", false, "")
	fs.BoolVar(&help, "help", false, "")
	rest, err := cli.ParseInterspersed(fs, args)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy gen assets: %v\nTry --help.\n", err)
		return cli.ExitUsage
	}
	if help {
		fmt.Fprint(io.Out, helpText)
		return cli.ExitOK
	}
	if len(rest) != 1 || out == "" {
		fmt.Fprint(io.Err, "ypy gen assets: give one directory and --out\nTry --help.\n")
		return cli.ExitUsage
	}
	base := io.Dir
	if base == "" {
		base, _ = os.Getwd()
	}
	abs := func(p string) string {
		if p == "" {
			return ""
		}
		if filepath.IsAbs(p) {
			return filepath.Clean(p)
		}
		return filepath.Join(base, p)
	}
	o := Options{Dir: abs(rest[0]), Out: abs(out), Manifest: abs(manifest), StripOut: abs(stripOut), Group: Group(group)}
	if st, err := os.Stat(o.Dir); err != nil || !st.IsDir() {
		fmt.Fprintf(io.Err, "ypy gen assets: %s is not a directory\n", rest[0])
		return cli.ExitUsage
	}
	if o.Group != ByPackage && o.Group != ByTemplate {
		fmt.Fprintf(io.Err, "ypy gen assets: --group is %q or %q\n", ByPackage, ByTemplate)
		return cli.ExitUsage
	}

	res, err := Plan(o)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy gen assets: %s\n", strings.ReplaceAll(err.Error(), "\n", "\nypy gen assets: "))
		return cli.ExitFailure
	}
	show := func(p string) string {
		if r, err := filepath.Rel(base, p); err == nil && !strings.HasPrefix(r, "..") {
			return r
		}
		return p
	}
	stale := staleFiles(res)

	paths := make([]string, 0, len(res.Files))
	for p := range res.Files {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	if check {
		code := cli.ExitOK
		for _, p := range paths {
			have, err := os.ReadFile(p)
			if err != nil || !bytes.Equal(have, res.Files[p]) {
				fmt.Fprintf(io.Err, "ypy gen assets: %s is out of date; run ypy gen assets\n", show(p))
				code = cli.ExitFailure
			}
		}
		for _, p := range stale {
			fmt.Fprintf(io.Err, "ypy gen assets: %s is stale; run ypy gen assets\n", show(p))
			code = cli.ExitFailure
		}
		if code == cli.ExitOK {
			fmt.Fprintf(io.Out, "assets are up to date (%s)\n", res.summary())
		}
		return code
	}

	written := 0
	for _, p := range paths {
		if have, err := os.ReadFile(p); err == nil && bytes.Equal(have, res.Files[p]) {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			fmt.Fprintf(io.Err, "ypy gen assets: %v\n", err)
			return cli.ExitFailure
		}
		if err := os.WriteFile(p, res.Files[p], 0o644); err != nil {
			fmt.Fprintf(io.Err, "ypy gen assets: %v\n", err)
			return cli.ExitFailure
		}
		written++
	}
	for _, p := range stale {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			fmt.Fprintf(io.Err, "ypy gen assets: %v\n", err)
			return cli.ExitFailure
		}
	}
	fmt.Fprintf(io.Out, "wrote %d of %d files, removed %d stale (%s)\n", written, len(res.Files), len(stale), res.summary())
	return cli.ExitOK
}

func (o *Output) summary() string {
	return fmt.Sprintf("%d stylesheets, %d scripts, %d templates scanned", o.CSS, o.JS, o.Templates)
}

// staleFiles lists the files the previous manifest named that this run no
// longer produces. Only those are ever removed: nothing else in --out is ours.
func staleFiles(res *Output) []string {
	raw, err := os.ReadFile(res.ManifestPath)
	if err != nil {
		return nil
	}
	var old map[string]Entry
	if json.Unmarshal(raw, &old) != nil {
		return nil
	}
	dir := filepath.Dir(res.ManifestPath)
	seen := map[string]bool{}
	var stale []string
	for _, e := range old {
		for _, name := range []string{e.CSS, e.JS} {
			if name == "" || strings.Contains(name, "..") {
				continue
			}
			p := filepath.Join(dir, filepath.FromSlash(name))
			if _, ok := res.Files[p]; !ok && !seen[p] {
				seen[p] = true
				if _, err := os.Stat(p); err == nil {
					stale = append(stale, p)
				}
			}
		}
	}
	sort.Strings(stale)
	return stale
}
