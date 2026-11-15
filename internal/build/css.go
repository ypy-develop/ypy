// SPDX-License-Identifier: MIT

package build

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/evanw/esbuild/pkg/api"
)

// The stylesheets of the framework live in src/css and are published next to
// the core. They are optional for the user: ypy.css holds the indicator, the
// progress bar and the opt-in transitions, ypy-tailwind.css holds the Tailwind
// v4 variants (it is imported by the user's stylesheet, so it is copied as is).
const (
	cssDir        = "src/css"
	cssSource     = "ypy.css"
	outCSS        = "ypy.css"
	outCSSMin     = "ypy.min.css"
	tailwindSrc   = "ypy-tailwind.css"
	outTailwindCS = "ypy-tailwind.css"
)

// addCSS adds the stylesheets of src/css to out. A source tree without src/css
// builds without them, so the files are optional for the pipeline as they are
// for the user.
func addCSS(root string, out Output) error {
	dir := filepath.Join(root, cssDir)
	if _, err := os.Stat(dir); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	src, err := os.ReadFile(filepath.Join(dir, cssSource))
	if err != nil {
		return fmt.Errorf("stylesheet: %w", err)
	}
	min, err := minifyCSS(src, cssSource)
	if err != nil {
		return err
	}
	out[outCSS] = src
	out[outCSSMin] = min
	tw, err := os.ReadFile(filepath.Join(dir, tailwindSrc))
	if err != nil {
		return fmt.Errorf("tailwind variants: %w", err)
	}
	out[outTailwindCS] = tw
	return nil
}

// minifyCSS compresses a stylesheet. The legal comment (/*! ... */) stays.
func minifyCSS(src []byte, name string) ([]byte, error) {
	res := api.Transform(string(src), api.TransformOptions{
		Loader:           api.LoaderCSS,
		Target:           api.ESNext,
		Charset:          api.CharsetUTF8,
		MinifyWhitespace: true,
		MinifySyntax:     true,
		LegalComments:    api.LegalCommentsInline,
		Sourcefile:       name,
	})
	if len(res.Errors) > 0 {
		msgs := make([]string, len(res.Errors))
		for i, m := range res.Errors {
			msgs[i] = fmt.Sprintf("%s:%d:%d: %s", name, m.Location.Line, m.Location.Column, m.Text)
		}
		return nil, fmt.Errorf("minify %s: %s", name, strings.Join(msgs, "; "))
	}
	return res.Code, nil
}
