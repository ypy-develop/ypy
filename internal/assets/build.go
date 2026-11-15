// SPDX-License-Identifier: MIT

package assets

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// Group says what one output file is made from.
type Group string

// The two groupings. A package is a directory: its templates and companion
// files give one stylesheet and one script. A template gives its own pair.
const (
	ByPackage  Group = "package"
	ByTemplate Group = "template"
)

// HashLen is the number of hex digits of the SHA-256 kept in a file name.
const HashLen = 10

// templateExts are the template files that are scanned, longest first.
var templateExts = []string{".kyse.go", ".gohtml", ".templ", ".html"}

// companionExts are the files that sit next to a template and belong to it.
var companionExts = map[string]Kind{".ypy.css": CSS, ".ypy.js": JS}

// Options says what to read and what to write. The paths are absolute.
type Options struct {
	Dir      string // the directory scanned
	Out      string // where the hashed files go
	Manifest string // the manifest file; empty means Out/manifest.json
	StripOut string // when set, copies of the templates without the blocks go here
	Group    Group  // empty means ByPackage
}

// Entry is one origin in the manifest: the files that hold its CSS and its
// script, as paths relative to the directory of the manifest. Either may be
// empty.
type Entry struct {
	CSS string `json:"css,omitempty"`
	JS  string `json:"js,omitempty"`
}

// Output is everything a run produces, without having written any of it.
type Output struct {
	// Files maps an absolute path to its content.
	Files map[string][]byte
	// Manifest is the manifest, by origin.
	Manifest map[string]Entry
	// ManifestPath is where the manifest goes.
	ManifestPath string
	// Counts, for the report.
	CSS, JS, Templates int
}

type source struct {
	rel      string // slash path relative to Dir
	template bool
	content  string
	blocks   []Block // of a template
	kind     Kind    // of a companion
}

// Plan scans the directory and computes every output file. It does not write.
func Plan(o Options) (*Output, error) {
	if o.Group == "" {
		o.Group = ByPackage
	}
	if o.Group != ByPackage && o.Group != ByTemplate {
		return nil, fmt.Errorf("unknown grouping %q, want %q or %q", o.Group, ByPackage, ByTemplate)
	}
	manifestPath := o.Manifest
	if manifestPath == "" {
		manifestPath = filepath.Join(o.Out, "manifest.json")
	}
	manifestDir := filepath.Dir(manifestPath)
	if rel, err := filepath.Rel(manifestDir, o.Out); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return nil, fmt.Errorf("the manifest has to be in the --out directory or above it, so every path in it can be relative to it")
	}

	srcs, err := collect(o)
	if err != nil {
		return nil, err
	}

	groups := map[string]*bundle{}
	var keys []string
	add := func(key string) *bundle {
		b := groups[key]
		if b == nil {
			b = &bundle{}
			groups[key] = b
			keys = append(keys, key)
		}
		return b
	}
	stems := map[string]string{} // "dir/stem" of a template -> its rel path (first in order wins)
	for _, s := range srcs {
		if s.template {
			stem := stripExt(s.rel, templateExts)
			if _, ok := stems[stem]; !ok {
				stems[stem] = s.rel
			}
		}
	}
	out := &Output{Files: map[string][]byte{}, Manifest: map[string]Entry{}, ManifestPath: manifestPath}
	for _, s := range srcs {
		key := path.Dir(s.rel)
		if o.Group == ByTemplate {
			key = s.rel
			if !s.template {
				if t, ok := stems[stripExt(s.rel, companionKeys())]; ok {
					key = t
				}
			}
		}
		if s.template {
			out.Templates++
			for _, b := range s.blocks {
				add(key).add(b.Kind, s.rel, b.Content)
			}
		} else {
			add(key).add(s.kind, s.rel, s.content)
		}
	}

	sort.Strings(keys)
	for _, key := range keys {
		b := groups[key]
		var e Entry
		for _, k := range []Kind{CSS, JS} {
			data := b.render(k)
			if data == nil {
				continue
			}
			sum := sha256.Sum256(data)
			name := fmt.Sprintf("%s.%s.%s", fileStem(key), hex.EncodeToString(sum[:])[:HashLen], k)
			full := filepath.Join(o.Out, name)
			out.Files[full] = data
			rel, _ := filepath.Rel(manifestDir, full)
			if k == CSS {
				e.CSS = filepath.ToSlash(rel)
				out.CSS++
			} else {
				e.JS = filepath.ToSlash(rel)
				out.JS++
			}
		}
		if e != (Entry{}) {
			out.Manifest[key] = e
		}
	}

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out.Manifest); err != nil {
		return nil, err
	}
	out.Files[manifestPath] = buf.Bytes()

	if o.StripOut != "" {
		for _, s := range srcs {
			if s.template {
				out.Files[filepath.Join(o.StripOut, filepath.FromSlash(s.rel))] = []byte(Strip(s.content, s.blocks))
			}
		}
	}
	return out, nil
}

