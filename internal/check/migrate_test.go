// SPDX-License-Identifier: MIT

package check

import (
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ypy-develop/ypy/internal/cli"
)

// The migration tests use the invented prefix "acme" (attributes: acme-get,
// headers: ACME-Request) and the invented identifier "bolt" for the old
// library (bolt.config, bolt:afterSwap, bolt-request): the converter never
// names the real ones, so a made-up pair proves that it goes by shape.

func runMigrateCLI(t testing.TB, dir string, args ...string) (int, string, string) {
	t.Helper()
	abs, err := filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out, errb bytes.Buffer
	code := runMigrate(context.Background(), args, cli.IO{Out: &out, Err: &errb, Dir: abs, Env: func(string) string { return "" }})
	return code, out.String(), errb.String()
}

// convertOne writes text as file, migrates it with the invented names forced
// and returns the new content.
func convertOne(t testing.TB, file, text string, extra ...string) string {
	t.Helper()
	dir := t.TempDir()
	write(t, dir, file, text)
	args := append([]string{"--write", "--prefix", acme, "--id", bolt}, extra...)
	if code, _, errs := runMigrateCLI(t, dir, args...); code != 0 {
		t.Fatalf("exit %d: %s", code, errs)
	}
	b, err := os.ReadFile(filepath.Join(dir, file))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestMigrateByFileType(t *testing.T) {
	cases := []struct{ name, file, in, want string }{
		{"html attributes", "a.html",
			`<button acme-get="/x" acme-target="#out" data-acme-swap="none" acme-on::after-swap="f()">x</button>`,
			`<button ypy-get="/x" ypy-target="#out" data-ypy-swap="none" ypy-on::after-swap="f()">x</button>`},
		{"go template", "a.gohtml",
			`<div acme-get="{{ .URL }}" {{ if .X }}acme-swap="none"{{ end }}>{{ .AcmeTarget }}{{ .Request.Header.Get "ACME-Request" }}</div>`,
			`<div ypy-get="{{ .URL }}" {{ if .X }}ypy-swap="none"{{ end }}>{{ .YpyTarget }}{{ .Request.Header.Get "YPY-Request" }}</div>`},
		{"templ", "a.templ",
			"templ A(u string) {\n\t<button acme-get={ u } acme-target=\"#o\">x</button>\n}\n",
			"templ A(u string) {\n\t<button ypy-get={ u } ypy-target=\"#o\">x</button>\n}\n"},
		{"kyse template", "a.kyse.go",
			"//go:build kyse\n\npackage c\n\n@go\ntype P struct{ AcmeGet string }\n@endgo\n\n<b\n\t@if(.AcmeGet != \"\")\n\t\tacme-get=\"{{ .AcmeGet }}\"\n\t@endif\n></b>\n",
			"//go:build kyse\n\npackage c\n\n@go\ntype P struct{ YpyGet string }\n@endgo\n\n<b\n\t@if(.YpyGet != \"\")\n\t\typy-get=\"{{ .YpyGet }}\"\n\t@endif\n></b>\n"},
		{"jinja", "a.jinja",
			`<div acme-get="{{ u }}">{% if request.headers.get('ACME-Request') %}x{% endif %}</div>`,
			`<div ypy-get="{{ u }}">{% if request.headers.get('YPY-Request') %}x{% endif %}</div>`},
		{"erb", "a.erb",
			`<div acme-get="<%= u %>"><% if request.headers['ACME-Request'] %>x<% end %></div>`,
			`<div ypy-get="<%= u %>"><% if request.headers['YPY-Request'] %>x<% end %></div>`},
		{"blade", "a.blade.php",
			"<div acme-get=\"{{ $u }}\">@if(request()->header('ACME-Request'))x@endif</div>",
			"<div ypy-get=\"{{ $u }}\">@if(request()->header('YPY-Request'))x@endif</div>"},
		{"twig", "a.twig",
			`<div acme-get="{{ path('x') }}">{% if app.request.headers.get('ACME-Request') %}x{% endif %}</div>`,
			`<div ypy-get="{{ path('x') }}">{% if app.request.headers.get('YPY-Request') %}x{% endif %}</div>`},
		{"php template", "a.php",
			"<div acme-get=\"<?= $u ?>\"></div>\n<?php if (($_SERVER['HTTP_ACME_REQUEST'] ?? '') === 'true') { header('ACME-Trigger: saved'); } ?>\n",
			"<div ypy-get=\"<?= $u ?>\"></div>\n<?php if (($_SERVER['HTTP_YPY_REQUEST'] ?? '') === 'true') { header('YPY-Trigger: saved'); } ?>\n"},
		{"javascript", "a.js",
			"const t = `<div acme-get=\"/x\">${bolt.config.k}</div>`;\nel.dataset.acmeSwap = 'none';\nbolt.process(el);\nfetch('/x', {headers: {'ACME-Request': 'true'}});\n",
			"const t = `<div ypy-get=\"/x\">${ypy.config.k}</div>`;\nel.dataset.ypySwap = 'none';\nypy.process(el);\nfetch('/x', {headers: {'YPY-Request': 'true'}});\n"},
		{"typescript", "a.ts",
			"const h: Record<string, string> = { \"ACME-Trigger\": \"x\" };\nel.setAttribute(\"acme-target\", \"#o\");\nwindow.bolt?.process(el);\n",
			"const h: Record<string, string> = { \"YPY-Trigger\": \"x\" };\nel.setAttribute(\"ypy-target\", \"#o\");\nwindow.ypy?.process(el);\n"},
		{"css", "a.css",
			".bolt-request .r { color: red }\n[acme-boost] a, a[data-acme-get] { color: blue }\n[sse-connect] { display: block }\n",
			".ypy-request .r { color: red }\n[ypy-boost] a, a[data-ypy-get] { color: blue }\n[ypy-sse\\:connect] { display: block }\n"},
		{"go server", "a.go",
			"package p\n\nfunc h(w W, r R) {\n\tif r.Header.Get(\"ACME-Request\") == \"true\" {\n\t\tw.Header().Set(\"Vary\", \"ACME-Request, ACME-History-Restore-Request\")\n\t\tw.Header().Set(\"ACME-Trigger\", `{\"a\": 1}`)\n\t}\n\t_ = \"\\tacme-get=\\\"x\\\"\\n\"\n}\n",
			"package p\n\nfunc h(w W, r R) {\n\tif r.Header.Get(\"YPY-Request\") == \"true\" {\n\t\tw.Header().Set(\"Vary\", \"YPY-Request, YPY-History-Restore-Request\")\n\t\tw.Header().Set(\"YPY-Trigger\", `{\"a\": 1}`)\n\t}\n\t_ = \"\\typy-get=\\\"x\\\"\\n\"\n}\n"},
		{"php server", "a.php",
			"<?php\nif (($_SERVER['HTTP_ACME_REQUEST'] ?? '') === 'true') {\n    header('ACME-Redirect: /login');\n    header('Vary: ACME-Request');\n}\n",
			"<?php\nif (($_SERVER['HTTP_YPY_REQUEST'] ?? '') === 'true') {\n    header('YPY-Redirect: /login');\n    header('Vary: YPY-Request');\n}\n"},
		{"python server", "a.py",
			"def v(request, resp):\n    if request.META.get('HTTP_ACME_REQUEST') == 'true' or request.headers['ACME-Target']:\n        resp['Vary'] = 'ACME-Request'\n    is_acme_request = request.headers.get('ACME-Request')\n",
			"def v(request, resp):\n    if request.META.get('HTTP_YPY_REQUEST') == 'true' or request.headers['YPY-Target']:\n        resp['Vary'] = 'YPY-Request'\n    is_ypy_request = request.headers.get('YPY-Request')\n"},
		{"ruby server", "a.rb",
			"request.headers['ACME-Request'] == 'true'\nresponse.headers['ACME-Trigger'] = 'saved'\nresponse.set_header('ACME-Location', '/x')\n",
			"request.headers['YPY-Request'] == 'true'\nresponse.headers['YPY-Trigger'] = 'saved'\nresponse.set_header('YPY-Location', '/x')\n"},
		{"javascript server", "a.js",
			"app.get('/x', (req, res) => {\n  if (req.get('ACME-Request') === 'true') res.set('ACME-Refresh', 'true');\n  res.vary('ACME-Request');\n});\n",
			"app.get('/x', (req, res) => {\n  if (req.get('YPY-Request') === 'true') res.set('YPY-Refresh', 'true');\n  res.vary('YPY-Request');\n});\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := convertOne(t, c.file, c.in)
			if got != c.want {
				t.Errorf("got\n%s\nwant\n%s", got, c.want)
			}
			if again := convertOne(t, c.file, got); again != got {
				t.Errorf("not idempotent:\n%s", again)
			}
		})
	}
}

