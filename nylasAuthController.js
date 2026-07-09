const nylas = require('./nylasClient');
const EmailAccount = require('./EmailAccount');

exports.getAuthUrl = async (req, res) => {
  try {
    const authUrl = nylas.auth.urlForOAuth2({
      clientId: process.env.NYLAS_CLIENT_ID,
      provider: "google",
      redirectUri: process.env.NYLAS_REDIRECT_URI,
      accessType: "offline",
    });

    console.log('✅ [Nylas Auth] Auth URL generated');
    console.log('📍 [Nylas Auth] Redirect URI:', process.env.NYLAS_REDIRECT_URI);
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

    const codeExchangeResponse = nylas.auth.exchangeCodeForToken({
      redirectUri: process.env.NYLAS_REDIRECT_URI,
      clientId: process.env.NYLAS_CLIENT_ID,
      clientSecret: process.env.NYLAS_API_KEY,
      code: code,
    });
    
    const { grantId } = codeExchangeResponse;
    
    console.log('✅ [Nylas Callback] Token exchanged successfully');
    console.log('📊 [Nylas Callback] Grant ID:', grantId);

    // ✅ Save email account to database
    const emailAccount = await EmailAccount.findOneAndUpdate(
      { userId },
      {
        nylasGrantId: grantId,
        emailAddress: codeExchangeResponse.email,
        isConnected: true,
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
