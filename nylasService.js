const axios = require('axios');
const { decrypt } = require('./encryption');

// Use api.us.nylas.com for the US region
const NYLAS_API_BASE = process.env.NYLAS_API_URI || 'https://api.us.nylas.com';

// Must exactly match what is registered in your Nylas Dashboard
const RENDER_CALLBACK_URL = 'https://skylineapp-backend-file.onrender.com/api/auth/nylas/callback';

/**
 * Generates the Nylas OAuth URL for the user to connect their email.
 */
function getAuthUrl(state) {
    const clientId = process.env.NYLAS_CLIENT_ID;
    if (!clientId) {
        throw new Error('NYLAS_CLIENT_ID is not set in environment variables');
    }

    // Manual URL construction – ensures parameters are correctly formatted
    const baseUrl = `${NYLAS_API_BASE}/v3/connect/auth`;
    const params = [
        `client_id=${encodeURIComponent(clientId)}`,
        `redirect_uri=${encodeURIComponent(RENDER_CALLBACK_URL)}`,
        `response_type=code`,
        `access_type=offline`,
        `scope=${encodeURIComponent('openid email email.read_only email.send email.modify')}`,
        `state=${encodeURIComponent(state)}`
    ].join('&');
    
    const url = `${baseUrl}?${params}`;
    console.log('🔗 [NYLAS] Generated auth URL:', url);
    
    return url;
}

/**
 * Exchanges the authorization code for an access token.
 */
async function exchangeCodeForToken(code) {
    try {
        const response = await axios.post(
            `${NYLAS_API_BASE}/v3/connect/token`,
            {
                client_id:     process.env.NYLAS_CLIENT_ID,
                client_secret: process.env.NYLAS_CLIENT_SECRET,
                grant_type:    'authorization_code',
                code:          code,
                redirect_uri:  RENDER_CALLBACK_URL,
            },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 15000,
            }
        );
        console.log('✅ [NYLAS] Token exchange successful.');
        return response.data;
    } catch (error) {
        console.error('❌ [NYLAS] Token Exchange Error:', error.response ? error.response.data : error.message);
        throw error;
    }
}

/**
 * Gets the user's email address from Nylas after token exchange.
 */
async function getUserEmail(accessToken) {
    try {
        const decryptedToken = decrypt(accessToken) || accessToken;
        const response = await axios.get(
            `${NYLAS_API_BASE}/v3/grants/me`,
            {
                headers: {
                    'Authorization': `Bearer ${decryptedToken}`,
                    'Content-Type':  'application/json',
                },
                timeout: 10000,
            }
        );
        const email = response.data?.data?.email || response.data?.email;
        if (!email) throw new Error('Email field not found in grant response');
        return email;
    } catch (error) {
        console.error('❌ [NYLAS] Get User Email Error:', error.response ? error.response.data : error.message);
        throw error;
    }
}

/**
 * Sends an email on behalf of the connected user via their grant.
 */
async function sendEmail(accessToken, to, subject, body) {
    try {
        const decryptedToken = decrypt(accessToken) || accessToken;
        const response = await axios.post(
            `${NYLAS_API_BASE}/v3/grants/me/messages/send`,
            {
                to:      [{ email: to }],
                subject: subject,
                body:    body,
            },
            {
                headers: {
                    'Authorization': `Bearer ${decryptedToken}`,
                    'Content-Type':  'application/json',
                },
                timeout: 20000,
            }
        );
        console.log(`✅ [NYLAS] Email sent to ${to}. Message ID: ${response.data?.data?.id || response.data?.id}`);
        return {
            success:   true,
            messageId: response.data?.data?.id || response.data?.id,
        };
    } catch (error) {
        const errDetail = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error(`❌ [NYLAS] Send Email Error to ${to}: ${errDetail}`);
        return {
            success: false,
            error:   errDetail,
        };
    }
}

/**
 * Reads recent emails from the user's inbox.
 */
async function getRecentEmails(accessToken, limit = 10) {
    try {
        const decryptedToken = decrypt(accessToken) || accessToken;
        const response = await axios.get(
            `${NYLAS_API_BASE}/v3/grants/me/messages`,
            {
                params:  { limit },
                headers: {
                    'Authorization': `Bearer ${decryptedToken}`,
                    'Content-Type':  'application/json',
                },
                timeout: 10000,
            }
        );
        return response.data?.data || response.data || [];
    } catch (error) {
        console.error('❌ [NYLAS] Get Recent Emails Error:', error.response ? error.response.data : error.message);
        return [];
    }
}

module.exports = {
    getAuthUrl,
    exchangeCodeForToken,
    getUserEmail,
    sendEmail,
    getRecentEmails,
};
