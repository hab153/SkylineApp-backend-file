const nylas = require('./nylasClient');
const EmailAccount = require('./EmailAccount');

// ── Refresh Token Function ──
async function refreshNylasToken(userId) {
    try {
        console.log('🔄 [Nylas] Refreshing token for user:', userId);
        
        const account = await EmailAccount.findOne({ userId });
        if (!account) {
            console.log('❌ [Nylas] No account found for user:', userId);
            return null;
        }

        if (!account.refreshToken) {
            console.log('❌ [Nylas] No refresh token available. User must reconnect.');
            return null;
        }

        // ✅ Use the refresh method
        const response = await nylas.auth.refreshAccessToken({
            clientId: process.env.NYLAS_CLIENT_ID,
            clientSecret: process.env.NYLAS_API_KEY,
            refreshToken: account.refreshToken,
        });

        // ✅ Update account with new tokens
        account.accessToken = response.accessToken;
        account.tokenExpiry = new Date(Date.now() + (response.expiresIn * 1000));
        account.isConnected = true;
        account.refreshFailCount = 0;
        account.lastRefreshError = null;
        await account.save();

        console.log('✅ [Nylas] Token refreshed successfully. Expires in:', response.expiresIn, 'seconds');
        return account;

    } catch (error) {
        console.error('❌ [Nylas] Token refresh failed:', error.message);
        console.error('❌ [Nylas] Token refresh details:', error.response?.data || error);
        
        await EmailAccount.findOneAndUpdate(
            { userId },
            { 
                isConnected: false,
                $inc: { refreshFailCount: 1 },
                lastRefreshError: error.message
            }
        );
        return null;
    }
}

// ── Send Email with Auto-Refresh and Retry ──
exports.sendEmail = async (userId, to, subject, body, retryCount = 0) => {
    const MAX_RETRIES = 2;
    try {
        // ✅ Get account
        let account = await EmailAccount.findOne({ userId });
        if (!account) {
            console.error('❌ [Nylas Send] No email account found for user:', userId);
            return { success: false, error: 'No connected email account found.' };
        }

        // ✅ Check if token is expired or about to expire
        const now = new Date();
        const expiry = account.tokenExpiry ? new Date(account.tokenExpiry) : null;
        const isExpired = !expiry || expiry < now;
        const isExpiringSoon = expiry && (expiry - now) < 5 * 60 * 1000;

        if (isExpired || isExpiringSoon) {
            console.log(`⏰ [Nylas] Token ${isExpired ? 'expired' : 'expiring soon'}, refreshing...`);
            const refreshed = await refreshNylasToken(userId);
            if (refreshed) {
                account = refreshed;
                console.log('✅ [Nylas] Token refreshed successfully');
            } else {
                // ✅ Don't fail immediately - try with stale token first
                console.warn('⚠️ [Nylas] Token refresh failed, attempting with stale token...');
            }
        }

        if (!account.nylasGrantId) {
            console.error('❌ [Nylas Send] Missing grant ID for user:', userId);
            return { success: false, error: 'Grant ID not found.' };
        }

        console.log('📧 [Nylas Send] Sending email to:', to);
        console.log('📧 [Nylas Send] Using grant ID:', account.nylasGrantId);
        console.log('📧 [Nylas Send] Subject:', subject);
        console.log('📧 [Nylas Send] Body length:', body?.length || 0);

        // ✅ CORRECT v8 SDK syntax - Use the send method with proper params
        const sentMessage = await nylas.messages.send({
            identifier: account.nylasGrantId,
            requestBody: {
                to: [{ email: to }],
                subject: subject,
                body: body,
            },
        });

        console.log('✅ [Nylas Send] Email sent successfully. Message ID:', sentMessage?.id || 'unknown');
        console.log('✅ [Nylas Send] Thread ID:', sentMessage?.thread_id || 'unknown');
        
        // ✅ Return thread_id for tracking
        return { 
            success: true, 
            messageId: sentMessage?.id,
            threadId: sentMessage?.thread_id || null
        };

    } catch (error) {
        console.error(`❌ [Nylas Send] Error (attempt ${retryCount + 1}):`, error.message);
        console.error('❌ [Nylas Send] Error details:', error.response?.data || error);
        
        // ✅ If this is a token-related error and we haven't exceeded retries
        if ((error.message.includes('token') || error.message.includes('401') || error.message.includes('403')) && retryCount < MAX_RETRIES) {
            console.log(`🔄 [Nylas] Token error, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
            
            // Try to refresh the token
            const refreshed = await refreshNylasToken(userId);
            if (refreshed) {
                // Retry with fresh token
                return exports.sendEmail(userId, to, subject, body, retryCount + 1);
            }
        }
        
        // ✅ If this is a network error and we haven't exceeded retries
        if ((error.message.includes('timeout') || error.message.includes('network') || error.message.includes('ECONNREFUSED')) && retryCount < MAX_RETRIES) {
            console.log(`🔄 [Nylas] Network error, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
            
            // Wait before retry (exponential backoff)
            const waitTime = 1000 * Math.pow(2, retryCount);
            console.log(`⏳ [Nylas] Waiting ${waitTime}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            
            return exports.sendEmail(userId, to, subject, body, retryCount + 1);
        }
        
        return { 
            success: false, 
            error: error.message, 
            details: error.response?.data,
            attemptedRetries: retryCount
        };
    }
};

// ── Check Connection Status ──
exports.checkConnection = async (userId) => {
    try {
        const account = await EmailAccount.findOne({ userId });
        if (!account) {
            return { connected: false, error: 'No account found' };
        }

        const isExpired = account.tokenExpiry && new Date(account.tokenExpiry) < new Date();
        
        if (isExpired && account.refreshToken) {
            console.log('🔄 [Nylas] Status check - token expired, attempting refresh...');
            const refreshed = await refreshNylasToken(userId);
            if (refreshed) {
                return { 
                    connected: true, 
                    email: account.emailAddress,
                    isExpired: false,
                    refreshed: true
                };
            }
        }

        return {
            connected: account.isConnected && !isExpired,
            email: account.emailAddress,
            isExpired: isExpired
        };
    } catch (error) {
        console.error('❌ [Nylas] Status check error:', error.message);
        return { connected: false, error: error.message };
    }
};

// ── Get Threads ──
exports.getThreads = async (userId, limit = 10) => {
    try {
        const account = await EmailAccount.findOne({ userId, isConnected: true });
        if (!account) {
            console.error('❌ [Nylas Threads] No connected email account for user:', userId);
            return [];
        }

        console.log('📬 [Nylas Threads] Fetching threads for grant:', account.nylasGrantId);

        const threads = await nylas.threads.list({
            identifier: account.nylasGrantId,
            queryParams: { limit: limit },
        });

        console.log('✅ [Nylas Threads] Fetched', threads?.length || 0, 'threads');
        return threads || [];
    } catch (error) {
        console.error('❌ [Nylas Threads] Error:', error.message);
        console.error('❌ [Nylas Threads] Error details:', error.response?.data || error);
        return [];
    }
};

// ── Export refresh function ──
exports.refreshNylasToken = refreshNylasToken;
