const axios = require('axios');
const User = require('./User');

// Configuration
const CLIENT_ID = process.env.NYLAS_CLIENT_ID;
const CLIENT_SECRET = process.env.NYLAS_CLIENT_SECRET;
const API_URI = process.env.NYLAS_API_URI || 'https://api.us.nylas.com/v3';
const REDIRECT_URI = process.env.NYLAS_REDIRECT_URI;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('❌ [NYLAS] Missing Nylas credentials in .env');
}

/**
 * Get Nylas API headers with user's access token
 */
function getHeaders(accessToken) {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    };
}

/**
 * Get Nylas client with user's tokens (auto-refreshes if expired)
 */
async function getNylasClient(userId) {
    try {
        const user = await User.findById(userId);
        if (!user || !user.nylasIntegration || !user.nylasIntegration.isConnected) {
            throw new Error('Nylas not connected. Please connect your email account.');
        }

        const { accessToken, grantId, tokenExpiry } = user.nylasIntegration;

        if (!accessToken || !grantId) {
            throw new Error('Invalid Nylas tokens. Please reconnect your email account.');
        }

        // Check if token is expired or about to expire (within 5 minutes)
        if (tokenExpiry && new Date(tokenExpiry) < new Date(Date.now() + 5 * 60 * 1000)) {
            console.log(`🔄 [NYLAS] Token expiring soon, refreshing for user ${userId}...`);
            try {
                const newTokens = await refreshNylasToken(userId);
                return {
                    accessToken: newTokens.accessToken,
                    grantId: user.nylasIntegration.grantId || newTokens.grantId
                };
            } catch (refreshErr) {
                console.error(`❌ [NYLAS] Token refresh failed for user ${userId}:`, refreshErr.message);
                user.nylasIntegration.isConnected = false;
                await user.save();
                throw new Error('Nylas connection expired. Please reconnect your email account.');
            }
        }

        return {
            accessToken: accessToken,
            grantId: grantId
        };
    } catch (error) {
        console.error('❌ [NYLAS] getNylasClient error:', error.message);
        throw error;
    }
}

/**
 * Send email via Nylas API (V3)
 */
async function sendNylasEmail(userId, to, subject, body, html = null) {
    try {
        const { accessToken, grantId } = await getNylasClient(userId);

        const payload = {
            to: [{ email: to }],
            subject: subject,
            body: html || body,
            grant_id: grantId
        };

        const response = await axios.post(
            `${API_URI}/grants/${grantId}/messages/send`,
            payload,
            { headers: getHeaders(accessToken) }
        );

        console.log(`📧 [NYLAS] Email sent to ${to} (messageId: ${response.data.id})`);
        return response.data;

    } catch (error) {
        console.error('❌ [NYLAS] Send email error:');
        if (error.response) {
            console.error('  Status:', error.response.status);
            console.error('  Data:', error.response.data);
        } else {
            console.error('  Message:', error.message);
        }
        throw error;
    }
}

/**
 * Get user's Nylas profile (email address, etc.)
 */
async function getNylasProfile(userId) {
    try {
        const { accessToken, grantId } = await getNylasClient(userId);
        
        const response = await axios.get(
            `${API_URI}/grants/${grantId}/profile`,
            { headers: getHeaders(accessToken) }
        );
        return response.data;
    } catch (error) {
        console.error('❌ [NYLAS] Get profile error:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Get Nylas auth URL for OAuth flow (V3)
 */
function getNylasAuthUrl() {
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        access_type: 'offline',
        scope: 'email,mail.send,mail.read'
    });
    
    return `https://api.nylas.com/v3/connect/auth?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens (V3)
 */
async function exchangeCodeForTokens(code) {
    try {
        const response = await axios.post(
            `${API_URI}/connect/token`,
            {
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                redirect_uri: REDIRECT_URI,
                code: code,
                grant_type: 'authorization_code'
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const data = response.data;
        
        return {
            accessToken: data.access_token,
            grantId: data.grant_id,
            emailAddress: data.email,
            expiresIn: data.expires_in || 3600
        };
    } catch (error) {
        console.error('❌ [NYLAS] Token exchange error:');
        if (error.response) {
            console.error('  Status:', error.response.status);
            console.error('  Data:', error.response.data);
        } else {
            console.error('  Message:', error.message);
        }
        throw new Error('Failed to exchange authorization code: ' + (error.response?.data?.error || error.message));
    }
}

/**
 * Refresh Nylas access token (V3)
 */
async function refreshNylasToken(userId) {
    try {
        const user = await User.findById(userId);
        if (!user || !user.nylasIntegration?.grantId) {
            throw new Error('No grant_id available. Please reconnect Nylas.');
        }

        const response = await axios.post(
            `${API_URI}/connect/token`,
            {
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_id: user.nylasIntegration.grantId,
                grant_type: 'refresh_token'
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const tokenData = response.data;
        
        user.nylasIntegration.accessToken = tokenData.access_token;
        if (tokenData.grant_id) {
            user.nylasIntegration.grantId = tokenData.grant_id;
        }
        if (tokenData.email) {
            user.nylasIntegration.emailAddress = tokenData.email;
        }
        if (tokenData.expires_in) {
            user.nylasIntegration.tokenExpiry = new Date(Date.now() + tokenData.expires_in * 1000);
        }
        user.nylasIntegration.isConnected = true;
        await user.save();

        console.log(`✅ [NYLAS] Token refreshed for user ${userId}`);
        return {
            accessToken: tokenData.access_token,
            grantId: tokenData.grant_id || user.nylasIntegration.grantId,
            expiresIn: tokenData.expires_in
        };

    } catch (error) {
        console.error('❌ [NYLAS] Token refresh error:');
        if (error.response) {
            console.error('  Status:', error.response.status);
            console.error('  Data:', error.response.data);
        } else {
            console.error('  Message:', error.message);
        }
        // If refresh fails, mark as disconnected
        try {
            const user = await User.findById(userId);
            if (user) {
                user.nylasIntegration.isConnected = false;
                await user.save();
            }
        } catch (saveErr) {
            // Ignore
        }
        throw error;
    }
}

/**
 * Check if Nylas is connected for a user
 */
async function isNylasConnected(userId) {
    try {
        const user = await User.findById(userId);
        if (!user) return false;
        return !!(user.nylasIntegration && user.nylasIntegration.isConnected);
    } catch {
        return false;
    }
}

/**
 * Get user's Nylas email address if connected
 */
async function getNylasEmail(userId) {
    try {
        const user = await User.findById(userId);
        if (!user || !user.nylasIntegration || !user.nylasIntegration.isConnected) {
            return null;
        }
        return user.nylasIntegration.emailAddress || null;
    } catch {
        return null;
    }
}

module.exports = {
    getNylasClient,
    sendNylasEmail,
    getNylasProfile,
    getNylasAuthUrl,
    exchangeCodeForTokens,
    refreshNylasToken,
    isNylasConnected,
    getNylasEmail
};
