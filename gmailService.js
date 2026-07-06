const { google } = require('googleapis');
const User = require('./User');

// OAuth2 configuration
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    console.error('❌ [GMAIL] Missing Google OAuth credentials in .env');
}

// Create OAuth2 client
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

/**
 * Get Gmail client with user's tokens (auto-refreshes if expired)
 */
async function getGmailClient(userId) {
    try {
        const user = await User.findById(userId);
        if (!user || !user.gmailIntegration || !user.gmailIntegration.isConnected) {
            throw new Error('Gmail not connected. Please connect your Gmail account.');
        }

        const { accessToken, refreshToken, expiresAt } = user.gmailIntegration;

        if (!accessToken || !refreshToken) {
            throw new Error('Invalid Gmail tokens. Please reconnect your Gmail account.');
        }

        // Set credentials
        oauth2Client.setCredentials({
            access_token: accessToken,
            refresh_token: refreshToken,
            expiry_date: expiresAt ? new Date(expiresAt).getTime() : null
        });

        // Check if token is expired or about to expire (within 5 minutes)
        const now = Date.now();
        const expiryTime = expiresAt ? new Date(expiresAt).getTime() : null;

        if (expiryTime && (expiryTime - now) < 5 * 60 * 1000) {
            console.log(`🔄 [GMAIL] Token expiring soon, refreshing for user ${userId}...`);
            try {
                const { credentials } = await oauth2Client.refreshAccessToken();
                oauth2Client.setCredentials(credentials);

                // Update user with new tokens
                user.gmailIntegration.accessToken = credentials.access_token;
                if (credentials.refresh_token) {
                    user.gmailIntegration.refreshToken = credentials.refresh_token;
                }
                user.gmailIntegration.expiresAt = credentials.expiry_date ? new Date(credentials.expiry_date) : null;
                await user.save();

                console.log(`✅ [GMAIL] Token refreshed for user ${userId}`);
            } catch (refreshErr) {
                console.error(`❌ [GMAIL] Token refresh failed for user ${userId}:`, refreshErr.message);
                // If refresh fails, user needs to reconnect
                user.gmailIntegration.isConnected = false;
                await user.save();
                throw new Error('Gmail connection expired. Please reconnect your Gmail account.');
            }
        }

        return google.gmail({ version: 'v1', auth: oauth2Client });

    } catch (error) {
        console.error('❌ [GMAIL] getGmailClient error:', error.message);
        throw error;
    }
}

/**
 * Send email via Gmail API
 */
async function sendGmailEmail(userId, to, subject, body, html = null) {
    try {
        const gmail = await getGmailClient(userId);

        // Build email message
        const emailContent = html || body;
        const messageParts = [
            `To: ${to}`,
            `Subject: ${subject}`,
            'MIME-Version: 1.0',
            'Content-Type: text/html; charset=UTF-8',
            '',
            emailContent
        ];

        const message = messageParts.join('\r\n');
        const encodedMessage = Buffer.from(message)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        const response = await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: encodedMessage
            }
        });

        console.log(`📧 [GMAIL] Email sent to ${to} (messageId: ${response.data.id})`);
        return response.data;

    } catch (error) {
        console.error('❌ [GMAIL] Send email error:', error.message);
        throw error;
    }
}

/**
 * Get user's Gmail profile (email address, etc.)
 */
async function getGmailProfile(userId) {
    try {
        const gmail = await getGmailClient(userId);
        const response = await gmail.users.getProfile({ userId: 'me' });
        return response.data;
    } catch (error) {
        console.error('❌ [GMAIL] Get profile error:', error.message);
        throw error;
    }
}

/**
 * Get OAuth2 client for authorization flow
 */
function getOAuth2Client() {
    return oauth2Client;
}

/**
 * Generate auth URL for Gmail OAuth
 * @param {string} state - User ID or other state to pass through
 */
function getAuthUrl(state = '') {
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.modify'
        ],
        prompt: 'consent', // Force to get refresh token
        state: state
    });
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(code) {
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        return {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null
        };
    } catch (error) {
        console.error('❌ [GMAIL] Token exchange error:', error.message);
        throw new Error('Failed to exchange authorization code: ' + error.message);
    }
}

/**
 * Refresh access token for a user (manual)
 */
async function refreshAccessToken(userId) {
    try {
        const user = await User.findById(userId);
        if (!user || !user.gmailIntegration?.refreshToken) {
            throw new Error('No refresh token available. Please reconnect Gmail.');
        }

        oauth2Client.setCredentials({
            refresh_token: user.gmailIntegration.refreshToken
        });

        const { credentials } = await oauth2Client.refreshAccessToken();

        // Update user
        user.gmailIntegration.accessToken = credentials.access_token;
        if (credentials.refresh_token) {
            user.gmailIntegration.refreshToken = credentials.refresh_token;
        }
        user.gmailIntegration.expiresAt = credentials.expiry_date ? new Date(credentials.expiry_date) : null;
        user.gmailIntegration.isConnected = true;
        await user.save();

        console.log(`✅ [GMAIL] Manually refreshed token for user ${userId}`);
        return credentials;

    } catch (error) {
        console.error('❌ [GMAIL] Manual token refresh error:', error.message);
        throw error;
    }
}

/**
 * Check if Gmail is connected for a user
 */
async function isGmailConnected(userId) {
    try {
        const user = await User.findById(userId);
        if (!user) return false;
        return !!(user.gmailIntegration && user.gmailIntegration.isConnected);
    } catch {
        return false;
    }
}

/**
 * Get user's Gmail email address if connected
 */
async function getGmailEmail(userId) {
    try {
        const user = await User.findById(userId);
        if (!user || !user.gmailIntegration || !user.gmailIntegration.isConnected) {
            return null;
        }
        return user.gmailIntegration.emailAddress || null;
    } catch {
        return null;
    }
}

module.exports = {
    getGmailClient,
    sendGmailEmail,
    getGmailProfile,
    getOAuth2Client,
    getAuthUrl,
    exchangeCodeForTokens,
    refreshAccessToken,
    isGmailConnected,
    getGmailEmail
};
