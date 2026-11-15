// SPDX-License-Identifier: MIT

package cli

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"strings"
	"testing"
)

func testApp() App {
	return App{Name: "tool", Version: "1.2.3", Commands: []Command{
		{Name: "zeta", Summary: "last", Run: func(_ context.Context, args []string, io IO) int {
			fmt.Fprintf(io.Out, "zeta %v", args)
			return 7
		}},
		{Name: "alpha", Summary: "first", Run: func(context.Context, []string, IO) int { return 0 }},
	}}
}

func run(args ...string) (int, string, string) {
	var out, errb bytes.Buffer
	code := testApp().Run(context.Background(), args, IO{Out: &out, Err: &errb})
	return code, out.String(), errb.String()
}

func TestDispatch(t *testing.T) {
	if code, out, _ := run("zeta", "a", "--b"); code != 7 || out != "zeta [a --b]" {
		t.Errorf("dispatch: %d %q", code, out)
	}
	if code, out, _ := run("--version"); code != ExitOK || out != "tool 1.2.3\n" {
		t.Errorf("version: %d %q", code, out)
	}
	code, out, _ := run("--help")
	if code != ExitOK || strings.Index(out, "alpha") > strings.Index(out, "zeta") || !strings.Contains(out, "first") {
		t.Errorf("help lists the commands sorted: %q", out)
	}
	if code, _, errs := run("nope"); code != ExitUsage || !strings.Contains(errs, `unknown command "nope"`) {
		t.Errorf("unknown: %d %q", code, errs)
	}
	if code, _, _ := run(); code != ExitUsage {
		t.Errorf("no command: %d", code)
	}
}

func TestParseInterspersed(t *testing.T) {
	var json bool
	var line string
	var ids []string
	fs := flag.NewFlagSet("x", flag.ContinueOnError)
	fs.SetOutput(&bytes.Buffer{})
	fs.BoolVar(&json, "json", false, "")
	fs.StringVar(&line, "line", "", "")
	fs.Var(ListValue{Items: &ids}, "id", "")
	pos, err := ParseInterspersed(fs, []string{"a", "--json", "b", "--line=v2", "--id", "x,y", "--id", "z", "--", "--c"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(pos, ",") != "a,b,--c" || !json || line != "v2" || strings.Join(ids, ",") != "x,y,z" {
		t.Errorf("pos=%v json=%v line=%q ids=%v", pos, json, line, ids)
	}
	if _, err := ParseInterspersed(fs, []string{"--bogus"}); err == nil {
		t.Error("an unknown flag must fail")
	}
}
