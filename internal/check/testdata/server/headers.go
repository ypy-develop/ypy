package handlers

import "net/http"

func Save(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("ACME-Trigger") == "save-button" { // expect: V2-HEADER-REQ-TRIGGER
		w.Header().Set("ACME-Trigger", `{"saved": true}`)
	}
	target := r.Header.Get("ACME-Target")                // expect: V2-HEADER-REQ-TARGET
	name := r.Header.Get("ACME-Trigger-Name")            // expect: V2-HEADER-REQ-TRIGGER-NAME
	answer := r.Header.Get("ACME-Prompt")                // expect: V2-HEADER-REQ-PROMPT
	w.Header().Set("ACME-Trigger-After-Settle", "ready") // expect: V2-HEADER-TRIGGER-AFTER-SETTLE
	w.Header().Set("ACME-Retarget", "#errors")
	_, _, _ = target, name, answer
}
