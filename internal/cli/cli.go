// SPDX-License-Identifier: MIT

// Package cli is the small command framework behind the ypy binary: an
// explicit list of subcommands, a usage printer and a flag parser that accepts
// flags and positional arguments in any order.
//
// There is no global registry: cmd/ypy builds the App value and passes it the
// commands, so what the binary can do is readable in one place.
package cli

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
)

// Exit codes shared by every subcommand.
const (
	ExitOK       = 0 // nothing to report
	ExitFailure  = 1 // the command ran and found a problem (findings, drift, over budget)
	ExitUsage    = 2 // bad flags, unreadable input
	ExitInternal = 70
)

// IO is what a command may touch: it never reads os.Stdout or os.Getenv
// directly, so tests run commands in memory.
type IO struct {
	Out   io.Writer
	Err   io.Writer
	In    io.Reader
	Env   func(key string) string
	IsTTY bool
	// Dir is the working directory used to resolve relative paths; empty means
	// the process working directory.
	Dir string
}

// OS returns the IO of the running process.
func OS() IO {
	tty := false
	if st, err := os.Stdout.Stat(); err == nil {
		tty = st.Mode()&os.ModeCharDevice != 0
	}
	return IO{Out: os.Stdout, Err: os.Stderr, In: os.Stdin, Env: os.Getenv, IsTTY: tty}
}

// Command is one subcommand of the binary.
type Command struct {
	Name    string
	Summary string
	// Run executes the command with the arguments that follow its name and
	// returns the process exit code.
	Run func(ctx context.Context, args []string, io IO) int
}

// App is the binary: a name, a version and its subcommands.
type App struct {
	Name     string
	Version  string
	Commands []Command
}

// Run dispatches args (without the program name) to a subcommand.
func (a App) Run(ctx context.Context, args []string, io IO) int {
	if len(args) == 0 {
		a.usage(io.Err)
		return ExitUsage
	}
	switch args[0] {
	case "-h", "--help", "help":
		a.usage(io.Out)
		return ExitOK
	case "-v", "--version", "version":
		fmt.Fprintf(io.Out, "%s %s\n", a.Name, a.Version)
		return ExitOK
	}
	for _, c := range a.Commands {
		if c.Name == args[0] {
			return c.Run(ctx, args[1:], io)
		}
	}
	fmt.Fprintf(io.Err, "%s: unknown command %q\n", a.Name, args[0])
	a.usage(io.Err)
	return ExitUsage
}

func (a App) usage(w io.Writer) {
	cmds := append([]Command(nil), a.Commands...)
	sort.Slice(cmds, func(i, j int) bool { return cmds[i].Name < cmds[j].Name })
	var b strings.Builder
	fmt.Fprintf(&b, "%s: tools for YPY projects\n\nUsage:\n  %s <command> [options]\n\nCommands:\n", a.Name, a.Name)
	for _, c := range cmds {
		fmt.Fprintf(&b, "  %-8s %s\n", c.Name, c.Summary)
	}
	fmt.Fprintf(&b, "\nRun \"%s <command> --help\" for the options of a command.\n", a.Name)
	io.WriteString(w, b.String())
}

// ParseInterspersed parses args with fs, letting flags and positional
// arguments appear in any order (the standard library stops at the first
// positional argument). A "--" ends the flags.
func ParseInterspersed(fs *flag.FlagSet, args []string) ([]string, error) {
	var positional []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		args = fs.Args()
		if len(args) == 0 {
			return positional, nil
		}
		if args[0] == "--" {
			return append(positional, args[1:]...), nil
		}
		positional = append(positional, args[0])
		args = args[1:]
	}
}

// ListValue is a flag.Value for a repeatable, comma separated option.
type ListValue struct {
	Items *[]string
}

// String implements flag.Value.
func (l ListValue) String() string {
	if l.Items == nil {
		return ""
	}
	return strings.Join(*l.Items, ",")
}

// Set implements flag.Value.
func (l ListValue) Set(v string) error {
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			*l.Items = append(*l.Items, s)
		}
	}
	return nil
}
