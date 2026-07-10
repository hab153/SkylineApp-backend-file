const EmailAccount = require('./EmailAccount');
const crypto = require('crypto');
const axios = require('axios');

exports.getAuthUrl = async (req, res) => {
  try {
    const userId = req.userId;
    
    // 1. Create State
    const stateObj = {
      userId: userId,
      nonce: crypto.randomBytes(16).toString('hex')
    };
    const stateString = Buffer.from(JSON.stringify(stateObj)).toString('base64');

    // 2. Build BOTH URLs
    const clientId = process.env.NYLAS_CLIENT_ID;
    const redirectUri = encodeURIComponent(process.env.NYLAS_REDIRECT_URI);
    const scopeV2 = encodeURIComponent("email.read_only email.send email.modify offline_access");
    const scopeV3 = encodeURIComponent("email:read email:send email:modify");
    
    // Try V2 first (more stable)
    const authUrlV2 = `https://api.nylas.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scopeV2}&state=${stateString}`;
    
    // Fallback to V3
    const authUrlV3 = `https://api.us.nylas.com/v3/connect/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scopeV3}&state=${stateString}&access_type=offline&provider=google`;

    // ✅ Use V2 by default
    console.log('✅ [Nylas Auth] V2 URL generated');
    console.log('🔗 V2 URL:', authUrlV2);
    console.log('🔗 V3 URL (fallback):', authUrlV3);
    
    // Try V2 first
    res.json({ url: authUrlV2, version: 'v2' });
    
  } catch (error) {
    console.error('❌ [Nylas Auth] Error:', error);
    res.status(500).json({ 
      message: 'Failed to generate authentication link.', 
      error: error.message 
    });
  }
};

exports.handleCallback = async (req, res) => {
  try {
    const code = req.query.code;
    const stateString = req.query.state; 
    const error = req.query.error;

    if (error) {
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=${encodeURIComponent(error)}`);
    }

    if (!code || !stateString) {
      return res.status(400).send("Missing code or state");
    }

    let userId;
    try {
      const decodedState = JSON.parse(Buffer.from(stateString, 'base64').toString());
      userId = decodedState.userId;
    } catch (e) {
      return res.status(400).send("Invalid state parameter");
    }

    console.log('🔍 [Nylas Callback] Exchanging code for token using V2...');

    // ✅ Use V2 token exchange
    const response = await axios.post('https://api.nylas.com/oauth/token', {
      client_id: process.env.NYLAS_CLIENT_ID,
      client_secret: process.env.NYLAS_API_KEY,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: process.env.NYLAS_REDIRECT_URI
    });
    
    console.log('✅ [Nylas Callback] Token exchange successful');
    
    const { access_token, refresh_token, expires_in } = response.data;

    // Save to Database
    await EmailAccount.findOneAndUpdate(
      { userId: userId },
      {
        nylasGrantId: 'v2_' + userId,
        isConnected: true,
        accessToken: access_token,
        refreshToken: refresh_token,
        tokenExpiry: new Date(Date.now() + (expires_in * 1000))
      },
      { upsert: true, new: true }
    );

    console.log('✅ [Nylas Callback] Account saved for User:', userId);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=success`);

  } catch (error) {
    console.error('❌ [Nylas Callback] Error:', error.message);
    console.error('❌ Full Error:', error.response?.data || error);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=${encodeURIComponent(error.message)}`);
  }
};
