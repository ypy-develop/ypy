app.get('/x', (req, res) => {
  if (req.get('ACME-Request') === 'true') res.set('ACME-Refresh', 'true');
  res.vary('ACME-Request');
});
