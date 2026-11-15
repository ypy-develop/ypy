// SPDX-License-Identifier: MIT

package build

import (
	"bytes"
	"encoding/json"
	"fmt"
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

// minify compresses one JavaScript file and returns the code, ending in the
// source map comment, and the source map. name is the output file name
// (for example "ypy.min.js"); the map refers to the unminified sibling
// source ("ypy.js").
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
	out := strings.TrimRight(string(res.Code), "\n")
	out += "\n//# sourceMappingURL=" + outName + ".map\n"
	return []byte(out), compact.Bytes(), nil
}
