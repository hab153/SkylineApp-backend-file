const nylas = require('./nylasClient');
const EmailAccount = require('./EmailAccount');

exports.getAuthUrl = async (req, res) => {
  try {
    const redirectUri = process.env.NYLAS_REDIRECT_URI;
    const clientId = process.env.NYLAS_CLIENT_ID;

    if (!clientId || !redirectUri) {
      throw new Error('Missing NYLAS_CLIENT_ID or NYLAS_REDIRECT_URI.');
    }

    // Use the v8 SDK helper which now knows the correct apiUri
    const authUrl = nylas.auth.urlForOAuth2({
      clientId: clientId,
      redirectUri: redirectUri,
      provider: 'google', // Explicitly set provider
      scopes: ['https://api.nylas.com/send', 'https://api.nylas.com/read'],
    });

    console.log('✅ [Nylas Auth] URL generated via SDK:', authUrl);
    res.json({ url: authUrl });
  } catch (error) {
    console.error('❌ [Nylas Auth] Error:', error);
    res.status(500).json({ message: 'Failed to generate authentication link.', error: error.message });
  }
};

exports.handleCallback = async (req, res) => {
  try {
    const { code } = req.query;
    const userId = req.userId; 

    if (!code) return res.status(400).json({ message: 'Authorization code missing.' });

    console.log('🔍 [Nylas Callback] Exchanging code...');

    // Exchange code for tokens using v8 SDK
    // NOTE: No clientSecret needed here as the API Key is already in the client instance
    const response = await nylas.auth.exchangeCodeForToken({
      clientId: process.env.NYLAS_CLIENT_ID,
      redirectUri: process.env.NYLAS_REDIRECT_URI,
      code: code,
    });
    
    console.log('✅ [Nylas Callback] Success. Grant ID:', response.grant_id);

    await EmailAccount.findOneAndUpdate(
      { userId },
      {
        nylasGrantId: response.grant_id,
        emailAddress: response.email,
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        tokenExpiry: new Date(Date.now() + response.expires_in * 1000),
        isConnected: true,
        provider: 'gmail' 
      },
      { upsert: true, new: true }
    );

    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=success`);
  } catch (error) {
    console.error('❌ [Nylas Callback] Error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=error`);
  }
};
