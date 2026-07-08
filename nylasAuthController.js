const nylas = require('./nylasClient');
const EmailAccount = require('./EmailAccount');

exports.getAuthUrl = async (req, res) => {
  try {
    const redirectUri = process.env.NYLAS_REDIRECT_URI;
    const clientId = process.env.NYLAS_CLIENT_ID;

    console.log('🔍 [Nylas Auth] Generating URL with:', { clientId, redirectUri });
    console.log('🔍 [Nylas Auth] Nylas object keys:', Object.keys(nylas));

    if (!clientId || !redirectUri) {
      throw new Error('Missing NYLAS_CLIENT_ID or NYLAS_REDIRECT_URI in environment variables.');
    }

    // Try different ways to access the auth method depending on SDK version
    let authUrl;
    
    // Method 1: Standard v6 way
    if (nylas.auth && typeof nylas.auth.urlForOAuth2 === 'function') {
      authUrl = nylas.auth.urlForOAuth2({
        clientId: clientId,
        redirectUri: redirectUri,
        scopes: ['https://api.nylas.com/send', 'https://api.nylas.com/read'],
      });
    } 
    // Method 2: Fallback for some v6 implementations
    else if (typeof nylas.urlForAuthentication === 'function') {
       authUrl = nylas.urlForAuthentication({
        clientId: clientId,
        redirectUri: redirectUri,
        scopes: ['https://api.nylas.com/send', 'https://api.nylas.com/read'],
      });
    }
    else {
      throw new Error('Nylas SDK auth method not found. Check SDK version.');
    }

    console.log('✅ [Nylas Auth] URL generated successfully');
    res.json({ url: authUrl });
  } catch (error) {
    console.error('❌ [Nylas Auth] Error generating URL:', error);
    res.status(500).json({ message: 'Failed to generate authentication link.', error: error.message });
  }
};

exports.handleCallback = async (req, res) => {
  try {
    const { code } = req.query;
    const userId = req.userId; 

    if (!code) return res.status(400).json({ message: 'Authorization code missing.' });

    console.log('🔍 [Nylas Callback] Exchanging code for tokens...');

    // Exchange code for tokens using v6 SDK
    const response = await nylas.auth.exchangeCodeForToken({
      clientId: process.env.NYLAS_CLIENT_ID,
      clientSecret: process.env.NYLAS_CLIENT_SECRET, 
      redirectUri: process.env.NYLAS_REDIRECT_URI,
      code: code,
    });
    
    console.log('✅ [Nylas Callback] Tokens received. Grant ID:', response.grant_id);

    // Save or Update the EmailAccount in MongoDB
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
