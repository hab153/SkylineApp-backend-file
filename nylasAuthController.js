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
    return 1; // default fallback
}

// GET /api/auth/nylas/url
const getAuthUrlHandler = async (req, res) => {
    const userId = req.userId;
    try {
        if (!isValidObjectId(userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const currentCount = await EmailAccount.countDocuments({ userId });
        const max = getMaxConnections(user.subscriptionTier);

        if (currentCount >= max) {
            return res.status(403).json({
                message: `You have already reached the maximum number of connected email accounts (${max}/${max}). Upgrade your plan to connect more.`,
                redirect: '/dashboard'
            });
        }

        const randomState = uuidv4();
        stateStore[randomState] = userId;
        setTimeout(() => { delete stateStore[randomState]; }, 10 * 60 * 1000);
        res.json({ url: getAuthUrl(randomState) });
    } catch (err) {
        console.error('Error in /url:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// GET /api/auth/nylas/callback
const handleCallback = async (req, res) => {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) {
        return res.redirect('https://skylineai-app.vercel.app/dashboard.html?connected=false&error=' + oauthError);
    }
    if (!code || !state) {
        return res.status(400).send('Missing required parameters.');
    }
    const userId = stateStore[state];
    if (!userId) {
        return res.status(400).send('Session expired. Please try connecting again.');
    }
    delete stateStore[state];

    try {
        // Check limit again before creating new account (prevent race condition)
        const user = await User.findById(userId);
        if (!user) {
            return res.status(400).send('User not found');
        }
        const currentCount = await EmailAccount.countDocuments({ userId });
        const max = getMaxConnections(user.subscriptionTier);
        if (currentCount >= max) {
            console.warn(`User ${userId} tried to add another email account but limit (${max}) already reached.`);
            return res.redirect(`https://skylineai-app.vercel.app/dashboard.html?connected=false&error=limit_reached&limit=${max}`);
        }

        const tokenData = await exchangeCodeForToken(code);
        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;
        const grantId = tokenData.grant_id;

        if (!refreshToken) {
            console.error('❌ [NYLAS CALLBACK] No refresh_token returned from Nylas! Ensure offline_access scope is enabled in your Nylas app settings.');
        }
        let emailAddress = 'unknown@nylas.com';
        try {
            emailAddress = await getUserEmail(accessToken);
        } catch (emailErr) {
            console.warn(`⚠️ Could not retrieve email: ${emailErr.message}`);
        }

        // Update user's nylasIntegration (optional – may keep for backward compatibility)
        await User.findByIdAndUpdate(userId, {
            'nylasIntegration.accessToken': accessToken,
            'nylasIntegration.emailAddress': emailAddress,
            'nylasIntegration.isConnected': true,
            'nylasIntegration.connectedAt': new Date()
        });

        if (grantId) {
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

        res.redirect('https://skylineai-app.vercel.app/dashboard.html?connected=true');
    } catch (err) {
        console.error(`❌ Nylas Callback Error: ${err.message}`);
        res.redirect(`https://skylineai-app.vercel.app/dashboard.html?connected=false&error=token_exchange_failed`);
    }
};

module.exports = {
    getAuthUrl: getAuthUrlHandler,
    handleCallback
};