func TestMigrateByRule(t *testing.T) {
	cases := []struct{ name, file, in, want string }{
		{"attribute with a modifier", "a.html", `<div acme-target:inherited="#o" acme-on:click="f()" acme-sse:connect="/s"></div>`,
			`<div ypy-target:inherited="#o" ypy-on:click="f()" ypy-sse:connect="/s"></div>`},
		{"partial tag", "a.html", `<acme-partial id="a">x</acme-partial><template acme-partial></template>`,
			`<ypy-partial id="a">x</ypy-partial><template ypy-partial></template>`},
		{"event camel case is kept", "a.js", `el.addEventListener('bolt:afterSwap', f); el.addEventListener("bolt:after:swap", g)`,
			`el.addEventListener('ypy:afterSwap', f); el.addEventListener("ypy:after:swap", g)`},
		{"event in an attribute", "a.html", `<div acme-get="/x" acme-trigger="bolt:load from:body" acme-on:bolt:afterSwap="f()" acme-on-bolt-after-request="g()"></div>`,
			`<div ypy-get="/x" ypy-trigger="ypy:load from:body" ypy-on:ypy:afterSwap="f()" ypy-on-ypy-after-request="g()"></div>`},
		{"global object", "a.js", "bolt.process(el);\nwindow.bolt.config.timeout = 1;\nif (typeof bolt !== 'undefined') {}\n",
			"ypy.process(el);\nwindow.ypy.config.timeout = 1;\nif (typeof ypy !== 'undefined') {}\n"},
		{"state classes", "a.html", `<div class="a bolt-request bolt-indicator bolt-swapping"></div><style>.bolt-settling{}</style>`,
			`<div class="a ypy-request ypy-indicator ypy-swapping"></div><style>.ypy-settling{}</style>`},
		{"extension attributes and files", "a.html",
			`<div sse-connect="/s" sse-swap="m" sse-close="x" ws-connect="/w" ws-send></div><script src="/js/acme-sse.js"></script><script src="/js/acme-head-support.min.js"></script>`,
			`<div ypy-sse:connect="/s" ypy-sse-swap="m" ypy-sse:close="x" ypy-ws:connect="/w" ypy-ws:send></div><script src="/js/ypy-sse.js"></script><script src="/js/ypy-head-support.min.js"></script>`},
		{"preload attribute", "a.html", `<a href="/x" preload="mouseover">a</a><video preload="auto"></video><link rel="x" preload="y">`,
			`<a href="/x" ypy-preload="mouseover">a</a><video preload="auto"></video><link rel="x" preload="y">`},
		{"config meta", "a.html", `<meta name="bolt-config" content='{"a": 1}'>`, `<meta name="ypy-config" content='{"a": 1}'>`},
		{"script tag of the legacy markup", "a.html", `<script src="/static/js/bolt.min.js?v=2" integrity="sha384-x" crossorigin="anonymous"></script><script src="/static/bolt.js"></script>`,
			`<script src="/static/js/ypy.min.js?v=2" crossorigin="anonymous"></script><script src="/static/ypy.js"></script>`},
		{"asset name in a string", "a.go", "package p\n\nvar _ = view.Asset(\"bolt.min.js\")\n", "package p\n\nvar _ = view.Asset(\"ypy.min.js\")\n"},
		{"identifiers", "a.go", "package p\n\nvar a = P{AcmeGet: 1, AcmeTarget: 2, AcmePushUrl: 3, AcmeTargetSelector: 4}\nvar acmeOn, acme_request, ACME_REQUEST, AcmeX, Acmeget = 1, 2, 3, 4, 5\n",
			"package p\n\nvar a = P{YpyGet: 1, YpyTarget: 2, YpyPushUrl: 3, YpyTargetSelector: 4}\nvar ypyOn, ypy_request, YPY_REQUEST, AcmeX, Acmeget = 1, 2, 3, 4, 5\n"},
		{"header cases", "a.go", "package p\n\nvar _ = []string{\"ACME-Request\", \"acme-request\", \"Acme-Trigger\", \"ACME-Current-URL\", \"ACME-Trigger-After-Swap\"}\n",
			"package p\n\nvar _ = []string{\"YPY-Request\", \"ypy-request\", \"Ypy-Trigger\", \"YPY-Current-URL\", \"YPY-Trigger-After-Swap\"}\n"},
		{"selector and attribute name in a string", "a.js", `document.querySelectorAll('[acme-get],[data-acme-post]'); el.getAttribute("acme-on:click");`,
			`document.querySelectorAll('[ypy-get],[data-ypy-post]'); el.getAttribute("ypy-on:click");`},
		{"template literal expression", "a.js", "const s = `<b acme-get=\"/x\">${bolt.version}</b>`;", "const s = `<b ypy-get=\"/x\">${ypy.version}</b>`;"},
		{"inline script", "a.html", "<script>\n  bolt.process(document.body);\n  var h = {\"ACME-Request\": \"1\"};\n</script>", "<script>\n  ypy.process(document.body);\n  var h = {\"YPY-Request\": \"1\"};\n</script>"},
		{"inline handler", "a.html", `<button onclick="bolt.trigger('#x', 'go')" acme-on:click="bolt.ajax('GET', '/x')">x</button>`,
			`<button onclick="ypy.trigger('#x', 'go')" ypy-on:click="ypy.ajax('GET', '/x')">x</button>`},
		{"pattern in a Go string", "a.go", "package p\n\nvar re = regexp.MustCompile(`<a\\b[^>]*acme-get=\"([^\"]*)\"[^>]*>`)\nvar tab = \"\\tacme-post=\\\"x\\\"\"\n",
			"package p\n\nvar re = regexp.MustCompile(`<a\\b[^>]*ypy-get=\"([^\"]*)\"[^>]*>`)\nvar tab = \"\\typy-post=\\\"x\\\"\"\n"},
		{"jsx", "a.jsx", `export const A = () => <button acme-get="/x" acme-target="#o">go</button>;`, `export const A = () => <button ypy-get="/x" ypy-target="#o">go</button>;`},
		{"vue", "a.vue", "<template><button acme-get=\"/x\">go</button></template>\n<script>\nbolt.process(el)\n</script>\n", "<template><button ypy-get=\"/x\">go</button></template>\n<script>\nypy.process(el)\n</script>\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := convertOne(t, c.file, c.in)
			if got != c.want {
				t.Errorf("got\n%s\nwant\n%s", got, c.want)
			}
			if again := convertOne(t, c.file, got); again != got {
				t.Errorf("not idempotent:\n%s", again)
			}
		})
	}
}

