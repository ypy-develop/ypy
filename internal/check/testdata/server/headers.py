def save(request):
    source = request.headers.get("ACME-Trigger")  # expect: V2-HEADER-REQ-TRIGGER
    legacy = request.META["HTTP_ACME_TARGET"]  # expect: V2-HEADER-REQ-TARGET
    response = HttpResponse("ok")
    response["ACME-Trigger"] = "saved"
    response["ACME-Trigger-After-Swap"] = "flash"  # expect: V2-HEADER-TRIGGER-AFTER-SWAP
    return response
