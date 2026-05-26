const { v4: uuidv4 } = require('uuid');
const User = require('./User');
const EmailAccount = require('./EmailAccount');
const { getAuthUrl, exchangeCodeForToken, getUserEmail } = require('./nylasService');

// In-memory store for OAuth state (cleaned up after 10 minutes)
const stateStore = {};

// GET /api/auth/nylas/url
const getAuthUrlHandler = (req, res) => {
    const userId = req.userId;
    const randomState = uuidv4();
    stateStore[randomState] = userId;
    setTimeout(() => { delete stateStore[randomState]; }, 10 * 60 * 1000);
    res.json({ url: getAuthUrl(randomState) });
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
