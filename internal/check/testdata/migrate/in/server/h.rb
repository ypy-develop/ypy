def fragment?
  request.headers['ACME-Request'] == 'true'
end
response.headers['ACME-Trigger'] = 'saved'
response.set_header('ACME-Location', '/x')
