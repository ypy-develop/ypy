package views

@go
type ItemsProps struct {
	Items []Item
	Admin bool
}

func (p ItemsProps) Big() bool { return len(p.Items) < 3 }
@endgo

<meta name="bolt-config" content='{"defaultSwapStyle": "outerHTML"}'> {{-- expect: V2-CONFIG-DEFAULT-SWAP-STYLE --}}
<script src="/static/ext/sse.js"></script> <!-- expect: V2-SCRIPT-EXTENSION -->
<div id="out"></div>
<div acme-target="#out" acme-swap="innerHTML show:#top:top"> <!-- expect: V2-INHERIT-IMPLICIT, V2-SWAP-SHOW-SYNTAX -->
	@for(_, it := range .Items)
	<button
		class="{{ it.Class("btn") }}"
		acme-get="/items/{{ it.ID }}"
		acme-vars="id:{{ it.ID }}" {{-- expect: V2-ATTR-VARS --}}
		@if(it.Disabled && .Admin != "x")
			disabled
		@endif
		@attributes(it.Attrs())
	>{{ it.Name }}</button>
	@endfor
	@if(.Admin)<button acme-get="/admin" acme-disabled-elt="this">Go</button>@endif <!-- expect: V2-ATTR-DISABLED-ELT -->
</div>
<form acme-post="{{ .SaveURL }}" acme-on::configRequest="tweak(event)"> <!-- expect: V2-EVENT-CONFIG-REQUEST -->
	<input name="q" acme-on:bolt:afterSwap="done()"> <!-- expect: V2-EVENT-AFTER-SWAP -->
</form>
<p acme-disable>Raw <b acme-get="/x">text</b></p> <!-- expect: V2-ATTR-DISABLE -->
<div sse-connect="{{ .Stream }}" sse-swap="message"></div> <!-- expect: V2-EXT-SSE-CONNECT, V2-EXT-SSE-SWAP -->
<script>
	document.body.addEventListener('bolt:responseError', fn) // expect: V2-EVENT-RESPONSE-ERROR
	bolt.addClass(el, 'on') // expect: V2-API-ADD-CLASS
</script>
