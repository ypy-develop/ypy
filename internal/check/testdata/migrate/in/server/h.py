def view(request, resp):
    if request.META.get('HTTP_ACME_REQUEST') == 'true' or request.headers['ACME-Target']:
        resp['ACME-Redirect'] = '/x'
        resp['Vary'] = 'ACME-Request'
    is_acme_request = request.headers.get('ACME-Request')