// Text the converter must not touch: running text, comments, names that only
// look alike, other frameworks, native names.
func TestMigrateLeavesFalsePositivesAlone(t *testing.T) {
	cases := []struct{ name, file, text string }{
		{"prose in html", "a.html", "<p>Write acme-get to fetch, and read ACME-Request on the server, as bolt does.</p><acme-get>x</acme-get>"},
		{"html comment", "a.html", "<!-- acme-get acme-target ACME-Request bolt:afterSwap bolt-request -->"},
		{"js comment", "a.js", "// acme-get, ACME-Request, bolt:afterSwap, bolt.process()\n/* acme-get */\n"},
		{"go comment", "a.go", "package p\n\n// reads \"ACME-Request\" and acme-get\n"},
		{"template comment", "a.gohtml", "{{/* acme-get ACME-Request */}}<p>x</p>"},
		{"other frameworks", "a.html", `<div x-on:click="a = 1" v-on:click="go()" @click="b()" data-action="x" class="max-w-xl re-select"></div>`},
		{"headers that only look alike", "a.go", "package p\n\nvar _ = []string{\"X-Request-Id\", \"X-Forwarded-For\", \"Content-Type\", \"Request-Target\"}\n"},
		{"css that only looks alike", "a.css", ".max-width { max-width: 1px } .re-target { color: red } [data-x-get] { } a { --acme-get: 1; color: var(--acme-get) }\n"},
		{"native names", "a.html", `<button ypy-get="/x" ypy-target="#o" class="ypy-indicator" ypy-on::after-swap="f()">x</button><script src="/ypy.min.js"></script>`},
		{"urls", "a.js", "const u = 'https://cdn.example/bolt.org/x.js'; const w = 'bolt.org';"},
		{"words with the letters", "a.go", "package p\n\nvar acmeCorp, AcmeInc, acme_corp = 1, 2, 3\n"},
		{"member of another object", "a.js", "obj.bolt = 1; foo.bolt.bar(); const bolted = 1; boltAction();"},
		{"external script tag", "a.html", `<script src="https://unpkg.com/bolt.org@2.0.4" integrity="sha384-x"></script>`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := convertOne(t, c.file, c.text); got != c.text {
				t.Errorf("changed:\n%s", got)
			}
		})
	}
}

