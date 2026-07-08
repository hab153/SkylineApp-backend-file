const nylas = require('./nylasClient');
const EmailAccount = require('./EmailAccount');

exports.getAuthUrl = async (req, res) => {
  try {
    const redirectUri = process.env.NYLAS_REDIRECT_URI;
    
    // Generate the OAuth URL using the v6 SDK
    const authUrl = nylas.auth.urlForOAuth2({
      clientId: process.env.NYLAS_CLIENT_ID,
      redirectUri: redirectUri,
      scopes: ['https://api.nylas.com/send', 'https://api.nylas.com/read'],
    });

    res.json({ url: authUrl });
  } catch (error) {
    console.error('Error generating Nylas Auth URL:', error);
    res.status(500).json({ message: 'Failed to generate authentication link.' });
  }
};

exports.handleCallback = async (req, res) => {
  try {
    const { code } = req.query;
    const userId = req.userId; 

    if (!code) return res.status(400).json({ message: 'Authorization code missing.' });

    // Exchange code for tokens using v6 SDK
    const response = await nylas.auth.exchangeCodeForToken({
      clientId: process.env.NYLAS_CLIENT_ID,
      clientSecret: process.env.NYLAS_CLIENT_SECRET, 
      redirectUri: process.env.NYLAS_REDIRECT_URI,
      code: code,
    });
    
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
    console.error('Nylas Callback Error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=error`);
  }
};
