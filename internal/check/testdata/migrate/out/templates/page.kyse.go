//go:build kyse

package components

@go
// Props carries the attributes: YpyGet is the URL.
type Props struct {
	YpyGet    string
	YpyTarget string
}
@endgo

<button
	@if(.YpyGet != "")
		ypy-get="{{ .YpyGet }}"
	@endif
	ypy-target="{{ .YpyTarget }}"
	class="ypy-indicator"
>{{ .Label }}</button>
