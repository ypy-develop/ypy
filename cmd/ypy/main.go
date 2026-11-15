// SPDX-License-Identifier: MIT

// Command ypy is the YPY toolbox: one binary, explicit subcommands.
package main

import (
	"context"
	"os"
	"os/signal"

	"github.com/ypy-develop/ypy/internal/assets"
	"github.com/ypy-develop/ypy/internal/bench"
	"github.com/ypy-develop/ypy/internal/build"
	"github.com/ypy-develop/ypy/internal/check"
	"github.com/ypy-develop/ypy/internal/cli"
	"github.com/ypy-develop/ypy/internal/gates"
	"github.com/ypy-develop/ypy/internal/gen"
	"github.com/ypy-develop/ypy/internal/testrun"
)

// version is the version of the tools; the rules and the build change with it.
const version = "0.1.0-dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	app := cli.App{
		Name:    "ypy",
		Version: version,
		// New subcommands are added here, one line each.
		Commands: []cli.Command{
			bench.Command(),
			build.Command(),
			check.Command(),
			assets.Under(gen.Command()),
			gates.Command(),
			check.MigrateCommand(),
			testrun.Command(),
		},
	}
	os.Exit(app.Run(ctx, os.Args[1:], cli.OS()))
}
