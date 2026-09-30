// Runs in the visitor's browser before Home Assistant's frontend starts.
// Gives the frontend a placeholder login so it never redirects to /auth/authorize.
// The placeholder authenticates nobody: the server accepts any token on /api/websocket.
(function () {
  try {
    localStorage.setItem('hassTokens', JSON.stringify({
      access_token: 'public-access-placeholder',
      token_type: 'Bearer',
      expires_in: 1800,
      hassUrl: location.origin,
      clientId: location.origin + '/',
      expires: Date.now() + 10 * 365 * 24 * 3600 * 1000,
      refresh_token: 'public-access-placeholder',
    }));
  } catch (e) { /* storage blocked: the frontend will show its own login */ }
})();
