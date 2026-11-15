// SPDX-License-Identifier: MIT

// Package build generates the dist/ directory of the framework from src/: the
// unminified and minified bundles (script and ES module), the extensions, the
// ypy.max bundle, the editor files, the skills, the type
// declarations and the brotli copies.
//
// Generate returns the whole output in memory so the same code serves the
// build (write it), the drift gate (compare it with the disk) and the size
// gate (measure it).
package build

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/andybalholm/brotli"
)

// Part selects a slice of the output.
type Part string

// The parts a build can be limited to.
const (
	PartAll  Part = ""
	PartCore Part = "core" // ypy, ypy.esm, their minified forms, types, editors, skills
	PartExt  Part = "ext"  // dist/ext
	PartMax  Part = "max"  // ypy.max bundle
)

// ParsePart validates a --only value.
func ParsePart(s string) (Part, error) {
	switch p := Part(s); p {
	case PartAll, PartCore, PartExt, PartMax:
		return p, nil
	}
	return "", fmt.Errorf("--only must be one of core, ext, max (got %q)", s)
}

// Options configure Generate.
type Options struct {
	// Root is the repository root: it holds src/.
	Root string
	// Only limits the output to one part; PartAll builds everything.
	Only Part
}

// Output is the generated tree: slash separated paths relative to the output
// directory, mapped to their bytes.
type Output map[string][]byte

