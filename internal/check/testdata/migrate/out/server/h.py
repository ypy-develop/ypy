def view(request, resp):
    if request.META.get('HTTP_YPY_REQUEST') == 'true' or request.headers['YPY-Target']:
        resp['YPY-Redirect'] = '/x'
        resp['Vary'] = 'YPY-Request'
    is_ypy_request = request.headers.get('YPY-Request')
