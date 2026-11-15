// SPDX-License-Identifier: MIT

package gates

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The sheets of the visual matrix are in the vendored list, with a license the gate recognises as MIT.
func TestVendoredCSSSheetsAreChecked(t *testing.T) {
	want := []string{"bootstrap/bootstrap.min.css", "bulma/bulma.min.css", "pico/pico.min.css", "tailwind/tailwind.css"}
	for _, w := range want {
		found := false
		for _, v := range vendored {
			if v.file != "test/fixtures/css/"+w {
				continue
			}
			found = true
			text, err := os.ReadFile(filepath.Join("../..", v.license))
			if err != nil {
				t.Errorf("%s: %v", w, err)
				continue
			}
			if got := detectLicense(string(text)); got != v.want || !allowedLicenses[got] {
				t.Errorf("%s: license %q, want %s on the allowlist", w, got, v.want)
			}
			if _, err := os.Stat(filepath.Join("../..", v.file)); err != nil {
				t.Errorf("%s: %v", w, err)
			}
			if !strings.HasSuffix(v.license, "/LICENSE") {
				t.Errorf("%s: unexpected license file %s", w, v.license)
			}
		}
		if !found {
			t.Errorf("%s is not in the vendored list of the licenses gate", w)
		}
	}
}
