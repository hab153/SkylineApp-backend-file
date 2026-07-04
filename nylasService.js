// nylasService.js
const axios = require('axios');

// ✅ HARDCODED CALLBACK URI - Prevents env var issues on Render free tier
const RENDER_CALLBACK_URL = 'https://skylineapp-backend-file.onrender.com/api/auth/nylas/callback';
const NYLAS_API_BASE = process.env.NYLAS_API_URI || 'https://api.us.nylas.com';

// ─── GET AUTH URL ──────────────────────────────────────────────────────────────
function getAuthUrl(state) {
    const clientId = process.env.NYLAS_CLIENT_ID;

    if (!clientId) {
        throw new Error('NYLAS_CLIENT_ID is not set in environment variables');
    }

    // ✅ Use URLSearchParams for RFC-compliant encoding
    // Includes ALL required Nylas V3 OAuth parameters
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: RENDER_CALLBACK_URL,
        response_type: 'code',
        access_type: 'offline',          // REQUIRED for refresh tokens
        scope: 'openid email email.read_only email.send email.modify',
        state: state
    });

    const authUrl = `${NYLAS_API_BASE}/v3/connect/auth?${params.toString()}`;

    // ✅ Validate URL before returning to catch missing params early
    const urlObj = new URL(authUrl);
    const requiredParams = ['client_id', 'redirect_uri', 'response_type', 'access_type', 'scope', 'state'];
    const missing = requiredParams.filter(p => !urlObj.searchParams.has(p));

    if (missing.length > 0) {
        console.error('❌ [NYLAS] Auth URL missing parameters:', missing);
        throw new Error(`CRITICAL: Auth URL missing required params: ${missing.join(', ')}`);
    }

    console.log('🔗 [NYLAS] Generated auth URL:', authUrl);
    return authUrl;
}

// ─── EXCHANGE CODE FOR TOKEN ──────────────────────────────────────────────────
async function exchangeCodeForToken(code) {
    const clientId = process.env.NYLAS_CLIENT_ID;
    const clientSecret = process.env.NYLAS_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('NYLAS_CLIENT_ID or NYLAS_CLIENT_SECRET is not set');
    }

    try {
        const response = await axios.post(
            `${NYLAS_API_BASE}/v3/connect/token`,
            {
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: RENDER_CALLBACK_URL
            },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 15000
            }
        );

        return {
            access_token: response.data.access_token,
            refresh_token: response.data.refresh_token || null,
            grant_id: response.data.grant_id || null
        };
    } catch (error) {
        console.error('❌ [NYLAS] Token exchange failed:', error.response?.data || error.message);
        throw new Error(error.response?.data?.error_description || 'Failed to exchange code for token');
    }
}

// ─── GET USER EMAIL ────────────────────────────────────────────────────────────
async function getUserEmail(accessToken) {
    if (!accessToken) {
        throw new Error('Access token is required');
    }

    try {
        const response = await axios.get(
            `${NYLAS_API_BASE}/v3/grants/me`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );
        return response.data?.email || 'unknown@nylas.com';
    } catch (error) {
        console.error('❌ [NYLAS] Failed to get user email:', error.response?.data || error.message);
        return 'unknown@nylas.com';
    }
}

// ─── SEND EMAIL ───────────────────────────────────────────────────────────────
async function sendEmail(accessToken, toEmail, subject, body) {
    if (!accessToken || !toEmail) {
        throw new Error('Access token and recipient email are required');
    }

    try {
        const response = await axios.post(
            `${NYLAS_API_BASE}/v3/grants/me/messages/send`,
            {
                to: [{ email: toEmail }],
                subject: subject,
                body: body
            },
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 20000
            }
        );

        return { success: true, data: response.data };
    } catch (error) {
        console.error('❌ [NYLAS] Send email failed:', error.response?.data || error.message);
        return { success: false, error: error.response?.data?.error || error.message };
    }
}

// ─── SEND EMAIL WITH ATTACHMENTS ──────────────────────────────────────────────
async function sendEmailWithAttachments(accessToken, toEmail, subject, body, attachments = []) {
    if (!accessToken || !toEmail) {
        throw new Error('Access token and recipient email are required');
    }

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
            `${NYLAS_API_BASE}/v3/grants/me/messages/send`,
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
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
