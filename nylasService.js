// nylasService.js
const axios = require('axios');

const NYLAS_API_BASE = 'https://api.nylas.com'; // Use https://api.us.nylas.com if you are on the US region

/**
 * Generates the URL for the user to connect their email.
 */
function getAuthUrl(userId) {
    const clientId = process.env.NYLAS_CLIENT_ID;
    const redirectUri = 'https://skylineai-app.vercel.app/api/auth/nylas/callback';
    
    // Nylas OAuth2 URL structure
    return `${NYLAS_API_BASE}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&login_hint=${userId}`;
}

/**
 * Exchanges the authorization code for an access token.
 */
async function exchangeCodeForToken(code) {
    try {
        const response = await axios.post(`${NYLAS_API_BASE}/oauth/token`, {
            client_id: process.env.NYLAS_CLIENT_ID,
            client_secret: process.env.NYLAS_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: 'https://skylineai-app.vercel.app/api/auth/nylas/callback'
        });
        return response.data;
    } catch (error) {
        console.error('❌ Token Exchange Error:', error.response ? error.response.data : error.message);
        throw error;
    }
}

/**
 * Gets the user's email address using the access token.
 */
async function getUserEmail(accessToken) {
    try {
        const response = await axios.get(`${NYLAS_API_BASE}/account`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });
        return response.data.email_address;
    } catch (error) {
        console.error('❌ Get Account Error:', error.response ? error.response.data : error.message);
        throw error;
    }
}

/**
 * Sends an email on behalf of the connected user.
 * @param {string} accessToken - The user's Nylas access token (Grant ID in v3, but we use token for v2 compatibility here)
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} body - Email body
 */
async function sendEmail(accessToken, to, subject, body) {
    try {
        // Note: This endpoint structure is for Nylas V2. If you are using V3, the endpoint is /v3/grants/{grant_id}/messages/send
        // For maximum compatibility with your current setup, we assume V2 style token usage.
        const response = await axios.post(`${NYLAS_API_BASE}/send`, {
            to: [{ email: to }],
            subject: subject,
            body: body
        }, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });
        return { success: true, messageId: response.data.id };
    } catch (error) {
        console.error('❌ Send Email Error:', error.response ? error.response.data : error.message);
        return { success: false, error: error.message };
    }
}

module.exports = { getAuthUrl, exchangeCodeForToken, getUserEmail, sendEmail };
