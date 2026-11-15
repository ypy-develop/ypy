package handlers

import "net/http"

// Props are the attributes of a control.
type Props struct{ AcmeTarget, AcmeGet string }

// reads ACME-Request here
func H(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("ACME-Request") == "true" && r.Header.Get("ACME-History-Restore-Request") != "true" {
		w.Header().Set("Vary", "ACME-Request, ACME-History-Restore-Request")
		w.Header().Set("ACME-Trigger", `{"saved": true}`)
		w.Header().Add("ACME-Push-Url", "/x")
	}
	_ = "\tacme-get=\"x\"\n"
	_ = Props{AcmeTarget: "x"}
	_ = r.Header.Get("X-Request-Id")
}
