// SPDX-License-Identifier: MIT

package check

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ypy-develop/ypy/internal/cli"
)

const migrateHelp = `ypy migrate: convert a project written before YPY to YPY

Usage:
  ypy migrate [options] <dir> [dir ...]      (default: the current directory)

Without --write it reports what would change, with a unified diff, and writes
nothing. With --write it edits the files in place; running it twice changes
nothing the second time. node_modules, vendor, dist, build, .git and minified or
binary files are never touched.

What it converts, only in a context it recognizes (an attribute inside a tag, a
string, a selector, a template expression; never running text):
  attributes        <prefix>-name and data-<prefix>-name  ->  ypy-name, data-ypy-name
  tags              <prefix>-partial                      ->  <ypy-partial>
  headers           <PREFIX>-Name, Vary, HTTP_<PREFIX>_NAME ->  YPY-Name (server code too)
  events            <id>:afterSwap, <id>:load             ->  ypy:after:swap, ypy:after:process (the name YPY emits;
                    no equivalent, or detail.elt: left as it is and listed)
  global object     <id>.method                           ->  ypy.method
  state classes     <id>-request, <id>-indicator, ...     ->  ypy-request, ypy-indicator, ...
  extensions        <prefix>-sse.js, sse-connect, ws-send ->  ypy-sse.js, ypy-sse:connect, ypy-ws:send
  identifiers       <P>Target, <p>On, <p>_request         ->  YpyTarget, ypyOn, ypy_request
                    Is<P>, Has<P> (Go files only)         ->  IsYPY, HasYPY
  extension names   extensions:"sse,ws" (config setting)  ->  extensions:"ypy-sse,ypy-ws"
  script tag        <id>.min.js                           ->  ypy.min.js
The prefixes and the identifier of the legacy markup are learned from the project
(see "ypy check --help"); the files of the library itself are skipped. A string of server
code (Go, Python...) is converted only where an attribute, a selector or a class belongs.

Options:
  --write                  apply the changes (default: report only)
  --prefix P               the attribute prefix of the legacy markup, when the project does not
                           reveal it (acme, as in acme-get); also the header prefix
  --header-prefix P        the header prefix, when it differs from the attribute prefix
  --id NAME                the identifier of the legacy markup (global, events, classes), when
                           the code does not reveal it (repeatable, comma separated)
  --min-evidence N         distinct names that make a prefix learned from the code (default 2)
  --comments               also convert the recognized names inside comments
  --no-identifiers         leave identifiers (<P>Target, <p>_request) alone
  --script-src URL         replace the URL of an external script tag of the legacy markup
                           (without it such tags are left alone and listed)
  --ext .a,.b              convert more file extensions as templates (repeatable); .md and .json are read by default
  --json                   print one JSON document (schema 1) instead of text
  --no-diff                text output without the diff
  -v, --version            print the rules version
  -h, --help               this help

Exit status: 0 when it ran, 2 on a usage error or an unreadable path.
`

// MigrateCommand is the "migrate" subcommand.
func MigrateCommand() cli.Command {
	return cli.Command{Name: "migrate", Summary: "convert a project written before YPY to YPY", Run: runMigrate}
}

func runMigrate(_ context.Context, args []string, io cli.IO) int {
	var (
		ids, ext, prefix, headerPrefix []string
		minEvidence                    int
		scriptSrc                      string
		write, comments, noIdent       bool
		asJSON, noDiff, version, help  bool
	)
	fs := flag.NewFlagSet("migrate", flag.ContinueOnError)
	fs.SetOutput(io.Err)
	fs.Usage = func() {}
	fs.StringVar(&scriptSrc, "script-src", "", "")
	fs.Var(cli.ListValue{Items: &ids}, "id", "")
	fs.Var(cli.ListValue{Items: &ext}, "ext", "")
	fs.Var(cli.ListValue{Items: &prefix}, "prefix", "")
	fs.Var(cli.ListValue{Items: &headerPrefix}, "header-prefix", "")
	fs.IntVar(&minEvidence, "min-evidence", 0, "")
	fs.BoolVar(&write, "write", false, "")
	fs.BoolVar(&comments, "comments", false, "")
	fs.BoolVar(&noIdent, "no-identifiers", false, "")
	fs.BoolVar(&asJSON, "json", false, "")
	fs.BoolVar(&noDiff, "no-diff", false, "")
	fs.BoolVar(&version, "v", false, "")
	fs.BoolVar(&version, "version", false, "")
	fs.BoolVar(&help, "h", false, "")
	fs.BoolVar(&help, "help", false, "")
	paths, err := cli.ParseInterspersed(fs, args)
	usage := func(msg string) int {
		fmt.Fprintf(io.Err, "ypy migrate: %s\nTry --help.\n", msg)
		return cli.ExitUsage
	}
	if err != nil {
		return usage(flagMessage(err))
	}
	if help {
		fmt.Fprint(io.Out, migrateHelp)
		return cli.ExitOK
	}
	if msg := checkPrefixFlags(prefix, headerPrefix); msg != "" {
		return usage(msg)
	}
	rs, err := Load()
	if err != nil {
		fmt.Fprintf(io.Err, "ypy migrate: %v\n", err)
		return cli.ExitInternal
	}
	if version {
		fmt.Fprintf(io.Out, "ypy-migrate rules %s\n", rs.Meta.Version)
		return cli.ExitOK
	}
	dir := io.Dir
	if dir == "" {
		dir, _ = os.Getwd()
	}
	extra := make([]string, len(ext))
	for i, e := range ext {
		if !strings.HasPrefix(e, ".") {
			e = "." + e
		}
		extra[i] = strings.ToLower(e)
	}
	if len(paths) == 0 {
		paths = []string{"."}
	}
	for i, p := range paths {
		if !filepath.IsAbs(p) {
			paths[i] = filepath.Join(dir, p)
		}
	}
	rep, err := Migrate(paths, MigrateOptions{
		Scan: Options{Rules: rs, IDs: ids, AttrPrefixes: prefix, HeaderPrefixes: headerPrefix,
			MinEvidence: minEvidence, ExtraExt: extra, Cwd: dir},
		Write: write, Comments: comments, NoIdentifiers: noIdent, ScriptSrc: scriptSrc,
	})
	if err != nil {
		fmt.Fprintf(io.Err, "ypy migrate: %v\n", err)
		return cli.ExitUsage
	}
	if rep.Scanned == 0 && len(rep.Warnings) > 0 {
		for _, w := range rep.Warnings {
			fmt.Fprintf(io.Err, "ypy migrate: %s\n", w)
		}
		return cli.ExitUsage
	}
	if asJSON {
		if write {
			for i := range rep.Files {
				rep.Files[i].Diff = ""
			}
		}
		fmt.Fprint(io.Out, marshal(rep))
		return cli.ExitOK
	}
	fmt.Fprint(io.Out, RenderMigrate(rep, !noDiff && !write))
	return cli.ExitOK
}

