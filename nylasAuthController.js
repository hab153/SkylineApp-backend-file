const EmailAccount = require('./EmailAccount');
const User = require('./User');
const crypto = require('crypto');
const { isValidObjectId } = require('./sanitize');

// ─── ✅ VALIDATE NYLAS CONFIG ───
function validateNylasConfig() {
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
    return true;
}

const NYLAS_CONFIG_VALID = validateNylasConfig();

/**
 * ✅ Extract a single string value from a query parameter.
 * Handles arrays (takes first element), rejects non-strings.
 * Returns null if the value is missing or not a valid string.
 */
function extractQueryParam(param) {
    if (param === undefined || param === null) return null;
    const value = Array.isArray(param) ? param[0] : param;
    if (typeof value !== 'string' || value.trim() === '') return null;
    return value;
}

exports.getAuthUrl = async (req, res) => {
  if (!NYLAS_CONFIG_VALID) {
    console.error('❌ [NYLAS AUTH] Cannot generate auth URL: Nylas not configured');
    return res.status(503).json({
      error: 'Email service not configured. Please contact support.',
      configMissing: true
    });
  }

  try {
    const userId = req.userId;
    
    if (!userId || !isValidObjectId(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }
    const safeUserId = String(userId);
    
    const stateObj = {
      userId: safeUserId,
      nonce: crypto.randomBytes(16).toString('hex')
    };
    const stateString = Buffer.from(JSON.stringify(stateObj)).toString('base64');

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
    
    const authUrl = `https://api.us.nylas.com/v3/connect/auth?` +
      `client_id=${clientId}` +
      `&redirect_uri=${redirectUri}` +
      `&response_type=code` +
      `&scope=${scope}` +
      `&state=${stateString}` +
      `&access_type=offline` +
      `&provider=google`;

    console.log('✅ [Nylas Auth] URL generated');
    res.json({ url: authUrl });
    
  } catch (error) {
    console.error('❌ [Nylas Auth] Error:', error.message);
    res.status(500).json({ 
      message: 'Failed to generate authentication link.'
    });
  }
};

exports.handleCallback = async (req, res) => {
  if (!NYLAS_CONFIG_VALID) {
    console.error('❌ [NYLAS AUTH] Cannot process callback: Nylas not configured');
    return res.status(503).json({ error: 'Email service not configured.' });
  }

  try {
    console.log('📥 [NYLAS CALLBACK] Received callback');

    // ✅ FIX #36: Use extractQueryParam to guarantee string type or null.
    // This eliminates type confusion — CodeQL can see that only strings pass through.
    const code = extractQueryParam(req.query.code);
    const stateString = extractQueryParam(req.query.state);
    const errorParam = extractQueryParam(req.query.error);

    if (errorParam) {
      console.log('❌ [NYLAS CALLBACK] Error from Nylas');
      const safeError = encodeURIComponent(errorParam.substring(0, 200));
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=${safeError}`);
    }

    if (!code || !stateString) {
      console.log('❌ [NYLAS CALLBACK] Missing required parameters');
      return res.status(400).json({ error: 'Missing code or state parameter' });
    }

    // Decode and validate state
    let decodedState;
    try {
      decodedState = JSON.parse(Buffer.from(stateString, 'base64').toString());
    } catch (e) {
      console.error('❌ [NYLAS CALLBACK] Invalid State format');
      return res.status(400).json({ error: 'Invalid state parameter' });
    }

    // ✅ FIX #36: Strict type validation on decoded userId
    if (!decodedState.userId || typeof decodedState.userId !== 'string' || !isValidObjectId(decodedState.userId)) {
      console.error('❌ [NYLAS CALLBACK] Invalid userId in state');
      return res.status(400).json({ error: 'Invalid user ID in state' });
    }

    // ✅ FIX #24/#25: Cast to String immediately — before ANY database call.
    // CodeQL flags DB queries where the variable hasn't been explicitly String-typed.
    const safeUserId = String(decodedState.userId);

    console.log('🔍 [NYLAS CALLBACK] Exchanging code for token...');

    const nylas = require('./nylasClient');
    
    const response = await nylas.auth.exchangeCodeForToken({
      clientId: process.env.NYLAS_CLIENT_ID,
      clientSecret: process.env.NYLAS_API_KEY,
      redirectUri: process.env.NYLAS_REDIRECT_URI,
      code: code,
    });
    
    console.log('✅ [NYLAS CALLBACK] Token exchange successful');
    
    const { grantId, accessToken, refreshToken, expiresIn, email } = response;

    // Validate response fields are expected types
    if (!grantId || typeof grantId !== 'string') {
      console.error('❌ [NYLAS CALLBACK] Invalid grantId in response');
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=invalid_grant`);
    }
    if (!accessToken || typeof accessToken !== 'string') {
      console.error('❌ [NYLAS CALLBACK] Invalid accessToken in response');
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=invalid_token`);
    }

    // Sanitize all values before DB writes
    const safeGrantId = String(grantId);
    const safeAccessToken = String(accessToken);
    const safeRefreshToken = refreshToken ? String(refreshToken) : null;
    const safeExpiresIn = (typeof expiresIn === 'number' && expiresIn > 0) ? expiresIn : 3600;
    const safeEmail = (typeof email === 'string' && email.length > 0) ? email.substring(0, 254) : 'Connected';

    // ✅ FIX #24: EmailAccount.findOneAndUpdate uses safeUserId (explicitly String-typed above)
    await EmailAccount.findOneAndUpdate(
      { userId: safeUserId },
      {
        nylasGrantId: safeGrantId,
        isConnected: true,
        accessToken: safeAccessToken,
        refreshToken: safeRefreshToken,
        tokenExpiry: new Date(Date.now() + (safeExpiresIn * 1000)),
        emailAddress: safeEmail,
        refreshFailCount: 0,
        lastRefreshError: null
      },
      { upsert: true, new: true }
    );

    // ✅ FIX #25: User.findOneAndUpdate uses safeUserId (explicitly String-typed above)
    await User.findOneAndUpdate(
      { _id: safeUserId },
      {
        'nylasIntegration.isConnected': true,
        'nylasIntegration.accessToken': safeAccessToken,
        'nylasIntegration.grantId': safeGrantId,
        'nylasIntegration.emailAddress': safeEmail,
        'nylasIntegration.tokenExpiry': new Date(Date.now() + (safeExpiresIn * 1000))
      },
      { upsert: true, new: true }
    );

    console.log('✅ [NYLAS CALLBACK] Account saved successfully');
    
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=success`);

  } catch (error) {
    console.error('❌ [NYLAS CALLBACK] Error:', error.message);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html?nylas=error&error=callback_failed`);
  }
};
