// SPDX-License-Identifier: MIT

package check

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ypy-develop/ypy/internal/cli"
)

const helpText = `ypy check: find legacy uses that break or change when moving to YPY

Usage:
  ypy check [path ...] [options]        (default path: the current directory)
  ypy check --gen-guide --guide FILE [--check]   regenerate the rule tables of the upgrade guide page

Options:
  --line v1|v2|v4|auto     generation of the legacy markup, a hint for the findings (default: auto, from the evidence)
  --json                   print one JSON document (schema 1) instead of text
  --min-severity LEVEL     hide findings below aviso|muda|quebra (default: aviso)
  --min-confidence LEVEL   hide findings below medium|high (default: medium, which shows both)
  --fail-on LEVEL          exit 1 when a finding reaches quebra|muda|aviso, or never (default: quebra)
  --id NAME                the identifier of the legacy markup, when the code does not reveal it
                           (repeatable, comma separated)
  --prefix P               the attribute prefix of the legacy markup, when the project does not
                           reveal it (for example acme, as in acme-get); also the header prefix
  --header-prefix P        the header prefix, when it differs from the attribute prefix
  --min-evidence N         distinct names that make a prefix learned from the code (default 2)
  --ignore RULE            skip a rule id (repeatable, comma separated)
  --only RULE              keep only these rule ids (repeatable, comma separated)
  --ext .a,.b              scan more file extensions as templates (repeatable)
  --list-rules             print the rule table and exit (honors --line and --json)
  --gen-guide              rewrite the rule tables of the guide page (needs --guide)
  --guide FILE             the guide page to rewrite: the page of the website repository (content/ypy/guides/upgrade-check.md)
  --check                  with --gen-guide: write nothing; exit 1 when the guide is out of date
  --no-color               plain text output
  -v, --version            print the rules version
  -h, --help               this help

Severities:
  quebra   stops working after the move to YPY
  muda     keeps working but behaves differently from the native YPY; review it before the move
  aviso    works; the spelling is legacy and ` + "`ypy migrate`" + ` converts it

Confidence:
  high     the identifier of the legacy markup is evidenced in the project (or given with --id),
           or the construct is not ambiguous (attributes, headers, structure)
  medium   the identifier rests on two weak signs, or an ambiguous event name is written
           in event-handling code of a project that uses prefixed attributes
`

// Command is the "check" subcommand.
func Command() cli.Command {
	return cli.Command{Name: "check", Summary: "find legacy uses that break or change when moving to YPY", Run: run}
}

type cliOpts struct {
	paths                                     []string
	line, minSeverity, minConfidence, failOn  string
	ids, ignore, only, ext                    []string
	prefix, headerPrefix                      []string
	minEvidence                               int
	guide                                     string
	json, listRules, genGuide, check, noColor bool
	version, help                             bool
}

