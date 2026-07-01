// csrf.js
const crypto = require('crypto');
const mongoose = require('mongoose');

// CSRF Token Schema – store tokens per user
const CsrfTokenSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true
    },
    token: {
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 86400 // auto-delete after 24 hours
    }
});

const CsrfToken = mongoose.model('CsrfToken', CsrfTokenSchema);

/**
 * Generate a secure CSRF token for a user
 */
async function generateCsrfToken(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    
    await CsrfToken.findOneAndUpdate(
        { userId },
        { token, createdAt: new Date() },
        { upsert: true, new: true }
    );
    
    return token;
}

/**
 * Validate CSRF token for a user
 */
async function validateCsrfToken(userId, token) {
    if (!userId || !token) return false;
    
    const record = await CsrfToken.findOne({ userId });
    if (!record) return false;
    
    // Constant-time comparison to prevent timing attacks
    return crypto.timingSafeEqual(
        Buffer.from(record.token),
        Buffer.from(token)
    );
}

/**
 * Delete CSRF token for a user (on logout)
 */
async function deleteCsrfToken(userId) {
    await CsrfToken.findOneAndDelete({ userId });
}

/**
 * Middleware to verify CSRF token on state-changing requests
 */
function csrfProtection(req, res, next) {
    // Skip CSRF check for safe methods
    const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
    if (safeMethods.includes(req.method)) {
        return next();
    }

    // Skip for webhooks
    if (req.path.startsWith('/api/webhooks') || req.path.startsWith('/api/flutterwave-webhook')) {
        return next();
    }

    const token = req.headers['x-csrf-token'] || req.body._csrf;
    if (!token) {
        return res.status(403).json({
            error: 'CSRF token missing',
            message: 'Please include the CSRF token in the X-CSRF-Token header'
        });
    }

    const userId = req.userId;
    if (!userId) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'User not authenticated'
        });
    }

    validateCsrfToken(userId, token)
        .then(isValid => {
            if (!isValid) {
                return res.status(403).json({
                    error: 'Invalid CSRF token',
                    message: 'The CSRF token is invalid or expired'
                });
            }
            next();
        })
        .catch(err => {
            console.error('CSRF validation error:', err);
            return res.status(500).json({ error: 'Server error validating CSRF token' });
        });
}

/**
 * Middleware to set CSRF token in response
 */
async function setCsrfToken(req, res, next) {
    try {
        const userId = req.userId || req.user?.id;
        if (!userId) {
            return next();
        }
        const token = await generateCsrfToken(userId);
        res.setHeader('X-CSRF-Token', token);
        // Also include in response body if it's a JSON response
        const originalJson = res.json;
        res.json = function(data) {
            if (data && typeof data === 'object') {
                data.csrfToken = token;
            }
            originalJson.call(this, data);
        };
        next();
    } catch (err) {
        console.error('Error setting CSRF token:', err);
        next();
    }
}

module.exports = {
    generateCsrfToken,
    validateCsrfToken,
    deleteCsrfToken,
    csrfProtection,
    setCsrfToken,
    CsrfToken
};
