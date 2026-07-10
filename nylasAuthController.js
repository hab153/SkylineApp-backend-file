const EmailAccount = require('./EmailAccount');
const crypto = require('crypto');

exports.getAuthUrl = async (req, res) => {
  try {
    const userId = req.userId; 
    
    // 1. Create State (Backpack)
    const stateObj = {
      userId: userId,
      nonce: crypto.randomBytes(16).toString('hex')
    };
    const stateString = Buffer.from(JSON.stringify(stateObj)).toString('base64');

    // 2. ✅ CORRECT PARAMETERS
    const clientId = process.env.NYLAS_CLIENT_ID;
    const redirectUri = encodeURIComponent(process.env.NYLAS_REDIRECT_URI);
    const scope = encodeURIComponent("email:read email:send email:modify");  // ← FIXED
    const state = encodeURIComponent(stateString);
    
    // 3. Build the V3 Auth URL
    const authUrl = `https://api.us.nylas.com/v3/connect/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${state}&access_type=offline&provider=google`;

    console.log('✅ [Nylas Auth] URL generated successfully');
    console.log('🔗 Auth URL:', authUrl);
    
    res.json({ url: authUrl });
    
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

    console.log('📥 [Nylas Callback] Received callback', { 
      hasCode: !!code, 
      hasState: !!stateString,
      error: error || 'none'
    });

    if (error) {
      console.log('❌ [Nylas Callback] Error:', error);
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=${encodeURIComponent(error)}`);
    }

    if (!code || !stateString) {
      console.log('❌ [Nylas Callback] Missing required parameters');
      return res.status(400).send("Missing code or state");
    }

    // 4. Decode State to get UserId
    let userId;
    try {
      const decodedState = JSON.parse(Buffer.from(stateString, 'base64').toString());
      userId = decodedState.userId;
      console.log('✅ [Nylas Callback] Decoded userId:', userId);
    } catch (e) {
      console.error('❌ [Nylas Callback] Invalid State format', e);
      return res.status(400).send("Invalid state parameter");
    }

    if (!userId) {
      console.log('❌ [Nylas Callback] No userId in state');
      return res.status(400).send("User ID missing from state");
    }

    console.log('🔍 [Nylas Callback] Exchanging code for token...');

    // 5. Exchange Code for Token
    const nylas = require('./nylasClient');
    const response = await nylas.auth.exchangeCodeForToken({
      clientId: process.env.NYLAS_CLIENT_ID,
      clientSecret: process.env.NYLAS_API_KEY,
      redirectUri: process.env.NYLAS_REDIRECT_URI,
      code: code,
    });
    
    console.log('✅ [Nylas Callback] Token exchange successful');
    
    const { grantId, accessToken, refreshToken, expiresIn } = response;
    
    // Log token info (without exposing full token)
    console.log('📊 Token Info:', {
      grantId: grantId,
      expiresIn: expiresIn,
      hasAccessToken: !!accessToken,
      hasRefreshToken: !!refreshToken
    });

    // 6. Save to Database
    await EmailAccount.findOneAndUpdate(
      { userId: userId }, 
      {
        nylasGrantId: grantId,
        isConnected: true,
        accessToken: accessToken,
        refreshToken: refreshToken,
        tokenExpiry: new Date(Date.now() + (expiresIn * 1000))
      },
      { upsert: true, new: true }
    );

    console.log('✅ [Nylas Callback] Account saved for User:', userId);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=success`);

  } catch (error) {
    console.error('❌ [Nylas Callback] Error:', error.message);
    console.error('❌ Full Error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=${encodeURIComponent(error.message)}`);
  }
};
