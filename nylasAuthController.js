const nylas = require('./nylasClient');
const EmailAccount = require('./EmailAccount');
const crypto = require('crypto');

exports.getAuthUrl = async (req, res) => {
  try {
    // 1. Get the User ID from the verified token
    const userId = req.userId; 

    // 2. Create a "Backpack" (State) containing the User ID and a random security string
    const stateObj = {
      userId: userId,
      nonce: crypto.randomBytes(16).toString('hex')
    };
    
    // 3. Pack the backpack (Convert to Base64 string so URLs can handle it)
    const stateString = Buffer.from(JSON.stringify(stateObj)).toString('base64');

    // 4. Manually Build the URL to ensure response_type is present
    const clientId = process.env.NYLAS_CLIENT_ID;
    const redirectUri = encodeURIComponent(process.env.NYLAS_REDIRECT_URI);
    const scope = encodeURIComponent("email.read_only email.send email.modify offline_access");
    
    // Using the V3 endpoint explicitly
    const authUrl = `https://api.us.nylas.com/v3/connect/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${stateString}&access_type=offline`;

    console.log('✅ [Nylas Auth] Manual Auth URL generated for User:', userId);
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

    // 5. Open the Backpack (Decode Base64)
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

    console.log('🔍 [Nylas Callback] Exchanging code for token for User:', userId);

    // 6. Exchange the code for tokens
    const response = await nylas.auth.exchangeCodeForToken({
      clientId: process.env.NYLAS_CLIENT_ID,
      clientSecret: process.env.NYLAS_CLIENT_SECRET, 
      redirectUri: process.env.NYLAS_REDIRECT_URI,
      code: code,
    });
    
    const { grantId, accessToken, refreshToken, expiresIn } = response;
    
    console.log('✅ [Nylas Callback] Token exchanged successfully');

    // 7. Save the connection to the Database using the UserID from the backpack
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
