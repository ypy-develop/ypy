def fragment?
  request.headers['YPY-Request'] == 'true'
end
response.headers['YPY-Trigger'] = 'saved'
response.set_header('YPY-Location', '/x')
