const nylas = require('./nylasClient');
const EmailAccount = require('./EmailAccount');

exports.getAuthUrl = async (req, res) => {
  try {
    const redirectUri = process.env.NYLAS_REDIRECT_URI;
    const clientId = process.env.NYLAS_CLIENT_ID;

    if (!clientId || !redirectUri) {
      throw new Error('Missing NYLAS_CLIENT_ID or NYLAS_REDIRECT_URI.');
    }

    // ✅ CRITICAL FIX: Build auth URL with response_type=code explicitly
    // This is required by Nylas OAuth v3 - without it, you get a 400 error:
    // "You must include 'response_type' and the value must be 'code'."
    const authUrl = `https://api.us.nylas.com/v3/connect/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent('mail.read mail.send')}`;

    console.log('✅ [Nylas Auth] Auth URL generated with response_type=code');
    console.log('📍 [Nylas Auth] Redirect URI:', redirectUri);
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

    if (!code) {
      console.error('❌ [Nylas Callback] No authorization code in query');
      return res.status(400).json({ message: 'Authorization code missing.' });
    }

    console.log('🔍 [Nylas Callback] Exchanging code for token...');

    // ✅ Exchange code for tokens using Nylas v8 SDK
    const response = await nylas.auth.exchangeCodeForToken({
      clientId: process.env.NYLAS_CLIENT_ID,
      clientSecret: process.env.NYLAS_CLIENT_SECRET,
      redirectUri: process.env.NYLAS_REDIRECT_URI,
      code: code,
    });
    
    console.log('✅ [Nylas Callback] Token exchanged successfully');
    console.log('📊 [Nylas Callback] Grant ID:', response.grant_id);
    console.log('📊 [Nylas Callback] Email:', response.email);

    // ✅ Save email account to database
    const emailAccount = await EmailAccount.findOneAndUpdate(
      { userId },
      {
        nylasGrantId: response.grant_id,
        emailAddress: response.email,
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        tokenExpiry: new Date(Date.now() + (response.expires_in * 1000)),
        isConnected: true,
        provider: response.email.includes('gmail') ? 'gmail' : 'outlook'
      },
      { upsert: true, new: true }
    );

    console.log('✅ [Nylas Callback] Email account saved to database');
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=success`);
  } catch (error) {
    console.error('❌ [Nylas Callback] Error:', error.message);
    console.error('❌ [Nylas Callback] Full error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=${encodeURIComponent(error.message)}`);
  }
};
