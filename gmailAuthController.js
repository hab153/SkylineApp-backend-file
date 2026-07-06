const User = require('./User');
const { google } = require('googleapis');
const {
    exchangeCodeForTokens,
    getGmailProfile,
    getOAuth2Client
} = require('./gmailService');

/**
 * Get Gmail OAuth URL - MANUALLY BUILT to ensure response_type=code
 * User must be authenticated to initiate connection
 */
async function getGmailAuthUrl(req, res) {
    try {
        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized. Please log in again.' });
        }

        const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
        const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

        // ✅ MANUALLY BUILD THE URL TO ENSURE response_type=code
        const authUrl =
            'https://accounts.google.com/o/oauth2/v2/auth?' +
            'client_id=' + encodeURIComponent(CLIENT_ID) +
            '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
            '&response_type=code' +                    // ✅ REQUIRED PARAMETER
            '&access_type=offline' +
            '&prompt=consent' +
            '&state=' + encodeURIComponent(userId.toString()) +
            '&scope=' + encodeURIComponent(
                'https://www.googleapis.com/auth/gmail.send ' +
                'https://www.googleapis.com/auth/gmail.readonly ' +
                'https://www.googleapis.com/auth/gmail.modify'
            );

        console.log('🔗 [GMAIL AUTH] Generated auth URL with response_type=code');
        console.log('🔗 [GMAIL AUTH] Redirect URI:', REDIRECT_URI);
        res.json({ url: authUrl });

    } catch (error) {
        console.error('❌ [GMAIL AUTH] getAuthUrl error:', error.message);
        res.status(500).json({ error: 'Failed to generate Gmail connection URL. Please try again.' });
    }
}

/**
 * Handle Gmail OAuth callback
 * This is the redirect URI that Google calls after user authorizes
 */
async function handleGmailCallback(req, res) {
    try {
        const { code, state, error } = req.query;

        // Check if user denied access
        if (error) {
            console.log(`❌ [GMAIL AUTH] User denied access: ${error}`);
            return res.redirect(`${process.env.FRONTEND_URL || 'https://skylineai-app.vercel.app'}/dashboard.html?connected=false&error=access_denied`);
        }

        if (!code) {
            console.error('❌ [GMAIL AUTH] No authorization code provided');
            return res.redirect(`${process.env.FRONTEND_URL || 'https://skylineai-app.vercel.app'}/dashboard.html?connected=false&error=no_code`);
        }

        console.log('📩 [GMAIL AUTH] Received authorization code, exchanging for tokens...');

        // Exchange code for tokens
        const tokens = await exchangeCodeForTokens(code);

        // Get user's email from Gmail profile
        const oauth2Client = getOAuth2Client();
        oauth2Client.setCredentials({
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken
        });

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        const emailAddress = profile.data.emailAddress;

        console.log(`📧 [GMAIL AUTH] Connected account: ${emailAddress}`);

        // Get userId from state parameter
        let userId = state;
        if (!userId) {
            // Fallback: find user by email
            const user = await User.findOne({ email: emailAddress });
            if (!user) {
                console.error(`❌ [GMAIL AUTH] No user found for email: ${emailAddress}`);
                return res.redirect(`${process.env.FRONTEND_URL || 'https://skylineai-app.vercel.app'}/dashboard.html?connected=false&error=user_not_found`);
            }
            userId = user._id;
        }

        // Update user with Gmail tokens
        const user = await User.findById(userId);
        if (!user) {
            console.error(`❌ [GMAIL AUTH] User not found: ${userId}`);
            return res.redirect(`${process.env.FRONTEND_URL || 'https://skylineai-app.vercel.app'}/dashboard.html?connected=false&error=user_not_found`);
        }

        user.gmailIntegration = {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            emailAddress: emailAddress,
            isConnected: true,
            expiresAt: tokens.expiryDate
        };
        await user.save();

        console.log(`✅ [GMAIL AUTH] Gmail connected for user ${user.email}`);

        // Redirect to dashboard with success
        const frontendUrl = process.env.FRONTEND_URL || 'https://skylineai-app.vercel.app';
        res.redirect(`${frontendUrl}/dashboard.html?connected=true&email=${encodeURIComponent(emailAddress)}`);

    } catch (error) {
        console.error('❌ [GMAIL AUTH] Callback error:', error.message);
        const frontendUrl = process.env.FRONTEND_URL || 'https://skylineai-app.vercel.app';
        res.redirect(`${frontendUrl}/dashboard.html?connected=false&error=${encodeURIComponent(error.message)}`);
    }
}

/**
 * Check Gmail connection status for authenticated user
 */
async function checkGmailStatus(req, res) {
    try {
        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized. Please log in again.' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const isConnected = !!(user.gmailIntegration && user.gmailIntegration.isConnected);
        const emailAddress = user.gmailIntegration?.emailAddress || null;
        const expiresAt = user.gmailIntegration?.expiresAt || null;

        res.json({
            isConnected,
            emailAddress,
            expiresAt,
            // Check if token is expired
            isExpired: expiresAt ? new Date() >= new Date(expiresAt) : true
        });
    } catch (error) {
        console.error('❌ [GMAIL AUTH] Status error:', error.message);
        res.status(500).json({ error: 'Failed to check Gmail connection status.' });
    }
}

/**
 * Disconnect Gmail for authenticated user
 */
async function disconnectGmail(req, res) {
    try {
        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized. Please log in again.' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        user.gmailIntegration = {
            accessToken: null,
            refreshToken: null,
            emailAddress: null,
            isConnected: false,
            expiresAt: null
        };
        await user.save();

        console.log(`🔌 [GMAIL AUTH] Gmail disconnected for user ${user.email}`);
        res.json({ message: 'Gmail disconnected successfully' });
    } catch (error) {
        console.error('❌ [GMAIL AUTH] Disconnect error:', error.message);
        res.status(500).json({ error: 'Failed to disconnect Gmail. Please try again.' });
    }
}

module.exports = {
    getGmailAuthUrl,
    handleGmailCallback,
    checkGmailStatus,
    disconnectGmail
};
