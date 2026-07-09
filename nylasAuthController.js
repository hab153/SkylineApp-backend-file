const nylas = require('./nylasClient');
const EmailAccount = require('./EmailAccount');

exports.getAuthUrl = async (req, res) => {
  try {
    const authUrl = nylas.auth.urlForOAuth2({
      clientId: process.env.NYLAS_CLIENT_ID,
      provider: "google",
      redirectUri: process.env.NYLAS_REDIRECT_URI,
      loginHint: "email_to_connect@example.com",
      accessType: "offline",
    });

    console.log('✅ [Nylas Auth] Auth URL generated:', authUrl);
    res.json({ url: authUrl });
  } catch (error) {
    console.error('❌ [Nylas Auth] Error:', error);
    res.status(500).json({ message: 'Failed to generate authentication link.', error: error.message });
  }
};

exports.handleCallback = async (req, res) => {
  try {
    const code = req.query.code;
    const userId = req.userId; 

    if (!code) {
      res.status(400).send("No authorization code returned from Nylas");
      return;
    }

    console.log('🔍 [Nylas Callback] Exchanging code for token...');

    const response = await nylas.auth.exchangeCodeForToken({
      clientId: process.env.NYLAS_CLIENT_ID,
      redirectUri: process.env.NYLAS_REDIRECT_URI,
      code: code,
    });
    
    const { grantId } = response;
    
    console.log('✅ [Nylas Callback] Token exchanged successfully');
    console.log('📊 [Nylas Callback] Grant ID:', grantId);

    const emailAccount = await EmailAccount.findOneAndUpdate(
      { userId },
      {
        nylasGrantId: grantId,
        isConnected: true,
      },
      { upsert: true, new: true }
    );

    console.log('✅ [Nylas Callback] Email account saved to database');
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=success`);
  } catch (error) {
    console.error('❌ [Nylas Callback] Error:', error.message);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=${encodeURIComponent(error.message)}`);
  }
};
