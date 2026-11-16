// Starts a KTX2 (Basis) transcoder worker. The page sends the worker's code as the first message ('boot'): the
// same source three's KTX2Loader would put in a blob worker. A blob worker runs under the page's CSP, which forbids
// the string-to-code the transcoder's bindings need; this file is served with its own CSP that allows it here only.
self.addEventListener('message', function boot(e) {
  if (!e.data || e.data.type !== 'boot') return;
  self.removeEventListener('message', boot);
  (0, eval)(e.data.source);
});