// Names returns the generated paths, sorted.
func (o Output) Names() []string {
	names := make([]string, 0, len(o))
	for n := range o {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

type sources struct {
	core    []byte
	exts    map[string][]byte // by file name without .js
	extList []string          // sorted names
}

// errSymlink is the refusal of a symlink in the sources: a link can point at
// a private file outside the repository, and what the build reads ends up in
// dist/, which the project commits.
func errSymlink(name string) error {
	return fmt.Errorf("%s is a symbolic link: the build reads regular files only", name)
}

// readSources reads the core and the extensions through root (an os.Root of
// the repository), so a path cannot leave it.
func readSources(root *os.Root) (*sources, error) {
	s := &sources{exts: map[string][]byte{}}
	var err error
	if s.core, err = readFile(root, coreSource); err != nil {
		return nil, fmt.Errorf("core source: %w", err)
	}
	entries, err := fs.ReadDir(root.FS(), extDir)
	if err != nil {
		return nil, fmt.Errorf("extensions: %w", err)
	}
	for _, e := range entries {
		name, ok := strings.CutSuffix(e.Name(), ".js")
		if !ok || e.IsDir() {
			continue
		}
		b, err := readFile(root, path.Join(extDir, e.Name()))
		if err != nil {
			return nil, err
		}
		s.exts[name] = b
		s.extList = append(s.extList, name)
	}
	sort.Strings(s.extList)
	return s, nil
}

// readFile reads a regular file of the repository: a symlink is refused even
// when it stays inside the root.
func readFile(root *os.Root, name string) ([]byte, error) {
	fi, err := root.Lstat(filepath.FromSlash(name))
	if err != nil {
		return nil, err
	}
	if fi.Mode()&fs.ModeSymlink != 0 {
		return nil, errSymlink(name)
	}
	return root.ReadFile(filepath.FromSlash(name))
}

// Generate builds the output in memory.
func Generate(opts Options) (Output, error) {
	root, err := os.OpenRoot(opts.Root)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	src, err := readSources(root)
	if err != nil {
		return nil, err
	}
	// A tree without VERSION is an old commit the benchmarks build (ypy bench --ref): its core
	// keeps the version it had. The repository has the file, and version_test.go keeps it so.
	switch version, err := readFile(root, versionFile); {
	case err == nil:
		if src.core, err = stampVersion(src.core, strings.TrimSpace(string(version))); err != nil {
			return nil, err
		}
	case !errors.Is(err, fs.ErrNotExist):
		return nil, fmt.Errorf("version: %w", err)
	}
	out := Output{}
	want := func(p Part) bool { return opts.Only == PartAll || opts.Only == p }

	iife := privateNames(src.core)
	if want(PartCore) {
		out[outCore] = iife
		esm := append(append([]byte(nil), iife...), esmEpilogue...)
		out[outESM] = esm
		if err := addMin(out, outCoreMin, outCore, iife, false); err != nil {
			return nil, err
		}
		if err := addMin(out, outESMMin, outESM, esm, true); err != nil {
			return nil, err
		}
		types, err := readFile(root, typesSource)
		if err != nil {
			return nil, fmt.Errorf("types: %w", err)
		}
		out[outTypes] = types
		if err := copyTree(root, editorsDir, outEditorsDir, "", out); err != nil {
			return nil, err
		}
		if err := copyTree(root, skillsDir, outSkillsDir, ".md", out); err != nil {
			return nil, err
		}
	}

	if want(PartExt) {
		for _, name := range src.extList {
			file := name + ".js"
			out[path.Join(outExtDir, file)] = src.exts[name]
			if err := addMin(out, path.Join(outExtDir, name+".min.js"), path.Join(outExtDir, file), src.exts[name], false); err != nil {
				return nil, err
			}
		}
	}

	if want(PartMax) {
		var b bytes.Buffer
		b.Write(iife)
		b.WriteString(maxPreamble)
		for _, name := range maxExtensions {
			body, ok := src.exts[name]
			if !ok {
				return nil, fmt.Errorf("max bundle: extension %q not found in %s", name, extDir)
			}
			b.Write(body)
		}
		out[outMax] = b.Bytes()
		if err := addMin(out, outMaxMin, outMax, b.Bytes(), false); err != nil {
			return nil, err
		}
	}

	if want(PartCore) {
		if err := addCSS(opts.Root, out); err != nil {
			return nil, err
		}
	}

	// brotli copies of every script of dist/ and dist/ext (not of source maps or embed/)
	for _, name := range out.Names() {
		if strings.HasSuffix(name, ".js") && !strings.HasPrefix(name, outEditorsDir+"/") && !strings.HasPrefix(name, outEmbedDir+"/") {
			br, err := compressBrotli(out[name])
			if err != nil {
				return nil, err
			}
			out[name+".br"] = br
		}
	}
	return out, nil
}

// addMin adds the minified file with its source map comment, the source map,
// and the same code without the comment under embed/ for whoever embeds the
// file (a Go program, a bundle) and does not serve the map next to it.
func addMin(out Output, minName, srcName string, src []byte, esm bool) error {
	code, sm, err := minify(src, path.Base(srcName), path.Base(minName), esm)
	if err != nil {
		return err
	}
	out[path.Join(outEmbedDir, minName)] = code
	out[minName] = append(append([]byte(nil), code...), "//# sourceMappingURL="+path.Base(minName)+".map\n"...)
	out[minName+".map"] = sm
	return nil
}

// copyTree copies srcDir (under root) into out under dstDir. A non-empty
// suffix keeps only files with it. A symlink anywhere in the tree is an error.
func copyTree(root *os.Root, srcDir, dstDir, suffix string, out Output) error {
	err := fs.WalkDir(root.FS(), srcDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return errSymlink(p)
		}
		if d.IsDir() || (suffix != "" && !strings.HasSuffix(p, suffix)) {
			return nil
		}
		rel := strings.TrimPrefix(p, srcDir+"/")
		b, err := root.ReadFile(filepath.FromSlash(p))
		if err != nil {
			return err
		}
		out[path.Join(dstDir, rel)] = b
		return nil
	})
	if err != nil {
		return fmt.Errorf("copy %s: %w", srcDir, err)
	}
	return nil
}

func compressBrotli(b []byte) ([]byte, error) {
	var buf bytes.Buffer
	w := brotli.NewWriterOptions(&buf, brotli.WriterOptions{Quality: brotliQuality, LGWin: brotliWindow})
	if _, err := w.Write(b); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
