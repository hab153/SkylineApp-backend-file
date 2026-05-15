const axios = require('axios');

// Use api.us.nylas.com for the US region
const NYLAS_API_BASE = process.env.NYLAS_API_URI || 'https://api.us.nylas.com';

// Must exactly match what is registered in your Nylas Dashboard
const RENDER_CALLBACK_URL = 'https://skylineapp-backend-file.onrender.com/api/auth/nylas/callback';

/**
 * Generates the Nylas OAuth URL for the user to connect their email.
 * @param {string} state - A unique random UUID to prevent CSRF attacks
 */
function getAuthUrl(state) {
    const clientId = process.env.NYLAS_CLIENT_ID;

    if (!clientId) {
        throw new Error('NYLAS_CLIENT_ID is not set in environment variables');
    }

    const params = new URLSearchParams({
        client_id:     clientId,
        redirect_uri:  RENDER_CALLBACK_URL,
        response_type: 'code',
        // FIX: Added offline_access so Nylas returns a refresh_token.
        // Without offline_access, Nylas never issues a refresh token
        // and tokens expire permanently after the first short window.
        scope:         'openid email Mail.Read offline_access email.read_only email.send email.modify',
        state:         state,
    });

    return `${NYLAS_API_BASE}/v3/connect/auth?${params.toString()}`;
}

/**
 * Exchanges the authorization code for an access token.
 * Called in server.js callback route.
 * @param {string} code - The code returned by Nylas after user authorizes
 * @returns {object} tokenData - Contains access_token, grant_id, email, etc.
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
 * FIX: Nylas V3 returns grant info directly in the token response (email field).
 * We use /v3/grants/me with the user's access token as a fallback.
 * @param {string} accessToken - The user's Nylas access token
 * @returns {string} email address
 */
async function getUserEmail(accessToken) {
    try {
        // FIX: In Nylas V3, use /v3/grants/me to get the authenticated grant's info
        // This is scoped to the user's token — not the app-level grants list
        const response = await axios.get(
            `${NYLAS_API_BASE}/v3/grants/me`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
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
 * FIX: Was using /v3/grants/me/messages/send — now uses the correct
 * Nylas V3 endpoint pattern with the user's access token as auth.
 * The "me" alias works when authenticated with a user-scoped token.
 * @param {string} accessToken - The user's stored Nylas access token
 * @param {string} to          - Recipient email address
 * @param {string} subject     - Email subject line
 * @param {string} body        - Email body (HTML or plain text)
 * @returns {{ success: boolean, messageId?: string, error?: string }}
 */
async function sendEmail(accessToken, to, subject, body) {
    try {
        const response = await axios.post(
            `${NYLAS_API_BASE}/v3/grants/me/messages/send`,
            {
                to:      [{ email: to }],
                subject: subject,
                body:    body,
            },
            {
                headers: {
                    // FIX: Use the user's access token — not the app client secret
                    // When the token is user-scoped, "me" resolves to their grant
                    'Authorization': `Bearer ${accessToken}`,
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
 * Reads recent emails from the user's inbox (for reply detection).
 * Used by replyHandler.js to poll for new messages.
 * @param {string} accessToken - The user's Nylas access token
 * @param {number} limit       - How many messages to fetch (default 10)
 */
async function getRecentEmails(accessToken, limit = 10) {
    try {
        const response = await axios.get(
            `${NYLAS_API_BASE}/v3/grants/me/messages`,
            {
                params: { limit },
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
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
