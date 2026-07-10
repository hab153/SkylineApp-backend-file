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

    // 2. Define Parameters
    const clientId = process.env.NYLAS_CLIENT_ID;
    const redirectUri = encodeURIComponent(process.env.NYLAS_REDIRECT_URI);
    const scope = encodeURIComponent("email.read_only email.send email.modify offline_access");
    
    // 3. Manually Build the V3 Auth URL
    const authUrl = `https://api.us.nylas.com/v3/connect/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${stateString}&access_type=offline&provider=google`;

    console.log('✅ [Nylas Auth] Manual V3 URL generated');
    res.json({ url: authUrl });
  } catch (error) {
    console.error('❌ [Nylas Auth] Error:', error);
    res.status(500).json({ message: 'Failed to generate authentication link.', error: error.message });
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

    // 4. Decode State to get UserId
    let userId;
    try {
      const decodedState = JSON.parse(Buffer.from(stateString, 'base64').toString());
      userId = decodedState.userId;
    } catch (e) {
      console.error('❌ [Nylas Callback] Invalid State format');
      return res.status(400).send("Invalid state parameter");
    }

    if (!userId) {
      return res.status(400).send("User ID missing from state");
    }

    console.log('🔍 [Nylas Callback] Exchanging code for token...');

    // 5. Exchange Code for Token using the SDK
    const nylas = require('./nylasClient');
    const response = await nylas.auth.exchangeCodeForToken({
      clientId: process.env.NYLAS_CLIENT_ID,
      clientSecret: process.env.NYLAS_API_KEY, // ✅ Using API Key as Client Secret
      redirectUri: process.env.NYLAS_REDIRECT_URI,
      code: code,
    });
    
    const { grantId, accessToken, refreshToken, expiresIn } = response;
    
    console.log('✅ [Nylas Callback] Token exchanged successfully');

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
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=${encodeURIComponent(error.message)}`);
  }
};
