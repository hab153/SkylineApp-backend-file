// dailyLimitMiddleware.js
const { checkAndIncrement } = require('./limitService');

// ─── HELPER: Get limit message ───
function getLimitMessage(type) {
    const messages = {
        email: 'Daily email & message limit reached. Please upgrade your plan or wait 24 hours.',
        research: 'Daily research limit reached. Please upgrade your plan or wait 24 hours.',
        chat: 'Daily assistant chat limit reached. Please upgrade your plan or wait 24 hours.'
    };
    return messages[type] || 'Daily limit reached.';
}

// ─── CHECK DAILY LIMIT (Research/Page) ───
const checkDailyLimit = async (req, res, next) => {
    console.log('🛡️ [MIDDLEWARE] checkDailyLimit called for user:', req.userId);
    try {
        const result = await checkAndIncrement(req.userId, 'research');
        console.log('🛡️ [MIDDLEWARE] Limit Check Result:', result);
        
        if (!result.allowed) {
            console.log('🚫 [MIDDLEWARE] Limit reached! Blocking request.');
            return res.status(429).json({ 
                success: false, 
                message: getLimitMessage('research'),
                limit: result.limit,
                remaining: 0
            });
        }
        
        req.remainingLimits = result;
        console.log('✅ [MIDDLEWARE] Limit passed. Remaining:', result.remaining);
        next();
    } catch (error) {
        console.error('❌ [MIDDLEWARE] Error in checkDailyLimit:', error.message);
        res.status(500).json({ message: 'Server error checking research limit' });
    }
};

// ─── CHECK EMAIL SEND LIMIT ───
const checkAndIncrementSendLimit = async (userId) => {
    try {
        const result = await checkAndIncrement(userId, 'email');
        if (!result.allowed) {
            throw new Error(getLimitMessage('email'));
        }
        return { remaining: result.remaining, limit: result.limit };
    } catch (error) {
        throw error;
    }
};

// ─── CHECK ASSISTANT LIMIT ───
const checkAssistantLimit = async (req, res, next) => {
    try {
        const result = await checkAndIncrement(req.userId, 'chat');
        if (!result.allowed) {
            return res.status(429).json({ 
                success: false, 
                message: getLimitMessage('chat'),
                limit: result.limit,
                remaining: 0
            });
        }
        req.remainingLimits = result;
        next();
    } catch (error) {
        console.error('❌ [ASSISTANT LIMIT] Error:', error.message);
        res.status(500).json({ message: 'Server error checking assistant limit' });
    }
};

// ─── PLACEHOLDERS FOR EXISTING MIDDLEWARE CALLS ───
const checkHintLimit = async (req, res, next) => next();
const checkSuggestFollowUpLimit = async (req, res, next) => next();
const checkAutoFollowUpLimit = async (req, res, next) => next();

module.exports = { 
    checkDailyLimit, 
    checkHintLimit, 
    checkSuggestFollowUpLimit,
    checkAutoFollowUpLimit,
    checkAssistantLimit,
    checkAndIncrementSendLimit
};