// RenderMigrate prints the migration report for people.
func RenderMigrate(r *MigrateReport, withDiff bool) string {
	var out []string
	if r.Mode == "dry-run" {
		out = append(out, "ypy migrate: dry run, nothing was written (use --write to apply)")
	} else {
		out = append(out, "ypy migrate: files written")
	}
	var learned []string
	if len(r.Legacy.AttributePrefixes) > 0 {
		learned = append(learned, "attribute prefix "+strings.Join(r.Legacy.AttributePrefixes, ", "))
	}
	if len(r.Legacy.HeaderPrefixes) > 0 {
		learned = append(learned, "header prefix "+strings.Join(r.Legacy.HeaderPrefixes, ", "))
	}
	if len(r.Legacy.Identifiers) > 0 {
		learned = append(learned, "identifier "+strings.Join(r.Legacy.Identifiers, ", "))
	}
	if len(learned) == 0 {
		learned = []string{"nothing of the legacy markup"}
	}
	out = append(out, "Learned: "+strings.Join(learned, "; ")+".", "")
	for _, f := range r.Files {
		if withDiff {
			out = append(out, strings.TrimRight(f.Diff, "\n"))
			continue
		}
		out = append(out, fmt.Sprintf("%s: %d replacement(s) (%s)", f.File, f.Replacements, kindList(f.ByKind)))
	}
	if len(r.Files) > 0 {
		out = append(out, "")
	}
	s := r.Summary
	verb := "would change"
	if r.Mode == "write" {
		verb = "changed"
	}
	out = append(out, fmt.Sprintf("%d of %d file(s) %s, %d replacement(s): %s.", s.Files, r.Scanned, verb, s.Replacements, kindList(s.ByKind)))
	if len(r.Unconverted) > 0 {
		files := map[string]bool{}
		for _, l := range r.Unconverted {
			files[l.File] = true
		}
		out = append(out, "", fmt.Sprintf("Left as it is (%s): %d place(s) in %d file(s).", reasonProse, len(r.Unconverted), len(files)))
		limit := len(r.Unconverted)
		if limit > 25 {
			limit = 25
		}
		for _, l := range r.Unconverted[:limit] {
			out = append(out, fmt.Sprintf("  %s:%d  %s  %s", l.File, l.Line, l.Kind, l.Text))
		}
		if limit < len(r.Unconverted) {
			out = append(out, fmt.Sprintf("  ... and %d more (--json lists them all; --comments converts the recognized names in comments)", len(r.Unconverted)-limit))
		}
	}
	if s.Mentions > 0 {
		out = append(out, fmt.Sprintf("%d line(s) still name the legacy markup in words; edit them by hand.", s.Mentions))
	}
	for _, sk := range r.Skipped {
		out = append(out, "skipped "+sk)
	}
	for _, w := range r.Warnings {
		out = append(out, "warning: "+w)
	}
	return strings.Join(out, "\n") + "\n"
}

func kindList(m map[string]int) string {
	var parts []string
	for _, k := range Kinds {
		if n := m[k]; n > 0 {
			parts = append(parts, fmt.Sprintf("%s %d", k, n))
		}
	}
	var rest []string
	for k := range m {
		if !contains(Kinds, k) {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	for _, k := range rest {
		parts = append(parts, fmt.Sprintf("%s %d", k, m[k]))
	}
	if len(parts) == 0 {
		return "none"
	}
	return strings.Join(parts, ", ")
}
