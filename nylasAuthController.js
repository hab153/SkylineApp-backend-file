const nylas = require('./nylasClient');
const EmailAccount = require('./EmailAccount');

exports.getAuthUrl = async (req, res) => {
  try {
    const authUrl = nylas.auth.urlForOAuth2({
      clientId: process.env.NYLAS_CLIENT_ID,
      redirectUri: process.env.NYLAS_REDIRECT_URI,
      provider: "google",
      loginHint: "enter-email-address-here",
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
      return res.status(400).json({ message: 'No authorization code returned from Nylas' });
    }

    console.log('🔍 [Nylas Callback] Exchanging code for token...');

    const codeExchangeResponse = await nylas.auth.exchangeCodeForToken({
      redirectUri: process.env.NYLAS_REDIRECT_URI,
      clientId: process.env.NYLAS_CLIENT_ID,
      clientSecret: process.env.NYLAS_API_KEY,
      code: code,
    });

    const { grantId } = codeExchangeResponse;

    console.log('✅ [Nylas Callback] Grant ID:', grantId);

    const emailAccount = await EmailAccount.findOneAndUpdate(
      { userId },
      {
        nylasGrantId: grantId,
        emailAddress: codeExchangeResponse.email,
        isConnected: true,
      },
      { upsert: true, new: true }
    );

    console.log('✅ [Nylas Callback] Email account saved');
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=success`);
  } catch (error) {
    console.error('❌ [Nylas Callback] Error:', error.message);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=${encodeURIComponent(error.message)}`);
  }
};