func run(_ context.Context, args []string, io cli.IO) int {
	var o cliOpts
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	fs.SetOutput(io.Err)
	fs.Usage = func() {}
	fs.StringVar(&o.line, "line", "auto", "")
	fs.StringVar(&o.minSeverity, "min-severity", "aviso", "")
	fs.StringVar(&o.minConfidence, "min-confidence", "medium", "")
	fs.StringVar(&o.failOn, "fail-on", "quebra", "")
	fs.StringVar(&o.guide, "guide", "", "")
	fs.Var(cli.ListValue{Items: &o.ids}, "id", "")
	fs.Var(cli.ListValue{Items: &o.ignore}, "ignore", "")
	fs.Var(cli.ListValue{Items: &o.only}, "only", "")
	fs.Var(cli.ListValue{Items: &o.ext}, "ext", "")
	fs.Var(cli.ListValue{Items: &o.prefix}, "prefix", "")
	fs.Var(cli.ListValue{Items: &o.headerPrefix}, "header-prefix", "")
	fs.IntVar(&o.minEvidence, "min-evidence", 0, "")
	fs.BoolVar(&o.json, "json", false, "")
	fs.BoolVar(&o.listRules, "list-rules", false, "")
	fs.BoolVar(&o.genGuide, "gen-guide", false, "")
	fs.BoolVar(&o.check, "check", false, "")
	fs.BoolVar(&o.noColor, "no-color", false, "")
	fs.BoolVar(&o.version, "v", false, "")
	fs.BoolVar(&o.version, "version", false, "")
	fs.BoolVar(&o.help, "h", false, "")
	fs.BoolVar(&o.help, "help", false, "")
	paths, err := cli.ParseInterspersed(fs, args)
	usage := func(msg string) int {
		fmt.Fprintf(io.Err, "ypy check: %s\nTry --help.\n", msg)
		return cli.ExitUsage
	}
	if err != nil {
		return usage(flagMessage(err))
	}
	o.paths = paths
	if o.help {
		fmt.Fprint(io.Out, helpText)
		return cli.ExitOK
	}
	if !contains(append(append([]string(nil), Lines...), "auto"), o.line) {
		return usage("--line must be one of v1, v2, v4, auto")
	}
	if msg := checkPrefixFlags(o.prefix, o.headerPrefix); msg != "" {
		return usage(msg)
	}
	if severityRank(o.minSeverity) < 0 {
		return usage("--min-severity must be one of " + strings.Join(Severities, ", "))
	}
	if o.minConfidence != ConfMedium && o.minConfidence != ConfHigh {
		return usage("--min-confidence must be one of medium, high")
	}
	if o.failOn != "never" && severityRank(o.failOn) < 0 {
		return usage("--fail-on must be one of " + strings.Join(Severities, ", ") + ", never")
	}
	rs, err := Load()
	if err != nil {
		fmt.Fprintf(io.Err, "ypy check: %v\n", err)
		return cli.ExitInternal
	}
	dir := io.Dir
	if dir == "" {
		dir, _ = os.Getwd()
	}
	if o.version {
		fmt.Fprintf(io.Out, "ypy-check rules %s\n", rs.Meta.Version)
		return cli.ExitOK
	}
	if o.check && !o.genGuide {
		return usage("--check needs --gen-guide")
	}
	if o.genGuide {
		if o.guide == "" {
			return usage("--gen-guide needs --guide FILE")
		}
		path := o.guide
		if !filepath.IsAbs(path) {
			path = filepath.Join(dir, path)
		}
		ok, err := GenGuide(path, rs, o.check)
		switch {
		case err != nil:
			fmt.Fprintf(io.Err, "ypy check: %v\n", err)
			return cli.ExitUsage
		case o.check && !ok:
			fmt.Fprintf(io.Err, "%s is out of date: run ypy check --gen-guide --guide %s\n", o.guide, o.guide)
			return cli.ExitFailure
		case o.check:
			fmt.Fprintln(io.Out, "guide is up to date")
		case ok:
			fmt.Fprintf(io.Out, "guide is up to date (%d rules)\n", len(rs.Rules))
		default:
			fmt.Fprintf(io.Out, "guide updated (%d rules)\n", len(rs.Rules))
		}
		return cli.ExitOK
	}
	if o.listRules {
		fmt.Fprint(io.Out, RenderRules(rs, o.line, o.json))
		return cli.ExitOK
	}
	for _, id := range append(append([]string(nil), o.ignore...), o.only...) {
		if _, ok := rs.Rule(id); !ok {
			fmt.Fprintf(io.Err, "ypy check: unknown rule %s\n", id)
			return cli.ExitUsage
		}
	}
	extra := make([]string, len(o.ext))
	for i, e := range o.ext {
		if !strings.HasPrefix(e, ".") {
			e = "." + e
		}
		extra[i] = strings.ToLower(e)
	}
	if len(o.paths) == 0 {
		o.paths = []string{"."}
	}
	for i, p := range o.paths {
		if !filepath.IsAbs(p) {
			o.paths[i] = filepath.Join(dir, p)
		}
	}
	report, err := Scan(o.paths, Options{
		Rules: rs, Line: o.line, MinSeverity: o.minSeverity, MinConfidence: o.minConfidence,
		Ignore: o.ignore, Only: o.only, ExtraExt: extra, IDs: o.ids, Cwd: dir,
		AttrPrefixes: o.prefix, HeaderPrefixes: o.headerPrefix, MinEvidence: o.minEvidence,
	})
	if err != nil {
		fmt.Fprintf(io.Err, "ypy check: %v\n", err)
		return cli.ExitUsage
	}
	if report.Scanned == 0 && len(report.Warnings) > 0 {
		for _, w := range report.Warnings {
			fmt.Fprintf(io.Err, "ypy check: %s\n", w)
		}
		return cli.ExitUsage
	}
	if o.json {
		fmt.Fprint(io.Out, RenderJSON(report))
	} else {
		color := io.IsTTY && io.Env != nil && io.Env("NO_COLOR") == ""
		if o.noColor {
			color = false
		}
		fmt.Fprint(io.Out, RenderText(report, color))
	}
	if o.failOn == "never" {
		return cli.ExitOK
	}
	rank := severityRank(o.failOn)
	for _, f := range report.Findings {
		if severityRank(f.Severity) >= rank {
			return cli.ExitFailure
		}
	}
	return cli.ExitOK
}

// flagMessage words a flag parsing error the way the other tools of the family do.
func flagMessage(err error) string {
	msg := err.Error()
	if rest, ok := strings.CutPrefix(msg, "flag provided but not defined: "); ok {
		return "unknown option " + dashed(rest)
	}
	if rest, ok := strings.CutPrefix(msg, "flag needs an argument: "); ok {
		return dashed(rest) + " needs a value"
	}
	return msg
}

func dashed(flagName string) string {
	n := strings.TrimLeft(flagName, "-")
	if len(n) == 1 {
		return "-" + n
	}
	return "--" + n
}

// checkPrefixFlags validates --prefix and --header-prefix; it returns the
// usage error, or "".
func checkPrefixFlags(prefixes, headers []string) string {
	for _, p := range prefixes {
		if !validPrefix(normalizePrefix(p)) {
			return "--prefix must be a short lower case word such as acme (not data or ypy)"
		}
	}
	for _, p := range headers {
		if !validPrefix(normalizePrefix(p)) {
			return "--header-prefix must be a short word such as acme or ACME (not ypy)"
		}
	}
	return ""
}
