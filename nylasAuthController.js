const { v4: uuidv4 } = require('uuid');
const User = require('./User');
const EmailAccount = require('./EmailAccount');
const { getAuthUrl, exchangeCodeForToken, getUserEmail } = require('./nylasService');
const { isValidObjectId } = require('./sanitize');

// In-memory store for OAuth state (cleaned up after 10 minutes)
const stateStore = {};

// Helper: max connections per subscription tier
function getMaxConnections(tier) {
    if (tier === 'free') return 1;
    if (tier === 'go') return 2;
    if (tier === 'pro') return 5;
    return 1;
}

// GET /api/auth/nylas/url
const getAuthUrlHandler = async (req, res) => {
    const userId = req.userId;
    console.log('🔧 [NYLAS AUTH DEBUG] getAuthUrlHandler called for userId:', userId);
    console.log('🔧 [NYLAS AUTH DEBUG] Request headers:', req.headers ? '✅ Present' : '❌ No headers');

    try {
        if (!isValidObjectId(userId)) {
            console.error('❌ [NYLAS AUTH DEBUG] Invalid userId:', userId);
            return res.status(400).json({ message: 'Invalid user ID' });
        }

        const user = await User.findById(userId);
        if (!user) {
            console.error('❌ [NYLAS AUTH DEBUG] User not found:', userId);
            return res.status(404).json({ message: 'User not found' });
        }

        console.log('🔧 [NYLAS AUTH DEBUG] User found:', user.email);
        console.log('🔧 [NYLAS AUTH DEBUG] Subscription tier:', user.subscriptionTier);

        const currentCount = await EmailAccount.countDocuments({ userId });
        const max = getMaxConnections(user.subscriptionTier);

        console.log('🔧 [NYLAS AUTH DEBUG] Current email accounts:', currentCount);
        console.log('🔧 [NYLAS AUTH DEBUG] Max allowed:', max);

        if (currentCount >= max) {
            console.warn('⚠️ [NYLAS AUTH DEBUG] User reached max connections:', currentCount, '/', max);
            return res.status(403).json({
                message: `You have already reached the maximum number of connected email accounts (${max}/${max}). Upgrade your plan to connect more.`,
                redirect: '/dashboard'
            });
        }

        const randomState = uuidv4();
        stateStore[randomState] = userId;
        console.log('🔧 [NYLAS AUTH DEBUG] Generated state:', randomState);
        console.log('🔧 [NYLAS AUTH DEBUG] State stored for userId:', userId);

        // Clean up state after 10 minutes
        setTimeout(() => { 
            delete stateStore[randomState];
            console.log('🔧 [NYLAS AUTH DEBUG] State expired and removed:', randomState);
        }, 10 * 60 * 1000);

        const authUrl = getAuthUrl(randomState);
        console.log('🔧 [NYLAS AUTH DEBUG] Auth URL generated successfully');
        console.log('🔧 [NYLAS AUTH DEBUG] Auth URL:', authUrl);

        res.json({ url: authUrl });
    } catch (err) {
        console.error('❌ [NYLAS AUTH DEBUG] Error in getAuthUrlHandler:', err);
        console.error('❌ [NYLAS AUTH DEBUG] Error stack:', err.stack);
        res.status(500).json({ 
            message: 'Server error generating auth URL',
            error: err.message 
        });
    }
};

