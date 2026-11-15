//go:build kyse

package components

@go
// Props carries the attributes: AcmeGet is the URL.
type Props struct {
	AcmeGet    string
	AcmeTarget string
}
@endgo

<button
	@if(.AcmeGet != "")
		acme-get="{{ .AcmeGet }}"
	@endif
	acme-target="{{ .AcmeTarget }}"
	class="bolt-indicator"
>{{ .Label }}</button>