func TestMigrateCommentsOnRequest(t *testing.T) {
	in := "// acme-get, ACME-Request and bolt:afterSwap\nvar x = 1\n"
	if got := convertOne(t, "a.js", in); got != in {
		t.Errorf("comments are left alone by default: %s", got)
	}
	want := "// ypy-get, YPY-Request and ypy:afterSwap\nvar x = 1\n"
	if got := convertOne(t, "a.js", in, "--comments"); got != want {
		t.Errorf("--comments: %s", got)
	}
}

func TestMigrateIdentifiersCanBeLeftAlone(t *testing.T) {
	in := "package p\n\nvar _ = P{AcmeGet: \"acme-get\"}\n"
	got := convertOne(t, "a.go", in, "--no-identifiers")
	if want := "package p\n\nvar _ = P{AcmeGet: \"ypy-get\"}\n"; got != want {
		t.Errorf("got %s", got)
	}
}

// IsACME-style names: a Go predicate that spells the legacy markup after Is/Has/With is renamed in Go
// files only, and only when the prefix is a whole word at the end of the identifier.
func TestMigrateGoPredicatesNamedAfterThePrefix(t *testing.T) {
	in := "package p\n\nfunc f(c C) bool { return c.IsACME || c.HasACME() || c.isAcme || c.WithACME }\nvar IsACMERequest, IsAcmeish, IsACMEx, IsolatedACME = 1, 2, 3, 4\n"
	want := "package p\n\nfunc f(c C) bool { return c.IsYPY || c.HasYPY() || c.isYpy || c.WithYPY }\nvar IsYPYRequest, IsAcmeish, IsACMEx, IsolatedACME = 1, 2, 3, 4\n"
	if got := convertOne(t, "a.go", in); got != want {
		t.Errorf("go file: got %q", got)
	}
	// the same words in other languages and in a Go template are not renamed
	for _, file := range []string{"a.js", "a.py", "a.gohtml"} {
		keep := "x = c.IsACME or c.HasACME\n"
		if file == "a.gohtml" {
			keep = "{{ if .IsACME }}<b acme-get=\"/x\"></b>{{ end }}\n"
			want := "{{ if .IsACME }}<b ypy-get=\"/x\"></b>{{ end }}\n"
			if got := convertOne(t, file, keep); got != want {
				t.Errorf("%s: got %q", file, got)
			}
			continue
		}
		if got := convertOne(t, file, keep+"var a = acme.get\n"); !strings.HasPrefix(got, keep) {
			t.Errorf("%s: got %q", file, got)
		}
	}
	if got := convertOne(t, "a.go", in, "--no-identifiers"); got != in {
		t.Errorf("--no-identifiers changed the file: %q", got)
	}
}