// GET /api/auth/nylas/callback
const handleCallback = async (req, res) => {
    console.log('🔧 [NYLAS AUTH DEBUG] handleCallback called');
    console.log('🔧 [NYLAS AUTH DEBUG] Query params:', JSON.stringify(req.query, null, 2));

    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
        console.error('❌ [NYLAS AUTH DEBUG] OAuth error from Nylas:', oauthError);
        return res.redirect('https://skylineai-app.vercel.app/dashboard.html?connected=false&error=' + oauthError);
    }

    if (!code || !state) {
        console.error('❌ [NYLAS AUTH DEBUG] Missing code or state parameter');
        return res.status(400).send('Missing required parameters.');
    }

    console.log('🔧 [NYLAS AUTH DEBUG] Code present:', !!code);
    console.log('🔧 [NYLAS AUTH DEBUG] State present:', !!state);

    const userId = stateStore[state];
    console.log('🔧 [NYLAS AUTH DEBUG] userId from stateStore:', userId);

    if (!userId) {
        console.error('❌ [NYLAS AUTH DEBUG] Invalid or expired state:', state);
        return res.status(400).send('Session expired. Please try connecting again.');
    }

    delete stateStore[state];
    console.log('🔧 [NYLAS AUTH DEBUG] State removed from store');

    try {
        console.log('🔧 [NYLAS AUTH DEBUG] Checking user exists...');
        const user = await User.findById(userId);
        if (!user) {
            console.error('❌ [NYLAS AUTH DEBUG] User not found:', userId);
            return res.status(400).send('User not found');
        }
        console.log('🔧 [NYLAS AUTH DEBUG] User found:', user.email);

        // Check limit again
        const currentCount = await EmailAccount.countDocuments({ userId });
        const max = getMaxConnections(user.subscriptionTier);
        console.log('🔧 [NYLAS AUTH DEBUG] Current accounts:', currentCount, 'Max:', max);

        if (currentCount >= max) {
            console.warn('⚠️ [NYLAS AUTH DEBUG] User reached max connections during callback:', currentCount, '/', max);
            return res.redirect(`https://skylineai-app.vercel.app/dashboard.html?connected=false&error=limit_reached&limit=${max}`);
        }

        console.log('🔧 [NYLAS AUTH DEBUG] Exchanging code for token...');
        const tokenData = await exchangeCodeForToken(code);
        console.log('🔧 [NYLAS AUTH DEBUG] Token exchange successful');
        console.log('🔧 [NYLAS AUTH DEBUG] Token data keys:', Object.keys(tokenData));

        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;
        const grantId = tokenData.grant_id;

        console.log('🔧 [NYLAS AUTH DEBUG] Access token present:', !!accessToken);
        console.log('🔧 [NYLAS AUTH DEBUG] Refresh token present:', !!refreshToken);
        console.log('🔧 [NYLAS AUTH DEBUG] Grant ID present:', !!grantId);

        if (!refreshToken) {
            console.warn('⚠️ [NYLAS AUTH DEBUG] No refresh_token returned!');
        }

        console.log('🔧 [NYLAS AUTH DEBUG] Getting user email...');
        let emailAddress = 'unknown@nylas.com';
        try {
            emailAddress = await getUserEmail(accessToken);
            console.log('🔧 [NYLAS AUTH DEBUG] Email retrieved:', emailAddress);
        } catch (emailErr) {
            console.warn(`⚠️ [NYLAS AUTH DEBUG] Could not retrieve email: ${emailErr.message}`);
        }

        console.log('🔧 [NYLAS AUTH DEBUG] Updating user with Nylas integration...');
        await User.findByIdAndUpdate(userId, {
            'nylasIntegration.accessToken': accessToken,
            'nylasIntegration.emailAddress': emailAddress,
            'nylasIntegration.isConnected': true,
            'nylasIntegration.connectedAt': new Date()
        });

        if (grantId) {
            console.log('🔧 [NYLAS AUTH DEBUG] Saving email account...');
            const saved = await EmailAccount.findOneAndUpdate(
                { nylasGrantId: grantId },
                {
                    userId,
                    emailAddress,
                    isConnected: true,
                    provider: 'gmail',
                    accessToken,
                    refreshToken,
                    tokenExpiry: new Date(Date.now() + 3600 * 1000),
                    refreshFailCount: 0,
                    lastRefreshError: null
                },
                { upsert: true, new: true }
            );
            console.log(`✅ [AUTH] Grant ${grantId} linked to User ${userId} — refreshToken saved: ${!!saved.refreshToken}`);
        }

        console.log('✅ [NYLAS AUTH DEBUG] Callback completed successfully!');
        res.redirect('https://skylineai-app.vercel.app/dashboard.html?connected=true');
    } catch (err) {
        console.error('❌ [NYLAS AUTH DEBUG] Callback error:', err);
        console.error('❌ [NYLAS AUTH DEBUG] Error stack:', err.stack);
        res.redirect(`https://skylineai-app.vercel.app/dashboard.html?connected=false&error=token_exchange_failed`);
    }
};

module.exports = {
    getAuthUrl: getAuthUrlHandler,
    handleCallback
};
