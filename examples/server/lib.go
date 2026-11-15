// SPDX-License-Identifier: MIT

package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Every page loads its scripts through URLs of the form
//
//	/_lib/core.js
//	/_lib/ext/<name>.js      (name: sse | ws)
//	/_lib/extra/<name>.js    (YPY_EXTRA)
var libPath = regexp.MustCompile(`^/_lib/(core|ext/([a-z-]+)|extra/([a-z0-9-]+))\.js$`)

var extensions = []string{"sse", "ws"}

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}

func firstExisting(files ...string) string {
	for _, f := range files {
		if isFile(f) {
			return f
		}
	}
	return ""
}

// resolveCore picks the YPY build. YPY_DIST may be a file or a directory holding
// ypy.min.js. Without it the dist/ folder of this checkout is used.
func (c *config) resolveCore() string {
	name := "ypy.min.js"
	dist := c.ypyDist
	if dist == "" {
		dist = filepath.Join(c.root, "dist")
	}
	if st, err := os.Stat(dist); err == nil && !st.IsDir() {
		return dist
	}
	return firstExisting(filepath.Join(dist, name))
}

func (c *config) ypyExtDirs(core string) []string {
	return []string{filepath.Join(filepath.Dir(core), "ext"), filepath.Join(c.root, "src", "ext")}
}

// resolveLib maps a /_lib/ URL path to a file on disk, or "" when there is none.
func (c *config) resolveLib(urlPath string) string {
	m := libPath.FindStringSubmatch(urlPath)
	if m == nil {
		return ""
	}
	ext, extra := m[2], m[3]
	core := c.resolveCore()
	if core == "" {
		return ""
	}
	dirs := c.ypyExtDirs(core)
	switch {
	case ext != "":
		var files []string
		for _, d := range dirs {
			files = append(files, filepath.Join(d, "ypy-"+ext+".js"))
		}
		return firstExisting(files...)
	case extra != "":
		var files []string
		for _, d := range dirs {
			files = append(files, filepath.Join(d, extra+".js"), filepath.Join(d, extra+".min.js"))
		}
		return firstExisting(files...)
	}
	return core
}

func (c *config) scriptTags() string {
	const base = "/_lib"
	tags := []string{`<script src="` + base + `/core.js"></script>`}
	for _, e := range c.ypyExtra {
		tags = append(tags, `<script src="`+base+`/extra/`+e+`.js"></script>`)
	}
	for _, e := range extensions {
		tags = append(tags, `<script src="`+base+`/ext/`+e+`.js"></script>`)
	}
	return strings.Join(tags, "\n    ")
}
