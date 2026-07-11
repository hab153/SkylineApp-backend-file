const EmailAccount = require('./EmailAccount');
const User = require('./User');
const crypto = require('crypto');

exports.getAuthUrl = async (req, res) => {
  try {
    const userId = req.userId;
    
    // 1. Create State
    const stateObj = {
      userId: userId,
      nonce: crypto.randomBytes(16).toString('hex')
    };
    const stateString = Buffer.from(JSON.stringify(stateObj)).toString('base64');

    // 2. ✅ USE FULL GOOGLE SCOPE URIs
    const clientId = process.env.NYLAS_CLIENT_ID;
    const redirectUri = encodeURIComponent(process.env.NYLAS_REDIRECT_URI);
    
    const scope = encodeURIComponent([
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.modify"
    ].join(" "));
    
    // ✅ CRITICAL: access_type=offline is a QUERY PARAMETER for Google (not a scope)
    const authUrl = `https://api.us.nylas.com/v3/connect/auth?` +
      `client_id=${clientId}` +
      `&redirect_uri=${redirectUri}` +
      `&response_type=code` +
      `&scope=${scope}` +
      `&state=${stateString}` +
      `&access_type=offline` +      // ← This is correct for Google
      `&provider=google`;

    console.log('✅ [Nylas Auth] URL generated with full Google scopes');
    console.log('✅ [Nylas Auth] access_type=offline included for refresh token');
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
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📥 [NYLAS CALLBACK] Received callback');
    console.log('📥 [NYLAS CALLBACK] Full URL:', req.originalUrl);
    console.log('📥 [NYLAS CALLBACK] Method:', req.method);
    console.log('📥 [NYLAS CALLBACK] Headers:', {
      host: req.headers.host,
      'user-agent': req.headers['user-agent'],
      'x-forwarded-proto': req.headers['x-forwarded-proto']
    });
    console.log('📥 [NYLAS CALLBACK] Query params:', req.query);
    console.log('📥 [NYLAS CALLBACK] Code present:', !!req.query.code);
    console.log('📥 [NYLAS CALLBACK] State present:', !!req.query.state);
    console.log('📥 [NYLAS CALLBACK] Error present:', req.query.error || 'none');
    console.log('📥 [NYLAS CALLBACK] Full query string:', req.originalUrl.split('?')[1] || '');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const code = req.query.code;
    const stateString = req.query.state; 
    const error = req.query.error;

    if (error) {
      console.log('❌ [NYLAS CALLBACK] Error from Nylas:', error);
      console.log('❌ [NYLAS CALLBACK] Full error details:', req.query);
      const redirectUrl = `${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=${encodeURIComponent(error)}`;
      console.log('🔄 [NYLAS CALLBACK] Redirecting to:', redirectUrl);
      return res.redirect(redirectUrl);
    }

    if (!code || !stateString) {
      console.log('❌ [NYLAS CALLBACK] Missing required parameters');
      console.log('❌ [NYLAS CALLBACK] code:', code || 'MISSING');
      console.log('❌ [NYLAS CALLBACK] state:', stateString || 'MISSING');
      console.log('❌ [NYLAS CALLBACK] All query params:', req.query);
      return res.status(400).send(`
        <h1>Missing Parameters</h1>
        <p>Code: ${code ? '✅' : '❌'}</p>
        <p>State: ${stateString ? '✅' : '❌'}</p>
        <p>Error: ${error || 'none'}</p>
        <p>Full query: ${JSON.stringify(req.query)}</p>
      `);
    }

    let userId;
    try {
      const decodedState = JSON.parse(Buffer.from(stateString, 'base64').toString());
      userId = decodedState.userId;
      console.log('✅ [NYLAS CALLBACK] Decoded userId:', userId);
      console.log('✅ [NYLAS CALLBACK] Decoded state:', decodedState);
    } catch (e) {
      console.error('❌ [NYLAS CALLBACK] Invalid State format:', e);
      console.log('❌ [NYLAS CALLBACK] State string:', stateString);
      return res.status(400).send("Invalid state parameter");
    }

    if (!userId) {
      console.log('❌ [NYLAS CALLBACK] No userId in state');
      return res.status(400).send("User ID missing from state");
    }

    console.log('🔍 [NYLAS CALLBACK] Exchanging code for token...');
    console.log('🔍 [NYLAS CALLBACK] Code length:', code.length);
    console.log('🔍 [NYLAS CALLBACK] Code first 10 chars:', code.substring(0, 10) + '...');

    const nylas = require('./nylasClient');
    
    console.log('🔍 [NYLAS CALLBACK] Exchange request params:', {
      clientId: process.env.NYLAS_CLIENT_ID ? '✅' : '❌',
      clientSecret: process.env.NYLAS_API_KEY ? '✅' : '❌',
      redirectUri: process.env.NYLAS_REDIRECT_URI ? '✅' : '❌',
      code: code.substring(0, 10) + '...'
    });

    const response = await nylas.auth.exchangeCodeForToken({
      clientId: process.env.NYLAS_CLIENT_ID,
      clientSecret: process.env.NYLAS_API_KEY,
      redirectUri: process.env.NYLAS_REDIRECT_URI,
      code: code,
    });
    
    console.log('✅ [NYLAS CALLBACK] Token exchange successful');
    console.log('📊 [NYLAS CALLBACK] Response keys:', Object.keys(response));
    
    const { grantId, accessToken, refreshToken, expiresIn, email } = response;

    console.log('📊 [NYLAS CALLBACK] Token info:', {
      grantId: grantId || 'MISSING',
      expiresIn: expiresIn || 'MISSING',
      hasAccessToken: !!accessToken,
      hasRefreshToken: !!refreshToken,
      email: email || 'Not provided'
    });

    // ✅ STEP 1: Save to EmailAccount model with refresh token
    console.log('💾 [NYLAS CALLBACK] Saving to EmailAccount for userId:', userId);
    await EmailAccount.findOneAndUpdate(
      { userId: userId },
      {
        nylasGrantId: grantId,
        isConnected: true,
        accessToken: accessToken,
        refreshToken: refreshToken,
        tokenExpiry: new Date(Date.now() + (expiresIn * 1000)),
        emailAddress: email || 'Connected',
        refreshFailCount: 0,
        lastRefreshError: null
      },
      { upsert: true, new: true }
    );

    // ✅ STEP 2: ALSO update User.nylasIntegration
    console.log('💾 [NYLAS CALLBACK] Updating User.nylasIntegration for userId:', userId);
    await User.findOneAndUpdate(
      { _id: userId },
      {
        'nylasIntegration.isConnected': true,
        'nylasIntegration.accessToken': accessToken,
        'nylasIntegration.grantId': grantId,
        'nylasIntegration.emailAddress': email || 'Connected',
        'nylasIntegration.tokenExpiry': new Date(Date.now() + (expiresIn * 1000))
      },
      { upsert: true, new: true }
    );

    console.log('✅ [NYLAS CALLBACK] Account saved successfully to both models');
    console.log('✅ [NYLAS CALLBACK] Refresh token saved:', refreshToken ? '✅ YES' : '❌ NO - This is the problem!');
    
    const redirectUrl = `${process.env.FRONTEND_URL}/dashboard.html?nylas=success`;
    console.log('🔄 [NYLAS CALLBACK] Redirecting to:', redirectUrl);
    res.redirect(redirectUrl);

  } catch (error) {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('❌ [NYLAS CALLBACK] EXCEPTION CAUGHT:');
    console.error('❌ [NYLAS CALLBACK] Error message:', error.message);
    console.error('❌ [NYLAS CALLBACK] Error stack:', error.stack);
    console.error('❌ [NYLAS CALLBACK] Error response:', error.response?.data || 'none');
    console.error('❌ [NYLAS CALLBACK] Error status:', error.response?.status || 'none');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    const redirectUrl = `${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=${encodeURIComponent(error.message)}`;
    console.log('🔄 [NYLAS CALLBACK] Redirecting with error to:', redirectUrl);
    res.redirect(redirectUrl);
  }
};
