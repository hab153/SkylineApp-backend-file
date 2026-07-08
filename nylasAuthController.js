const Nylas = require('./nylasClient');
const EmailAccount = require('./EmailAccount');

exports.getAuthUrl = async (req, res) => {
  try {
    const redirectUri = process.env.NYLAS_REDIRECT_URI;
    const clientId = process.env.NYLAS_CLIENT_ID;

    console.log('🔍 [Nylas Auth] Generating URL with:', { clientId, redirectUri });

    if (!clientId || !redirectUri) {
      throw new Error('Missing NYLAS_CLIENT_ID or NYLAS_REDIRECT_URI in environment variables.');
    }

    // Generate the OAuth URL using v5 SDK
    const authUrl = Nylas.urlForAuthentication({
      clientId: clientId,
      redirectUri: redirectUri,
      scopes: ['email.send', 'email.read_only'], // v5 uses simpler scope names
    });

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

    // Exchange code for tokens using v5 SDK
    // Note: In v5, this is done via a direct API call or the helper
    const response = await Nylas.exchangeCodeForToken(code, process.env.NYLAS_CLIENT_SECRET);
    
    console.log('✅ [Nylas Callback] Tokens received. Account ID:', response.account_id);

    // Save or Update the EmailAccount in MongoDB
    // Note: v5 returns account_id instead of grant_id
    await EmailAccount.findOneAndUpdate(
      { userId },
      {
        nylasGrantId: response.account_id, 
        emailAddress: response.email_address,
        accessToken: response.access_token,
        refreshToken: response.refresh_token, // v5 might not always return this depending on scopes
        tokenExpiry: new Date(Date.now() + 3600 * 1000), // Approximate expiry
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