// The extensions setting lists the official extensions as ypy-<name>: the short names that earlier
// builds registered are rewritten wherever the configuration is written, and nothing else is touched.
func TestMigrateRewritesShortExtensionNames(t *testing.T) {
	cases := []struct{ name, file, in, want string }{
		{"meta tag", "a.html",
			`<meta name="ypy-config" content='extensions:"ypy-lock,ypy-csp,sse,ws, preload",locked:true'>`,
			`<meta name="ypy-config" content='extensions:"ypy-lock,ypy-csp,ypy-sse,ypy-ws, ypy-preload",locked:true'>`},
		{"json in a meta tag", "a.html",
			`<meta name="ypy-config" content='{"extensions": "history-cache,alpine-compat", "logAll": true}'>`,
			`<meta name="ypy-config" content='{"extensions": "ypy-history-cache,ypy-alpine-compat", "logAll": true}'>`},
		{"quoted attribute", "a.html",
			`<meta name="ypy-config" content="extensions:&quot;ptag,upsert&quot;">`,
			`<meta name="ypy-config" content="extensions:&quot;ypy-ptag,ypy-upsert&quot;">`},
		{"script", "a.js",
			"ypy.config.extensions = 'download,browser-indicator';\nconfig.extensions = \"sse\";\n",
			"ypy.config.extensions = 'ypy-download,ypy-browser-indicator';\nconfig.extensions = \"ypy-sse\";\n"},
		{"server code", "a.go", "package p\n\nvar meta = `<meta name=\"ypy-config\" content='extensions:\"sse\"'>`\n",
			"package p\n\nvar meta = `<meta name=\"ypy-config\" content='extensions:\"ypy-sse\"'>`\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := convertOne(t, c.file, c.in); got != c.want {
				t.Errorf("got\n%s\nwant\n%s", got, c.want)
			}
			// a second run changes nothing
			if got := convertOne(t, c.file, c.want); got != c.want {
				t.Errorf("second run changed it:\n%s", got)
			}
		})
	}
	for _, keep := range []string{
		`<meta name="ypy-config" content='extensions:"my-ext,ypy-sse,sse-extra,websocket"'>`,
		"var extensions = []string{\"sse\", \"ws\"}\n",
		"<p>The sse and ws extensions</p>",
	} {
		if got := convertOne(t, "a.html", keep); got != keep {
			t.Errorf("changed %q to %q", keep, got)
		}
	}
}

func TestMigrateModuleImportKeepsTheGlobal(t *testing.T) {
	in := "import bolt from 'bolt.org';\nbolt.process(document.body);\nel.setAttribute('acme-get', '/x');\n"
	want := "import bolt from 'bolt.org';\nbolt.process(document.body);\nel.setAttribute('ypy-get', '/x');\n"
	if got := convertOne(t, "a.js", in); got != want {
		t.Errorf("got %s", got)
	}
}

