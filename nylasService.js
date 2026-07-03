const axios = require('axios');
const { decrypt } = require('./encryption');

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

    console.log('🔧 [NYLAS DEBUG] getAuthUrl called with state:', state);
    console.log('🔧 [NYLAS DEBUG] NYLAS_CLIENT_ID:', clientId ? '✅ Present' : '❌ MISSING');
    console.log('🔧 [NYLAS DEBUG] NYLAS_API_BASE:', NYLAS_API_BASE);
    console.log('🔧 [NYLAS DEBUG] RENDER_CALLBACK_URL:', RENDER_CALLBACK_URL);

    if (!clientId) {
        console.error('❌ [NYLAS DEBUG] NYLAS_CLIENT_ID is not set!');
        throw new Error('NYLAS_CLIENT_ID is not set in environment variables');
    }

    // Build URL manually with response_type FIRST
    const baseUrl = `${NYLAS_API_BASE}/v3/connect/auth`;
    
    // response_type MUST be first
    let url = baseUrl + '?';
    url += `response_type=code`;
    url += `&client_id=${encodeURIComponent(clientId)}`;
    url += `&redirect_uri=${encodeURIComponent(RENDER_CALLBACK_URL)}`;
    url += `&access_type=offline`;
    url += `&scope=${encodeURIComponent('openid email email.read_only email.send email.modify')}`;
    url += `&state=${encodeURIComponent(state)}`;

    console.log('🔗 [NYLAS DEBUG] Generated full auth URL:', url);
    console.log('🔧 [NYLAS DEBUG] URL contains response_type=code:', url.includes('response_type=code') ? '✅ Yes' : '❌ No');
    console.log('🔧 [NYLAS DEBUG] URL contains access_type=offline:', url.includes('access_type=offline') ? '✅ Yes' : '❌ No');
    
    return url;
}

/**
 * Exchanges the authorization code for an access token.
 */
async function exchangeCodeForToken(code) {
    console.log('🔧 [NYLAS DEBUG] exchangeCodeForToken called with code:', code ? '✅ Present' : '❌ MISSING');
    console.log('🔧 [NYLAS DEBUG] NYLAS_CLIENT_ID:', process.env.NYLAS_CLIENT_ID ? '✅ Present' : '❌ MISSING');
    console.log('🔧 [NYLAS DEBUG] NYLAS_CLIENT_SECRET:', process.env.NYLAS_CLIENT_SECRET ? '✅ Present' : '❌ MISSING');

    try {
        const requestBody = {
            client_id:     process.env.NYLAS_CLIENT_ID,
            client_secret: process.env.NYLAS_CLIENT_SECRET,
            grant_type:    'authorization_code',
            code:          code,
            redirect_uri:  RENDER_CALLBACK_URL,
        };

        console.log('🔧 [NYLAS DEBUG] Request body for token exchange:', JSON.stringify(requestBody, null, 2));

        const response = await axios.post(
            `${NYLAS_API_BASE}/v3/connect/token`,
            requestBody,
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 15000,
            }
        );
        console.log('✅ [NYLAS] Token exchange successful.');
        console.log('🔧 [NYLAS DEBUG] Token response keys:', Object.keys(response.data));
        console.log('🔧 [NYLAS DEBUG] Has access_token:', !!response.data.access_token);
        console.log('🔧 [NYLAS DEBUG] Has refresh_token:', !!response.data.refresh_token);
        console.log('🔧 [NYLAS DEBUG] Has grant_id:', !!response.data.grant_id);
        return response.data;
    } catch (error) {
        console.error('❌ [NYLAS] Token Exchange Error:');
        if (error.response) {
            console.error('🔧 [NYLAS DEBUG] Status:', error.response.status);
            console.error('🔧 [NYLAS DEBUG] Headers:', error.response.headers);
            console.error('🔧 [NYLAS DEBUG] Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('🔧 [NYLAS DEBUG] Error message:', error.message);
        }
        throw error;
    }
}

/**
 * Gets the user's email address from Nylas after token exchange.
 */
async function getUserEmail(accessToken) {
    console.log('🔧 [NYLAS DEBUG] getUserEmail called');
    console.log('🔧 [NYLAS DEBUG] Access token present:', !!accessToken);
    console.log('🔧 [NYLAS DEBUG] Access token length:', accessToken ? accessToken.length : 0);

    try {
        const decryptedToken = decrypt(accessToken) || accessToken;
        console.log('🔧 [NYLAS DEBUG] Decrypted token present:', !!decryptedToken);
        
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
        console.log('🔧 [NYLAS DEBUG] Email found:', email || '❌ No email');
        if (!email) throw new Error('Email field not found in grant response');
        return email;
    } catch (error) {
        console.error('❌ [NYLAS] Get User Email Error:');
        if (error.response) {
            console.error('🔧 [NYLAS DEBUG] Status:', error.response.status);
            console.error('🔧 [NYLAS DEBUG] Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('🔧 [NYLAS DEBUG] Error message:', error.message);
        }
        throw error;
    }
}

/**
 * Sends an email on behalf of the connected user via their grant.
 */
async function sendEmail(accessToken, to, subject, body) {
    console.log('🔧 [NYLAS DEBUG] sendEmail called to:', to);
    console.log('🔧 [NYLAS DEBUG] Access token present:', !!accessToken);

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
        if (error.response) {
            console.error('🔧 [NYLAS DEBUG] Status:', error.response.status);
            console.error('🔧 [NYLAS DEBUG] Data:', JSON.stringify(error.response.data, null, 2));
        }
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
