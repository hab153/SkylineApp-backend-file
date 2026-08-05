const EmailAccount = require('./EmailAccount');
const User = require('./User');
const crypto = require('crypto');
const { isValidObjectId } = require('./sanitize');

// ─── ✅ VALIDATE NYLAS CONFIG ───
function validateNylasConfig() {
    // In Nylas V3, NYLAS_API_KEY serves as the client secret
    const required = ['NYLAS_CLIENT_ID', 'NYLAS_API_KEY'];
    const missing = required.filter(key => {
        const value = process.env[key];
        return !value || value.trim() === '';
    });
    
    if (missing.length > 0) {
        console.error('❌ [NYLAS AUTH] Missing required Nylas configuration:');
        missing.forEach(key => console.error(`   ⚠️ ${key}`));
        return false;
    }
    
    console.log('✅ [NYLAS AUTH] Nylas configuration validated');
    console.log(`   📋 Client ID: ${process.env.NYLAS_CLIENT_ID ? '✅ Set' : '❌ Missing'}`);
    console.log(`   📋 API Key: ${process.env.NYLAS_API_KEY ? '✅ Set' : '❌ Missing'}`);
    return true;
}

const NYLAS_CONFIG_VALID = validateNylasConfig();

exports.getAuthUrl = async (req, res) => {
  // ✅ Check Nylas config first
  if (!NYLAS_CONFIG_VALID) {
    console.error('❌ [NYLAS AUTH] Cannot generate auth URL: Nylas not configured');
    return res.status(503).json({
      error: 'Email service not configured. Please contact support.',
      configMissing: true
    });
  }

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
    
    res.json({ url: authUrl });
    
  } catch (error) {
    console.error('❌ [Nylas Auth] Error:', error.message);
    res.status(500).json({ 
      message: 'Failed to generate authentication link.', 
      error: error.message 
    });
  }
};