func TestMigrateScriptTags(t *testing.T) {
	ext := `<script src="https://unpkg.com/bolt.org@2.0.4" integrity="sha384-x" crossorigin="anonymous"></script>`
	if got := convertOne(t, "a.html", ext); got != ext {
		t.Errorf("an external tag is left alone without --script-src: %s", got)
	}
	want := `<script src="/vendor/ypy.min.js" crossorigin="anonymous"></script>`
	if got := convertOne(t, "a.html", ext, "--script-src", "/vendor/ypy.min.js"); got != want {
		t.Errorf("--script-src: %s", got)
	}
	// the external tag is listed among what was left
	dir := t.TempDir()
	write(t, dir, "a.html", ext)
	_, out, _ := runMigrateCLI(t, dir, "--prefix", acme, "--id", bolt, "--json")
	var rep MigrateReport
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatal(err)
	}
	if len(rep.Unconverted) != 1 || rep.Unconverted[0].Kind != "script" || !strings.Contains(rep.Unconverted[0].Reason, "external") {
		t.Errorf("unconverted: %+v", rep.Unconverted)
	}
}

func TestMigrateWritesTheNativeScriptAndNoConfigMeta(t *testing.T) {
	in := "<head>\n  <script src=\"/js/bolt.min.js\"></script>\n</head>\n"
	want := "<head>\n  <script src=\"/js/ypy.min.js\"></script>\n</head>\n"
	if got := convertOne(t, "a.html", in); got != want {
		t.Errorf("got %s", got)
	}
}

// ---------------------------------------------------------------------------
// A whole project
// ---------------------------------------------------------------------------

func copyTree(t testing.TB, from, to string) {
	t.Helper()
	err := filepath.WalkDir(from, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(from, p)
		dst := filepath.Join(to, rel)
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(dst, b, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func readTree(t testing.TB, dir string) map[string]string {
	t.Helper()
	files := map[string]string{}
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := os.ReadFile(p)
			rel, _ := filepath.Rel(dir, p)
			files[filepath.ToSlash(rel)] = string(b)
		}
		return nil
	})
	return files
}

func TestMigrateProjectGolden(t *testing.T) {
	dir := t.TempDir()
	copyTree(t, "testdata/migrate/in", dir)
	before := readTree(t, dir)

	// the dry run writes nothing and shows a diff
	code, out, errs := runMigrateCLI(t, dir, ".")
	if code != 0 || errs != "" {
		t.Fatalf("exit %d: %s", code, errs)
	}
	if !strings.Contains(out, "dry run") || !strings.Contains(out, "--- a/templates/page.html") || !strings.Contains(out, "+++ b/templates/page.html") {
		t.Errorf("a dry run shows a unified diff:\n%s", out)
	}
	for f, body := range readTree(t, dir) {
		if before[f] != body {
			t.Errorf("the dry run wrote %s", f)
		}
	}

	// the learning: no flag at all
	code, _, errs = runMigrateCLI(t, dir, "--write", ".")
	if code != 0 || errs != "" {
		t.Fatalf("exit %d: %s", code, errs)
	}
	after := readTree(t, dir)
	golden := "testdata/migrate/out"
	if os.Getenv("UPDATE_GOLDEN") != "" {
		os.RemoveAll(golden)
		for f, body := range after {
			write(t, golden, f, body)
		}
	}
	want := readTree(t, golden)
	for f, body := range after {
		if want[f] != body {
			t.Errorf("%s differs from %s/%s; run UPDATE_GOLDEN=1 go test ./internal/check after a deliberate change\n--- got\n%s", f, golden, f, body)
		}
	}
	for f := range want {
		if _, ok := after[f]; !ok {
			t.Errorf("%s is in the golden tree and not in the result", f)
		}
	}
	// never touched: dependencies, the files of the legacy markup, minified files, native and unrelated files
	for _, f := range []string{"node_modules/lib/x.js", "static/acme-sse.js", "static/bolt.min.js", "templates/native.html", "false/positives.html"} {
		if after[f] != before[f] {
			t.Errorf("%s must not change", f)
		}
	}
	// idempotent: a second run changes nothing
	code, out, _ = runMigrateCLI(t, dir, "--write", ".")
	if code != 0 {
		t.Fatal(out)
	}
	for f, body := range readTree(t, dir) {
		if after[f] != body {
			t.Errorf("the second run changed %s", f)
		}
	}
	if !strings.Contains(out, "0 of ") {
		t.Errorf("the second run reports no change:\n%s", out)
	}
}

