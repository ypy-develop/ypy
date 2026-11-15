---
name: ypy-native
description: Make a YPY app run inside a native shell (iOS, Android, desktop web view) with the same server-rendered pages. Use when the request is to "put the site in an app", "native navigation with the same HTML", "show a native menu or date picker instead of the web one", "the server must know it is in the app", "hide the web header in the app", "a path configuration", "pull to refresh in the shell", or when markup has ypy-native-component, ypy-native-hide, ypy-native-only, or a handler reads YPY-Native. Covers loading the ypy-native extension, the three signals the server reads, the path configuration document, native components in markup, the Go handlers, and what the shell must do. Not for writing the Swift or Kotlin shell.
license: MIT
---

# A native shell around YPY pages

A shell is a small native app that owns the stack, the tab bar and the modals, and
shows each screen in a web view that loads the page the server renders. YPY gives
the web half: the extension `ypy-native` and, in the Go SDK, the helpers. The page
stays valid HTML in a browser; nothing here changes how it works there.

## Load it

```html
<script src="/ypy.js"></script>
<script src="/ext/ypy-native.js"></script>
```

It is not in `ypy.max`: load it only in a page that has an app. The shell gives the
page `window.ypyNative` (`postMessage(string)` and `message` events); the extension
speaks only after the handshake `load` -> `hello` -> `ready`, and every message is
JSON data that nothing evaluates.

## The server learns it is an app

1. The user agent ends with `YpyNative/<n> (<platform>)`. It is on every request of the web view, the first load included.
2. After the handshake every same-origin YPY request carries `YPY-Native: <platform>; v=<n>; caps=<a,b>`.
3. The root element has `data-ypy-native="<platform>"`, so CSS can adapt.

Decide on `caps`, never on the version: an old app build must keep working. Send
`Vary: YPY-Native, User-Agent` on every answer whose HTML depends on it.

```go
mux.Handle("/", ypy.NativeMiddleware(app))       // adds the Vary header

func orders(w http.ResponseWriter, r *http.Request) {
	q := ypy.FromRequest(r)
	if q.Native.Has("date-picker") { /* render the hook for the native picker */ }
	if q.IsNative() { /* drop the web header */ }
}
```

In a test: `ypytest.NewRequest("GET", "/orders", ypytest.Native("ios", 1, "menu"))` and `res.AssertVaryNative(t)`.

## Path configuration

The shell does not hard-code routes. It reads one JSON document at launch and on
resume, keeps its `ETag`, and ships a copy in the app. Serve it from
`ypy.NativePathConfigPath` (`/.well-known/ypy-native.json`):

```go
cfg := ypy.PathConfig{Version: 1, Rules: []ypy.PathRule{
	{Patterns: []string{`^/orders/new$`}, Properties: ypy.PathProperties{Context: ypy.ContextModal}},
	{Patterns: []string{`^/signin$`}, Properties: ypy.PathProperties{Presentation: ypy.PresentReplaceRoot}},
}}
h, err := cfg.Handler() // validates, then serves with ETag and 304
mux.Handle("GET "+ypy.NativePathConfigPath, h)
```

For one URL every matching rule applies in order and a later property wins; an
unknown property is ignored. Patterns are regular expressions over path plus query,
so keep to the subset Go, Swift, Kotlin and JavaScript share. `presentation: none`
leaves the route to YPY inside the page.

## Visits

A boosted link or form, `YPY-Location` to the main target, and a post that ends in a
redirect are visits: the request is not made, the shell gets `visit {url, action,
source}` and applies the path configuration. Fragment requests are not visits and
keep swapping. Steer from the server with
`ypy.NativeNavigate(w, "/orders", ypy.NavigateReplace)` (a `YPY-Trigger` of
`ypy:native:navigate`); a browser swaps the page instead. Cancel
`ypy:native:before:visit` to keep one navigation in the page. The shell owns the
history, so the page writes none while it is in the app.

## Native components in markup

```html
<header ypy-native-hide>web header</header>
<button ypy-native-component="share" ypy-native-props='{"url":"/orders/1"}' ypy-native-click>Share</button>
<p ypy-native-only>Tap the bar to scan.</p>
```

- `ypy-native-component` names a component that the app's `caps` list; otherwise nothing is asked and the element is the fallback.
- `ypy-native-props` is one JSON object of at most 2 KiB, data only.
- `ypy-native-hide` hides the element in the app and makes it `inert`; `ypy-native-only` does the reverse in a browser.
- `ypy-native-click`: a native `action` clicks the element. Other events are `ypy:native:event` on the element (cancelable).

## Safety

Anyone who can put markup in a page can write `ypy-native-*`. Load `ypy-csp` so only
attributes the server stamped count, and add `ypy-native-*` and `data-ypy-native-*`
to the deny list of every sanitizer of user-written HTML. The shell keeps an
allowlist of component names and asks for a user gesture before a sensitive action.
Authentication stays in the cookie jar: no token goes in a URL or a message.

## Check

```sh
go run ./cmd/ypy test test/tests/ext/ypy-native.js
```

An app test drives the extension with a fake channel: `ypy.native.connect(fake)` and
`fake.emit({type:'hello', v:1, platform:'ios', caps:['menu'], nonce:'n'})`.
