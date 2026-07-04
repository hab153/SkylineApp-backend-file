// nylasService.js
const axios = require('axios');

// ─── GET AUTH URL ──────────────────────────────────────────────────────────────
function getAuthUrl(state) {
    const clientId = process.env.NYLAS_CLIENT_ID;
    const redirectUri = process.env.NYLAS_REDIRECT_URI || 'https://skylineapp-backend-file.onrender.com/api/auth/nylas/callback';
    const authUrl = `https://api.nylas.com/v3/connect/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=${state}`;
    return authUrl;
}

// ─── EXCHANGE CODE FOR TOKEN ──────────────────────────────────────────────────
async function exchangeCodeForToken(code) {
    const clientId = process.env.NYLAS_CLIENT_ID;
    const clientSecret = process.env.NYLAS_CLIENT_SECRET;
    const redirectUri = process.env.NYLAS_REDIRECT_URI || 'https://skylineapp-backend-file.onrender.com/api/auth/nylas/callback';

    try {
        const response = await axios.post(
            `${process.env.NYLAS_API_URI || 'https://api.us.nylas.com'}/v3/connect/token`,
            {
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUri
            }
        );

        return {
            access_token: response.data.access_token,
            refresh_token: response.data.refresh_token || null,
            grant_id: response.data.grant_id || null
        };
    } catch (error) {
        console.error('❌ [NYLAS] Token exchange failed:', error.response?.data || error.message);
        throw new Error('Failed to exchange code for token');
    }
}

// ─── GET USER EMAIL ────────────────────────────────────────────────────────────
async function getUserEmail(accessToken) {
    try {
        const response = await axios.get(
            `${process.env.NYLAS_API_URI || 'https://api.us.nylas.com'}/v3/grants/me`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data?.email || 'unknown@nylas.com';
    } catch (error) {
        console.error('❌ [NYLAS] Failed to get user email:', error.response?.data || error.message);
        return 'unknown@nylas.com';
    }
}

// ─── SEND EMAIL ────────────────────────────────────────────────────────────────
async function sendEmail(accessToken, toEmail, subject, body) {
    try {
        const response = await axios.post(
            `${process.env.NYLAS_API_URI || 'https://api.us.nylas.com'}/v3/grants/me/messages/send`,
            {
                to: [{ email: toEmail }],
                subject: subject,
                body: body
            },
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return { success: true, data: response.data };
    } catch (error) {
        console.error('❌ [NYLAS] Send email failed:', error.response?.data || error.message);
        return { success: false, error: error.response?.data?.error || error.message };
    }
}

// ─── SEND EMAIL WITH ATTACHMENTS (if needed) ──────────────────────────────────
async function sendEmailWithAttachments(accessToken, toEmail, subject, body, attachments = []) {
    try {
        const payload = {
            to: [{ email: toEmail }],
            subject: subject,
            body: body
        };

        if (attachments && attachments.length > 0) {
            payload.attachments = attachments.map(att => ({
                content_type: att.contentType || 'application/pdf',
                filename: att.filename,
                content: att.base64Content
            }));
        }

        const response = await axios.post(
            `${process.env.NYLAS_API_URI || 'https://api.us.nylas.com'}/v3/grants/me/messages/send`,
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return { success: true, data: response.data };
    } catch (error) {
        console.error('❌ [NYLAS] Send email with attachments failed:', error.response?.data || error.message);
        return { success: false, error: error.response?.data?.error || error.message };
    }
}

module.exports = {
    getAuthUrl,
    exchangeCodeForToken,
    getUserEmail,
    sendEmail,
    sendEmailWithAttachments
};