func TestMigrateJSONSchema(t *testing.T) {
	dir := t.TempDir()
	copyTree(t, "testdata/migrate/in", dir)
	code, out, _ := runMigrateCLI(t, dir, "--json", ".")
	if code != 0 {
		t.Fatal(out)
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal([]byte(out), &top); err != nil {
		t.Fatal(err)
	}
	keys := []string{}
	dec := json.NewDecoder(strings.NewReader(out))
	dec.Token()
	for dec.More() {
		k, _ := dec.Token()
		keys = append(keys, k.(string))
		var skip json.RawMessage
		dec.Decode(&skip)
	}
	if got := strings.Join(keys, ","); got != "schema,tool,rulesVersion,mode,line,legacy,scanned,summary,files,unconverted,skipped,warnings" {
		t.Errorf("top keys %s", got)
	}
	var rep MigrateReport
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatal(err)
	}
	if rep.Schema != 1 || rep.Tool != "ypy-migrate" || rep.Mode != "dry-run" {
		t.Errorf("header: %+v", rep)
	}
	if got := strings.Join(rep.Legacy.AttributePrefixes, ","); got != "acme" {
		t.Errorf("attribute prefixes %q", got)
	}
	if got := strings.Join(rep.Legacy.HeaderPrefixes, ","); got != "acme" {
		t.Errorf("header prefixes %q", got)
	}
	if got := strings.Join(rep.Legacy.Identifiers, ","); got != bolt {
		t.Errorf("identifiers %q", got)
	}
	if rep.Summary.Files == 0 || rep.Summary.Replacements == 0 || rep.Summary.Files != len(rep.Files) {
		t.Errorf("summary %+v", rep.Summary)
	}
	total := 0
	for k, n := range rep.Summary.ByKind {
		if !contains(Kinds, k) {
			t.Errorf("unknown kind %s", k)
		}
		total += n
	}
	if total != rep.Summary.Replacements {
		t.Errorf("by kind adds up to %d, replacements %d", total, rep.Summary.Replacements)
	}
	for _, f := range rep.Files {
		if f.Diff == "" || f.Written || f.Replacements == 0 {
			t.Errorf("file %+v", f)
		}
	}
	if len(rep.Skipped) != 1 || !strings.Contains(rep.Skipped[0], "static/acme-sse.js") {
		t.Errorf("skipped %v", rep.Skipped)
	}
	// with --write the files are marked written and carry no diff
	_, out, _ = runMigrateCLI(t, dir, "--json", "--write", ".")
	var w MigrateReport
	json.Unmarshal([]byte(out), &w)
	if w.Mode != "write" {
		t.Errorf("mode %s", w.Mode)
	}
	for _, f := range w.Files {
		if !f.Written || f.Diff != "" {
			t.Errorf("file %+v", f)
		}
	}
}

func TestMigratePrefixesAreLearnedByShape(t *testing.T) {
	learn := func(files map[string]string, args ...string) LegacyInfo {
		dir := t.TempDir()
		for f, body := range files {
			write(t, dir, f, body)
		}
		_, out, _ := runMigrateCLI(t, dir, append([]string{"--json", "."}, args...)...)
		var rep MigrateReport
		if err := json.Unmarshal([]byte(out), &rep); err != nil {
			t.Fatal(err)
		}
		return rep.Legacy
	}
	if got := learn(map[string]string{"a.html": `<button acme-get="/x" acme-target="#o">x</button>`}); strings.Join(got.AttributePrefixes, ",") != "acme" {
		t.Errorf("two names: %v", got)
	}
	if got := learn(map[string]string{"a.html": `<button acme-get="/x">x</button>`}); strings.Join(got.AttributePrefixes, ",") != "acme" {
		t.Errorf("a verb with a URL is proof alone: %v", got)
	}
	if got := learn(map[string]string{"a.html": `<button acme-boost="true">x</button>`}); len(got.AttributePrefixes) != 0 {
		t.Errorf("one weak name is not enough: %v", got)
	}
	if got := learn(map[string]string{"a.html": `<button acme-boost="true">x</button>`}, "--min-evidence", "1"); strings.Join(got.AttributePrefixes, ",") != "acme" {
		t.Errorf("--min-evidence: %v", got)
	}
	if got := learn(map[string]string{"a.html": `<b x-on:click="a" x-target="b" data-get="/x" data-select="c">x</b>`}); len(got.AttributePrefixes) != 0 {
		t.Errorf("other frameworks and data- attributes are not a prefix: %v", got)
	}
	if got := learn(map[string]string{"a.html": `<p>re-select and re-target, auto-post it, pre-trigger</p>`}); len(got.AttributePrefixes) != 0 {
		t.Errorf("prose is not a prefix: %v", got)
	}
	if got := learn(map[string]string{"a.go": "package p\n\nvar _ = r.Header.Get(\"ACME-Request\")\n"}); strings.Join(got.HeaderPrefixes, ",") != "acme" {
		t.Errorf("a header read by the server: %v", got)
	}
	if got := learn(map[string]string{"a.go": "package p\n\nvar _ = r.Header.Get(\"X-Request-Id\")\nvar _ = w.Header().Set(\"X-Target\", \"1\")\n"}); len(got.HeaderPrefixes) != 0 {
		t.Errorf("X-Request-Id and one X- header are not a prefix: %v", got)
	}
	if got := learn(map[string]string{"a.html": `<p>x</p>`}, "--prefix", "zed", "--header-prefix", "ZED"); strings.Join(got.AttributePrefixes, ",") != "zed" || strings.Join(got.HeaderPrefixes, ",") != "zed" {
		t.Errorf("forced: %v", got)
	}
	if got := learn(map[string]string{"a.html": `<p>x</p>`}, "--prefix", "zed-"); strings.Join(got.AttributePrefixes, ",") != "zed" {
		t.Errorf("a trailing hyphen is accepted: %v", got)
	}
}

