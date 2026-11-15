// SPDX-License-Identifier: MIT

package gates

import (
	"strings"
	"testing"
)

func TestResolveBrowsers(t *testing.T) {
	const why = "geckodriver is not on the PATH"
	cases := []struct {
		name      string
		requested string
		ready     bool
		require   bool
		want      string
		warn      bool
		errHas    string
	}{
		{"default with geckodriver", "", true, false, "chrome,firefox", false, ""},
		{"default with geckodriver, required", "", true, true, "chrome,firefox", false, ""},
		{"default without geckodriver warns and runs Chrome", "", false, false, "chrome", true, ""},
		{"default without geckodriver, required, fails", "", false, true, "", false, "required"},
		{"explicit chrome is kept even with geckodriver", "chrome", true, false, "chrome", false, ""},
		{"explicit chrome,safari is kept", "chrome,safari", false, false, "chrome,safari", false, ""},
		{"explicit firefox without geckodriver is left to the runner", "chrome,firefox", false, false, "chrome,firefox", false, ""},
		{"required with explicit chrome only fails", "chrome", true, true, "", false, "--browsers"},
		{"required with firefox listed but not ready fails", "chrome,firefox", false, true, "", false, "unavailable"},
		{"required with firefox ready passes", "chrome,firefox", true, true, "chrome,firefox", false, ""},
		{"names are normalized", " Chromium , firefox", true, false, "chrome,firefox", false, ""},
		{"unknown browser is an error", "opera", true, false, "", false, "unknown browser"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, warning, err := ResolveBrowsers(c.requested, c.ready, why, c.require)
			if c.errHas != "" {
				if err == nil || !strings.Contains(err.Error(), c.errHas) {
					t.Fatalf("want an error with %q, got list %q, err %v", c.errHas, got, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != c.want {
				t.Errorf("list = %q, want %q", got, c.want)
			}
			if (warning != "") != c.warn {
				t.Errorf("warning = %q, want a warning: %v", warning, c.warn)
			}
			if c.warn && !strings.Contains(warning, why) {
				t.Errorf("the warning does not say why: %q", warning)
			}
		})
	}
}

func TestE2EArgsUseTheBrowserGateChoice(t *testing.T) {
	e := &Env{Root: "/r", Browsers: "chrome,firefox,safari", ChromePath: "/c", Port: 8200}
	got := strings.Join(e2eArgs(e), " ")
	want := "--root /r --browsers chrome,firefox,safari --suite e2e --strict --chrome /c --port 8300"
	if got != want {
		t.Errorf("args = %q, want %q", got, want)
	}
	if got := strings.Join(e2eArgs(&Env{Root: "/r", Browsers: "chrome"}), " "); got != "--root /r --browsers chrome --suite e2e --strict" {
		t.Errorf("args = %q", got)
	}
}
