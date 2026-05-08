// nylasService.js
const axios = require('axios');

// Use api.us.nylas.com if you are on the US region, otherwise api.nylas.com
const NYLAS_API_BASE = process.env.NYLAS_API_URI || 'https://api.us.nylas.com'; 

/**
 * Generates the URL for the user to connect their email.
 */
function getAuthUrl(userId) {
    const clientId = process.env.NYLAS_CLIENT_ID;
    const redirectUri = 'https://skylineai-app.vercel.app/api/auth/nylas/callback';
    
    // Nylas V3 OAuth2 URL structure
    // Removed login_hint to prevent 400 errors if userId is not an email
    return `${NYLAS_API_BASE}/v3/connect/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=email.read_only,email.send`;
}

/**
 * Exchanges the authorization code for an access token.
 */
async function exchangeCodeForToken(code) {
    try {
        const response = await axios.post(`${NYLAS_API_BASE}/v3/connect/token`, {
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
        // In V3, we get account info from the /v3/grants endpoint
        const response = await axios.get(`${NYLAS_API_BASE}/v3/grants`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });
        
        // The first grant is usually the one we just created
        if (response.data && response.data.length > 0) {
            return response.data[0].email_address;
        }
        throw new Error('No grants found');
    } catch (error) {
        console.error('❌ Get Account Error:', error.response ? error.response.data : error.message);
        throw error;
    }
}

/**
 * Sends an email on behalf of the connected user.
 */
async function sendEmail(accessToken, to, subject, body) {
    try {
        // Nylas V3 Send Endpoint
        const response = await axios.post(`${NYLAS_API_BASE}/v3/grants/me/messages/send`, {
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
