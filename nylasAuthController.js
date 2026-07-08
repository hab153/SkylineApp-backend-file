const Nylas = require('./nylasClient');
const EmailAccount = require('./models/EmailAccount');
const User = require('./models/User');

exports.getAuthUrl = async (req, res) => {
  try {
    const redirectUri = process.env.NYLAS_REDIRECT_URI;
    const clientId = process.env.NYLAS_CLIENT_ID;

    // Generate the OAuth URL for the user to connect their email
    const authUrl = Nylas.urlForAuthentication({
      clientId: clientId,
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
    const userId = req.userId; // From authMiddleware

    if (!code) return res.status(400).json({ message: 'Authorization code missing.' });

    // Exchange code for tokens
    const response = await Nylas.exchangeCodeForToken(code);
    
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
        provider: 'gmail' // Defaulting to gmail, can be dynamic based on response
      },
      { upsert: true, new: true }
    );

    // Redirect back to frontend dashboard
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=success`);
  } catch (error) {
    console.error('Nylas Callback Error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=error`);
  }
};
