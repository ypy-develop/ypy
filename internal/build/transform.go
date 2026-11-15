// SPDX-License-Identifier: MIT

package build

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/evanw/esbuild/pkg/api"
)

// privateNames turns the source convention for private members (a double
// underscore prefix, written that way so the source stays valid, tool-friendly
// JavaScript) into real private names: "__x" becomes "#x". The "__proto__" key
// is left alone. It replaces the sed pipeline of the previous build and
// replaces text, not syntax, like it.
func privateNames(src []byte) []byte {
	const placeholder = "@@PROTOKEY@@"
	s := strings.ReplaceAll(string(src), "__proto__", placeholder)
	s = strings.ReplaceAll(s, "__", "#")
	s = strings.ReplaceAll(s, placeholder, "__proto__")
	return []byte(s)
}

// stampVersion sets the version the core reports (the line
// "this.version = '...'" of src/ypy.js) to the content of the VERSION file, so
// a build cannot publish another version than the one the repository says.
func stampVersion(core []byte, version string) ([]byte, error) {
	if !versionPattern.MatchString(version) {
		return nil, fmt.Errorf("VERSION %q is not a version like 1.2.3 or 1.2.3-rc.1", version)
	}
	if n := len(versionLine.FindAll(core, -1)); n != 1 {
		return nil, fmt.Errorf("%s must set the version in exactly one line \"this.version = '...'\" (found %d)", coreSource, n)
	}
	return versionLine.ReplaceAll(core, []byte("${1}"+version+"${2}")), nil
}

var (
	versionLine    = regexp.MustCompile(`(this\.version = ')[^']*(')`)
	versionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$`)
)

// minify compresses one JavaScript file and returns the code, without the
// source map comment, and the source map. sourceName is the unminified sibling
// the map refers to ("ypy.js"). addMin adds the comment.
func minify(src []byte, sourceName, outName string, esm bool) (code, sourceMap []byte, err error) {
	opts := api.TransformOptions{
		Loader:            api.LoaderJS,
		Target:            api.ESNext,
		Charset:           api.CharsetUTF8,
		MinifyWhitespace:  true,
		MinifyIdentifiers: true,
		MinifySyntax:      true,
		Sourcemap:         api.SourceMapExternal,
		SourcesContent:    api.SourcesContentExclude,
		Sourcefile:        sourceName,
	}
	if esm {
		opts.Format = api.FormatESModule
	}
	res := api.Transform(string(src), opts)
	if len(res.Errors) > 0 {
		msgs := make([]string, len(res.Errors))
		for i, m := range res.Errors {
			msgs[i] = fmt.Sprintf("%s:%d:%d: %s", sourceName, m.Location.Line, m.Location.Column, m.Text)
		}
		return nil, nil, fmt.Errorf("minify %s: %s", outName, strings.Join(msgs, "; "))
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, res.Map); err != nil {
		return nil, nil, fmt.Errorf("minify %s: source map: %w", outName, err)
	}
	return []byte(strings.TrimRight(string(res.Code), "\n") + "\n"), compact.Bytes(), nil
}
