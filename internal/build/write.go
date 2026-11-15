// SPDX-License-Identifier: MIT

package build

import (
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
)

// managedDirs are the sub-directories of the output that the build owns
// entirely: a full build removes what it did not generate in them.
var managedDirs = []string{outExtDir, outEditorsDir, outSkillsDir}

// Write writes the output under dir, through an os.Root: no path can leave dir,
// and a symlink where an output file goes is replaced by the file (never
// written through). A full build (PartAll) first removes the stale files (see
// Compare), so the result does not keep files of a previous layout; it only
// does so in a directory that is empty, holds a ypy build or only entries
// the build writes, and refuses any other (a mistaken --out ~ would delete the user's files).
func Write(dir string, out Output, only Part) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	if only == PartAll {
		if err := checkOwned(root, dir); err != nil {
			return err
		}
		for _, stale := range staleFiles(root, out) {
			if err := root.RemoveAll(filepath.FromSlash(stale)); err != nil {
				return err
			}
		}
	}
	for _, name := range out.Names() {
		rel := filepath.FromSlash(name)
		if err := root.MkdirAll(filepath.Dir(rel), 0o755); err != nil {
			return err
		}
		if fi, err := root.Lstat(rel); err == nil && fi.Mode()&fs.ModeSymlink != 0 {
			if err := root.Remove(rel); err != nil {
				return err
			}
		}
		if err := root.WriteFile(rel, out[name], 0o644); err != nil {
			return err
		}
	}
	return nil
}

// checkOwned reports an error unless the directory is a build output: it holds
// a ypy.js or ypy.min.js, or it is empty or holds only entries the build writes
// (a ypy* file, ext, editors, skills). A full build deletes what it did not
// generate in those, and nowhere else; files of other names in a build output
// are kept.
func checkOwned(root *os.Root, dir string) error {
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return err
	}
	foreign := ""
	for _, e := range entries {
		if e.Name() == "ypy.js" || e.Name() == "ypy.min.js" {
			return nil
		}
		if !strings.HasPrefix(e.Name(), "ypy") && !slices.Contains(managedDirs, e.Name()) {
			foreign = e.Name()
		}
	}
	if foreign != "" {
		return fmt.Errorf("refusing to build into %s: it holds %q and no ypy build (use an empty directory, or --only to write without cleaning)", dir, foreign)
	}
	return nil
}

// Drift describes how the disk differs from the generated output.
type Drift struct {
	Missing []string // generated but not on disk
	Changed []string // on disk with other bytes
	Stale   []string // on disk, owned by the build, not generated
}

// Empty reports whether the disk matches the output.
func (d Drift) Empty() bool { return len(d.Missing)+len(d.Changed)+len(d.Stale) == 0 }

// String lists the differences, one per line.
func (d Drift) String() string {
	var b strings.Builder
	for _, n := range d.Missing {
		fmt.Fprintf(&b, "missing: %s\n", n)
	}
	for _, n := range d.Changed {
		fmt.Fprintf(&b, "changed: %s\n", n)
	}
	for _, n := range d.Stale {
		fmt.Fprintf(&b, "stale:   %s\n", n)
	}
	return b.String()
}

// Compare checks the output against what is on disk under dir. Stale files are
// reported only for a full build. A symlink where an output file goes counts as
// changed, whatever it points at.
func Compare(dir string, out Output, only Part) Drift {
	var d Drift
	root, err := os.OpenRoot(dir)
	if err != nil {
		d.Missing = out.Names()
		return d
	}
	defer root.Close()
	for _, name := range out.Names() {
		rel := filepath.FromSlash(name)
		fi, err := root.Lstat(rel)
		switch {
		case err != nil:
			d.Missing = append(d.Missing, name)
		case fi.Mode()&fs.ModeSymlink != 0:
			d.Changed = append(d.Changed, name)
		default:
			got, err := root.ReadFile(rel)
			switch {
			case err != nil:
				d.Missing = append(d.Missing, name)
			case !bytes.Equal(got, out[name]):
				d.Changed = append(d.Changed, name)
			}
		}
	}
	if only == PartAll {
		d.Stale = staleFiles(root, out)
		sort.Strings(d.Stale)
	}
	return d
}

// staleFiles lists the files the build owns and would not generate: files of
// the managed directories and top-level ypy* files that are not in out. A
// managed directory that is itself a symlink is stale as a whole (removing it
// removes the link, not what it points at).
func staleFiles(root *os.Root, out Output) []string {
	var stale []string
	fsys := root.FS()
	for _, sub := range managedDirs {
		if fi, err := root.Lstat(sub); err == nil && fi.Mode()&fs.ModeSymlink != 0 {
			stale = append(stale, sub)
			continue
		}
		_ = fs.WalkDir(fsys, sub, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if _, ok := out[p]; !ok {
				stale = append(stale, p)
			}
			return nil
		})
	}
	entries, _ := fs.ReadDir(fsys, ".")
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "ypy") {
			continue
		}
		if _, ok := out[e.Name()]; !ok {
			stale = append(stale, e.Name())
		}
	}
	return stale
}
