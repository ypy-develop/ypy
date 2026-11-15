package handlers

import "net/http"

// Props are the attributes of a control.
type Props struct{ YpyTarget, YpyGet string }

// reads ACME-Request here
func H(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("YPY-Request") == "true" && r.Header.Get("YPY-History-Restore-Request") != "true" {
		w.Header().Set("Vary", "YPY-Request, YPY-History-Restore-Request")
		w.Header().Set("YPY-Trigger", `{"saved": true}`)
		w.Header().Add("YPY-Push-Url", "/x")
	}
	_ = "\typy-get=\"x\"\n"
	_ = Props{YpyTarget: "x"}
	_ = r.Header.Get("X-Request-Id")
}
