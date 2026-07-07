const User = require('./User');
const { 
    getNylasAuthUrl, 
    exchangeCodeForTokens, 
    getNylasProfile,
    refreshNylasToken 
} = require('./nylasService');

/**
 * Get Nylas OAuth URL
 * User must be authenticated to initiate connection
 */
async function getNylasAuthUrl(req, res) {
    try {
        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized. Please log in again.' });
        }

        const authUrl = getNylasAuthUrl();
        console.log('🔗 [NYLAS AUTH] Generated auth URL');
        res.json({ url: authUrl });
    } catch (error) {
        console.error('❌ [NYLAS AUTH] getAuthUrl error:', error.message);
        res.status(500).json({ error: 'Failed to generate Nylas connection URL. Please try again.' });
    }
}

/**
 * Handle Nylas OAuth callback
 */
async function handleNylasCallback(req, res) {
    try {
        const { code, error } = req.query;

        if (error) {
            console.log(`❌ [NYLAS AUTH] Error from Nylas: ${error}`);
            return res.redirect(`${process.env.FRONTEND_URL || 'https://skylineai-app.vercel.app'}/dashboard.html?connected=false&error=${error}`);
        }

        if (!code) {
            console.error('❌ [NYLAS AUTH] No authorization code provided');
            return res.redirect(`${process.env.FRONTEND_URL || 'https://skylineai-app.vercel.app'}/dashboard.html?connected=false&error=no_code`);
        }

        console.log('📩 [NYLAS AUTH] Received authorization code, exchanging for tokens...');

        // Exchange code for tokens
        const tokens = await exchangeCodeForTokens(code);

        console.log(`📧 [NYLAS AUTH] Connected account: ${tokens.emailAddress}`);

        // Find user by email
        const user = await User.findOne({ email: tokens.emailAddress });
        if (!user) {
            console.error(`❌ [NYLAS AUTH] No user found for email: ${tokens.emailAddress}`);
            return res.redirect(`${process.env.FRONTEND_URL || 'https://skylineai-app.vercel.app'}/dashboard.html?connected=false&error=user_not_found`);
        }

        // Update user with Nylas tokens
        user.nylasIntegration = {
            accessToken: tokens.accessToken,
            grantId: tokens.grantId,
            emailAddress: tokens.emailAddress,
            isConnected: true,
            tokenExpiry: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null
        };
        await user.save();

        console.log(`✅ [NYLAS AUTH] Nylas connected for user ${user.email}`);

        // Redirect to dashboard with success
        const frontendUrl = process.env.FRONTEND_URL || 'https://skylineai-app.vercel.app';
        res.redirect(`${frontendUrl}/dashboard.html?connected=true&email=${encodeURIComponent(tokens.emailAddress)}`);

    } catch (error) {
        console.error('❌ [NYLAS AUTH] Callback error:', error.message);
        const frontendUrl = process.env.FRONTEND_URL || 'https://skylineai-app.vercel.app';
        res.redirect(`${frontendUrl}/dashboard.html?connected=false&error=${encodeURIComponent(error.message)}`);
    }
}

/**
 * Check Nylas connection status
 */
async function checkNylasStatus(req, res) {
    try {
        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized. Please log in again.' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const isConnected = !!(user.nylasIntegration && user.nylasIntegration.isConnected);
        const emailAddress = user.nylasIntegration?.emailAddress || null;
        const tokenExpiry = user.nylasIntegration?.tokenExpiry || null;

        res.json({
            isConnected,
            emailAddress,
            tokenExpiry,
            isExpired: tokenExpiry ? new Date() >= new Date(tokenExpiry) : true
        });
    } catch (error) {
        console.error('❌ [NYLAS AUTH] Status error:', error.message);
        res.status(500).json({ error: 'Failed to check Nylas connection status.' });
    }
}

/**
 * Disconnect Nylas
 */
async function disconnectNylas(req, res) {
    try {
        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized. Please log in again.' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        user.nylasIntegration = {
            accessToken: null,
            grantId: null,
            emailAddress: null,
            isConnected: false,
            tokenExpiry: null
        };
        await user.save();

        console.log(`🔌 [NYLAS AUTH] Nylas disconnected for user ${user.email}`);
        res.json({ message: 'Nylas disconnected successfully' });
    } catch (error) {
        console.error('❌ [NYLAS AUTH] Disconnect error:', error.message);
        res.status(500).json({ error: 'Failed to disconnect Nylas. Please try again.' });
    }
}

module.exports = {
    getNylasAuthUrl,
    handleNylasCallback,
    checkNylasStatus,
    disconnectNylas
};