func TestMigrateCLIErrors(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "a.html", "<p>x</p>")
	for _, args := range [][]string{{"--line", "v9"}, {"--prefix", "data"}, {"--prefix", "Not Valid"}, {"--header-prefix", "ypy"}, {"--bogus"}, {"/does/not/exist"}} {
		if code, _, errs := runMigrateCLI(t, dir, args...); code != 2 || errs == "" {
			t.Errorf("%v: exit %d, stderr %q", args, code, errs)
		}
	}
	if code, out, _ := runMigrateCLI(t, dir, "--help"); code != 0 || !strings.Contains(out, "--write") || !strings.Contains(out, "ypy.min.js") {
		t.Errorf("help: %d %s", code, out)
	}
	if code, out, _ := runMigrateCLI(t, dir, "--version"); code != 0 || !strings.Contains(out, "ypy-migrate rules") {
		t.Errorf("version: %d %s", code, out)
	}
}

func TestMigrateSkipsVendoredBinaryAndHugeFiles(t *testing.T) {
	dir := t.TempDir()
	body := `<button acme-get="/x" acme-target="#o">x</button>`
	write(t, dir, "node_modules/x/a.html", body)
	write(t, dir, "vendor/a.html", body)
	write(t, dir, ".git/a.html", body)
	write(t, dir, "dist/a.html", body)
	write(t, dir, "a.min.js", "acme-get")
	write(t, dir, "bin.html", body+"\x00\x01")
	write(t, dir, "ok.html", body)
	if code, _, errs := runMigrateCLI(t, dir, "--write", "."); code != 0 {
		t.Fatalf("exit %d: %s", code, errs)
	}
	for _, f := range []string{"node_modules/x/a.html", "vendor/a.html", ".git/a.html", "dist/a.html", "a.min.js"} {
		if b, _ := os.ReadFile(filepath.Join(dir, f)); strings.Contains(string(b), "ypy-") {
			t.Errorf("%s was converted", f)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "bin.html")); strings.Contains(string(b), "ypy-") {
		t.Error("a binary file was converted")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "ok.html")); !strings.Contains(string(b), "ypy-get") {
		t.Error("ok.html was not converted")
	}
}

func TestMigrateKeepsTheFileMode(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, "run.php", `<div acme-get="/x" acme-target="#o"></div>`)
	os.Chmod(p, 0o755)
	runMigrateCLI(t, dir, "--write", ".")
	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o755 {
		t.Errorf("mode %v", st.Mode().Perm())
	}
}

func TestUnifiedDiff(t *testing.T) {
	a := "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n"
	b := strings.Replace(strings.Replace(a, "two", "2", 1), "eleven", "11\nextra", 1)
	d := unifiedDiff("f.txt", a, b)
	for _, want := range []string{"--- a/f.txt\n", "+++ b/f.txt\n", "@@ -1,5 +1,5 @@", "-two\n", "+2\n", "-eleven\n", "+11\n", "+extra\n"} {
		if !strings.Contains(d, want) {
			t.Errorf("diff lacks %q:\n%s", want, d)
		}
	}
	if strings.Count(d, "@@ ") != 2 {
		t.Errorf("two hunks expected:\n%s", d)
	}
	if unifiedDiff("f", a, a) != "" {
		t.Error("no diff for equal texts")
	}
}

func TestLegacyTextOfTheRuleTableNeverNamesThePrefixes(t *testing.T) {
	rs := mustRules(t)
	letters := string([]byte{'h', 'x'}) // the two letters of the old prefix, not written as a word
	for _, r := range rs.Rules {
		for _, s := range []string{r.What, r.Fix, r.Native, r.Match.Name, strings.Join(r.Match.Names, " "), r.Match.NameRegex, r.Match.Regex} {
			if strings.Contains(strings.ToLower(s), letters) {
				t.Errorf("%s names a prefix: %q", r.ID, s)
			}
		}
	}
}
