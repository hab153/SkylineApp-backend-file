// nylasService.js
const axios = require('axios');

// Use api.us.nylas.com if you are on the US region
const NYLAS_API_BASE = process.env.NYLAS_API_URI || 'https://api.us.nylas.com'; 

// Define the Render Callback URL here
const RENDER_CALLBACK_URL = 'https://skylineapp-backend-file.onrender.com/api/auth/nylas/callback';

/**
 * Generates the URL for the user to connect their email.
 */
function getAuthUrl(userId) {
    const clientId = process.env.NYLAS_CLIENT_ID;
    
    // Use the Render Callback URL
    return `${NYLAS_API_BASE}/v3/connect/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(RENDER_CALLBACK_URL)}&response_type=code&scope=email.read_only,email.send`;
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
            redirect_uri: RENDER_CALLBACK_URL // Must match Nylas Dashboard
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
        const response = await axios.get(`${NYLAS_API_BASE}/v3/grants`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });
        
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