exports.handleCallback = async (req, res) => {
  // ✅ Check Nylas config first
  if (!NYLAS_CONFIG_VALID) {
    console.error('❌ [NYLAS AUTH] Cannot process callback: Nylas not configured');
    return res.status(503).send(`
      <h1>Email Service Not Configured</h1>
      <p>The email service is not configured properly. Please contact support.</p>
    `);
  }

  try {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📥 [NYLAS CALLBACK] Received callback');
    console.log('📥 [NYLAS CALLBACK] Method:', req.method);
    console.log('📥 [NYLAS CALLBACK] Code present:', !!req.query.code);
    console.log('📥 [NYLAS CALLBACK] State present:', !!req.query.state);
    console.log('📥 [NYLAS CALLBACK] Error present:', req.query.error || 'none');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // ✅ FIX #36: Type confusion - Validate all query params are strings, not arrays/objects
    const code = Array.isArray(req.query.code) ? req.query.code[0] : req.query.code;
    const stateString = Array.isArray(req.query.state) ? req.query.state[0] : req.query.state;
    const error = Array.isArray(req.query.error) ? req.query.error[0] : req.query.error;

    // ✅ Ensure params are strings (prevent type confusion attacks)
    if (code !== undefined && typeof code !== 'string') {
      console.warn('⚠️ [NYLAS CALLBACK] Code parameter is not a string, rejecting');
      return res.status(400).send('<h1>Invalid Parameters</h1><p>Code must be a string.</p>');
    }
    if (stateString !== undefined && typeof stateString !== 'string') {
      console.warn('⚠️ [NYLAS CALLBACK] State parameter is not a string, rejecting');
      return res.status(400).send('<h1>Invalid Parameters</h1><p>State must be a string.</p>');
    }

    if (error) {
      console.log('❌ [NYLAS CALLBACK] Error from Nylas:', error);
      const redirectUrl = `${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=${encodeURIComponent(String(error))}`;
      console.log('🔄 [NYLAS CALLBACK] Redirecting to:', redirectUrl);
      return res.redirect(redirectUrl);
    }

    if (!code || !stateString) {
      console.log('❌ [NYLAS CALLBACK] Missing required parameters');
      console.log('❌ [NYLAS CALLBACK] code:', code ? 'present' : 'MISSING');
      console.log('❌ [NYLAS CALLBACK] state:', stateString ? 'present' : 'MISSING');
      return res.status(400).send(`
        <h1>Missing Parameters</h1>
        <p>Code: ${code ? '✅' : '❌'}</p>
        <p>State: ${stateString ? '✅' : '❌'}</p>
      `);
    }

    let userId;
    try {
      const decodedState = JSON.parse(Buffer.from(stateString, 'base64').toString());
      
      // ✅ FIX: Validate userId is a valid ObjectId string (prevent type confusion)
      if (!decodedState.userId || typeof decodedState.userId !== 'string' || !isValidObjectId(decodedState.userId)) {
        console.error('❌ [NYLAS CALLBACK] Invalid userId in state:', decodedState.userId);
        return res.status(400).send('<h1>Invalid State</h1><p>User ID is invalid.</p>');
      }
      
      userId = decodedState.userId;
      console.log('✅ [NYLAS CALLBACK] Decoded userId:', userId);
    } catch (e) {
      console.error('❌ [NYLAS CALLBACK] Invalid State format:', e.message);
      return res.status(400).send('<h1>Invalid State</h1><p>State parameter could not be decoded.</p>');
    }

    if (!userId) {
      console.log('❌ [NYLAS CALLBACK] No userId in state');
      return res.status(400).send('<h1>Invalid State</h1><p>User ID missing from state.</p>');
    }

    console.log('🔍 [NYLAS CALLBACK] Exchanging code for token...');

    const nylas = require('./nylasClient');
    
    const response = await nylas.auth.exchangeCodeForToken({
      clientId: process.env.NYLAS_CLIENT_ID,
      clientSecret: process.env.NYLAS_API_KEY, // ← NYLAS_API_KEY is the client secret in V3
      redirectUri: process.env.NYLAS_REDIRECT_URI,
      code: code,
    });
    
    console.log('✅ [NYLAS CALLBACK] Token exchange successful');
    
    const { grantId, accessToken, refreshToken, expiresIn, email } = response;

    // ✅ FIX: Validate response fields are expected types
    if (!grantId || typeof grantId !== 'string') {
      console.error('❌ [NYLAS CALLBACK] Invalid grantId in response');
      const redirectUrl = `${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=invalid_grant`;
      return res.redirect(redirectUrl);
    }
    if (!accessToken || typeof accessToken !== 'string') {
      console.error('❌ [NYLAS CALLBACK] Invalid accessToken in response');
      const redirectUrl = `${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=invalid_token`;
      return res.redirect(redirectUrl);
    }

    console.log('📊 [NYLAS CALLBACK] Token info:', {
      grantId: grantId ? '✅' : 'MISSING',
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
        refreshToken: refreshToken || null,
        tokenExpiry: new Date(Date.now() + ((typeof expiresIn === 'number' ? expiresIn : 3600) * 1000)),
        emailAddress: (typeof email === 'string' ? email : 'Connected'),
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
        'nylasIntegration.emailAddress': (typeof email === 'string' ? email : 'Connected'),
        'nylasIntegration.tokenExpiry': new Date(Date.now() + ((typeof expiresIn === 'number' ? expiresIn : 3600) * 1000))
      },
      { upsert: true, new: true }
    );

    console.log('✅ [NYLAS CALLBACK] Account saved successfully to both models');
    
    const redirectUrl = `${process.env.FRONTEND_URL}/dashboard.html?nylas=success`;
    console.log('🔄 [NYLAS CALLBACK] Redirecting to:', redirectUrl);
    res.redirect(redirectUrl);

  } catch (error) {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('❌ [NYLAS CALLBACK] EXCEPTION CAUGHT:');
    console.error('❌ [NYLAS CALLBACK] Error message:', error.message);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    const redirectUrl = `${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=${encodeURIComponent(error.message || 'Unknown error')}`;
    console.log('🔄 [NYLAS CALLBACK] Redirecting with error to:', redirectUrl);
    res.redirect(redirectUrl);
  }
};
