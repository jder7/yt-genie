/**
 * auth.js — Google Identity Services (GIS) OAuth 2.0 integration
 *
 * Handles login/logout and access token management for the
 * YouTube Data API v3.
 */

const Auth = (() => {
  const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
  const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest';

  let tokenClient = null;
  let accessToken = null;
  let userProfile = null;
  let onAuthChange = null; // callback(isLoggedIn, profile)

  /**
   * Load the GIS client script dynamically and return a promise.
   */
  function loadGisScript() {
    return new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
      document.head.appendChild(script);
    });
  }

  /**
   * Load the Google API client (gapi) for discovery docs.
   */
  function loadGapiScript() {
    return new Promise((resolve, reject) => {
      if (window.gapi) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://apis.google.com/js/api.js';
      script.async = true;
      script.defer = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Failed to load GAPI'));
      document.head.appendChild(script);
    });
  }

  /**
   * Initialize the token client. Must be called once with the client ID.
   */
  async function init(clientId, authChangeCallback) {
    onAuthChange = authChangeCallback;

    await Promise.all([loadGisScript(), loadGapiScript()]);

    // Init gapi client
    await new Promise((resolve, reject) => {
      gapi.load('client', { callback: resolve, onerror: reject });
    });
    await gapi.client.init({});
    await gapi.client.load(DISCOVERY_DOC);

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: handleTokenResponse,
    });
  }

  /**
   * Handle the token response from GIS.
   */
  async function handleTokenResponse(response) {
    if (response.error) {
      console.error('Auth error:', response);
      onAuthChange?.(false, null);
      return;
    }

    accessToken = response.access_token;
    gapi.client.setToken({ access_token: accessToken });

    // Fetch user profile info
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      userProfile = await res.json();
    } catch (e) {
      userProfile = { name: 'YouTube User' };
    }

    onAuthChange?.(true, userProfile);
  }

  /**
   * Request login (prompt user).
   */
  function login() {
    if (!tokenClient) {
      throw new Error('Auth not initialized. Call Auth.init(clientId) first.');
    }
    tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  /**
   * Revoke token and log out.
   */
  function logout() {
    if (accessToken) {
      google.accounts.oauth2.revoke(accessToken);
      accessToken = null;
      userProfile = null;
      gapi.client.setToken(null);
      onAuthChange?.(false, null);
    }
  }

  /**
   * Get the current access token (or null).
   */
  function getToken() {
    return accessToken;
  }

  function getProfile() {
    return userProfile;
  }

  function isLoggedIn() {
    return !!accessToken;
  }

  return { init, login, logout, getToken, getProfile, isLoggedIn };
})();