// collect reads the templates and the companion files, in the order of their
// paths. Scan errors of every file are reported together.
func collect(o Options) ([]source, error) {
	var srcs []source
	var errs []string
	skip := map[string]bool{o.Out: true}
	if o.StripOut != "" {
		skip[o.StripOut] = true
	}
	err := filepath.WalkDir(o.Dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			name := d.Name()
			if p != o.Dir && (strings.HasPrefix(name, ".") || name == "node_modules" || name == "vendor" || skip[p]) {
				return fs.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(o.Dir, p)
		rel = filepath.ToSlash(rel)
		tmpl := hasExt(rel, templateExts)
		kind, companion := companionKind(rel)
		if !tmpl && !companion {
			return nil
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		content := normalize(string(raw))
		if companion {
			srcs = append(srcs, source{rel: rel, content: content, kind: kind})
			return nil
		}
		ext := path.Ext(rel)
		blocks, err := Scan(content, ext == ".html" || ext == ".gohtml")
		if err != nil {
			for _, line := range strings.Split(err.Error(), "\n") {
				errs = append(errs, rel+": "+line)
			}
			return nil
		}
		srcs = append(srcs, source{rel: rel, template: true, content: content, blocks: blocks})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(errs) > 0 {
		return nil, fmt.Errorf("%s", strings.Join(errs, "\n"))
	}
	sort.Slice(srcs, func(i, j int) bool { return srcs[i].rel < srcs[j].rel })
	return srcs, nil
}

// bundle collects the chunks of one origin.
type bundle struct{ css, js []string }

func (b *bundle) add(k Kind, origin, content string) {
	content = dedent(content)
	if strings.TrimSpace(content) == "" {
		return
	}
	if k == CSS {
		b.css = append(b.css, "/* "+origin+" */\n"+content+"\n")
		return
	}
	// A script of its own scope: two templates may both declare const x, and a
	// page must not fail because of it. A name meant to be global is set on window.
	b.js = append(b.js, "/* "+origin+" */\n(() => {\n"+content+"\n})();\n")
}

func (b *bundle) render(k Kind) []byte {
	chunks := b.css
	if k == JS {
		chunks = b.js
	}
	if len(chunks) == 0 {
		return nil
	}
	return []byte(strings.Join(chunks, "\n"))
}

// dedent removes the indentation every non-blank line has in common and the
// blank lines around the text.
func dedent(s string) string {
	lines := strings.Split(strings.Trim(s, "\n"), "\n")
	prefix, first := "", true
	for _, l := range lines {
		if strings.TrimSpace(l) == "" {
			continue
		}
		ind := l[:len(l)-len(strings.TrimLeft(l, " \t"))]
		if first {
			prefix, first = ind, false
			continue
		}
		n := 0
		for n < len(prefix) && n < len(ind) && prefix[n] == ind[n] {
			n++
		}
		prefix = prefix[:n]
	}
	for i, l := range lines {
		if strings.TrimSpace(l) == "" {
			lines[i] = ""
		} else {
			lines[i] = strings.TrimRight(strings.TrimPrefix(l, prefix), " \t")
		}
	}
	return strings.Join(lines, "\n")
}

func hasExt(name string, exts []string) bool {
	for _, e := range exts {
		if strings.HasSuffix(name, e) {
			return true
		}
	}
	return false
}

func companionKeys() []string {
	return []string{".ypy.css", ".ypy.js"}
}

func companionKind(name string) (Kind, bool) {
	for e, k := range companionExts {
		if strings.HasSuffix(name, e) {
			return k, true
		}
	}
	return "", false
}

func stripExt(name string, exts []string) string {
	for _, e := range exts {
		if strings.HasSuffix(name, e) {
			return strings.TrimSuffix(name, e)
		}
	}
	return name
}

// fileStem turns an origin into the readable part of a file name: the path
// without the template extension, with "-" for the separators.
func fileStem(key string) string {
	key = stripExt(key, append(append([]string{}, templateExts...), companionKeys()...))
	if key == "." || key == "" {
		return "root"
	}
	var b strings.Builder
	for _, r := range key {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	if stem := strings.Trim(b.String(), "-"); stem != "" {
		return stem
	}
	return "root"
}
