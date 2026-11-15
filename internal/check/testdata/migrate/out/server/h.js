app.get('/x', (req, res) => {
  if (req.get('YPY-Request') === 'true') res.set('YPY-Refresh', 'true');
  res.vary('YPY-Request');
});
