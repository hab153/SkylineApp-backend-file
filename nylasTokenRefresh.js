const axios = require('axios');
const EmailAccount = require('./EmailAccount');

/**
 * Refreshes a Nylas access token using the refresh token.
 * Retries once after 2 seconds if the first attempt fails.
 * @param {Object} emailAccount - Mongoose document from EmailAccount model
 * @param {number} attempt - Internal retry counter (default 1)
 * @returns {Promise<string>} New access token
 */
async function refreshNylasToken(emailAccount, attempt = 1) {
    try {
        const response = await axios.post(
            `${process.env.NYLAS_API_URI || 'https://api.us.nylas.com'}/v3/connect/token`,
            {
                client_id:     process.env.NYLAS_CLIENT_ID,
                client_secret: process.env.NYLAS_CLIENT_SECRET,
                grant_type:    'refresh_token',
                refresh_token: emailAccount.refreshToken
            }
        );

        const newAccessToken = response.data.access_token;

        emailAccount.accessToken      = newAccessToken;
        emailAccount.tokenExpiry      = new Date(Date.now() + 3600 * 1000);
        emailAccount.refreshFailCount = 0;
        await emailAccount.save();

        console.log(`🔄 [NYLAS] Token refreshed successfully (attempt ${attempt}).`);
        return newAccessToken;

    } catch (err) {
        console.error(
            `❌ [NYLAS] Token refresh failed (attempt ${attempt}):`,
            err.response?.status,
            err.response?.data?.error_description || err.message
        );

        if (attempt === 1) {
            console.log(`⏳ [NYLAS] Retrying token refresh in 2 seconds...`);
            await new Promise(r => setTimeout(r, 2000));
            return refreshNylasToken(emailAccount, 2);
        }

        try {
            emailAccount.refreshFailCount = (emailAccount.refreshFailCount || 0) + 1;
            emailAccount.lastRefreshError = err.response?.data?.error_description || err.message;
            await emailAccount.save();
        } catch (saveErr) {
            console.warn('[NYLAS] Could not save fail count:', saveErr.message);
        }

        throw err;
    }
}

/**
 * Proactive token refresh job – finds all connected email accounts whose tokens
 * expire within the next 30 minutes and refreshes them.
 */
async function proactiveTokenRefresh() {
    try {
        const soon = new Date(Date.now() + 30 * 60 * 1000);
        const accounts = await EmailAccount.find({
            isConnected:  true,
            refreshToken: { $exists: true, $ne: null },
            tokenExpiry:  { $lte: soon }
        });
        if (accounts.length === 0) return;
        console.log(`🔁 [PROACTIVE] Refreshing ${accounts.length} token(s) before expiry...`);

        for (const account of accounts) {
            try {
                await refreshNylasToken(account);
            } catch (err) {
                console.warn(`⚠️ [PROACTIVE] Could not refresh token for ${account.emailAddress}: ${err.message}`);
            }
        }
    } catch (err) {
        console.error('❌ [PROACTIVE] Token refresh job error:', err.message);
    }
}

/**
 * Starts the proactive token refresh job.
 * Runs once immediately, then every 10 minutes.
 */
function startTokenRefreshJob() {
    proactiveTokenRefresh();
    setInterval(proactiveTokenRefresh, 10 * 60 * 1000);
    console.log('🔁 [PROACTIVE] Token refresh job started (every 10 min)');
}

module.exports = { refreshNylasToken, startTokenRefreshJob };
