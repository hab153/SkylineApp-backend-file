const Joi = require('joi');
const { sanitizeObject, hasNoSQLInjection, isValidObjectId } = require('./sanitize');

/**
 * Global validation middleware
 * Validates request body against a Joi schema
 * @param {Joi.Schema} schema - Joi validation schema
 * @param {string} source - 'body', 'query', or 'params'
 * @param {array} exclude - Fields to exclude from sanitization
 */
function validate(schema, source = 'body', exclude = []) {
    return (req, res, next) => {
        let data = req[source];
        if (!data) {
            return res.status(400).json({
                error: 'Missing request data',
                message: `No data found in ${source}`
            });
        }
        const sanitizedData = sanitizeObject(data, ['password', 'currentPassword', 'newPassword', 'token']);
        req[source] = sanitizedData;
        const { error, value } = schema.validate(sanitizedData, {
            abortEarly: false,
            stripUnknown: true
        });
        if (error) {
            const errors = error.details.map(detail => ({
                field: detail.path.join('.'),
                message: detail.message
            }));
            return res.status(400).json({
                error: 'Validation failed',
                errors
            });
        }
        req[source] = value;
        next();
    };
}

/**
 * Simplified validation for common endpoint patterns
 */
const validators = {
    register: (req, res, next) => {
        const { registerSchema } = require('./validationSchemas');
        return validate(registerSchema)(req, res, next);
    },
    login: (req, res, next) => {
        const { loginSchema } = require('./validationSchemas');
        return validate(loginSchema)(req, res, next);
    },
    chat: (req, res, next) => {
        const { chatSchema } = require('./validationSchemas');
        return validate(chatSchema)(req, res, next);
    },
    batchSend: (req, res, next) => {
        const { batchSendSchema } = require('./validationSchemas');
        return validate(batchSendSchema)(req, res, next);
    },
    report: (req, res, next) => {
        const { reportSchema } = require('./validationSchemas');
        return validate(reportSchema)(req, res, next);
    },
    adminMessage: (req, res, next) => {
        const { adminMessageSchema } = require('./validationSchemas');
        return validate(adminMessageSchema)(req, res, next);
    }
};

/**
 * Middleware to validate that a field exists and is not empty
 */
function requireField(field, source = 'body') {
    return (req, res, next) => {
        const value = req[source]?.[field];
        if (!value || (typeof value === 'string' && value.trim() === '')) {
            return res.status(400).json({
                error: 'Missing required field',
                message: `${field} is required`
            });
        }
        next();
    };
}

/**
 * Middleware to validate ID parameter
 */
function validateIdParam(req, res, next) {
    const id = req.params.id || req.params.leadId || req.params.userId || req.params.sessionId;
    if (!id) {
        return res.status(400).json({
            error: 'Missing ID',
            message: 'ID parameter is required'
        });
    }
    if (!/^[a-fA-F0-9]{24}$/.test(id) && id !== 'assistant') {
        return res.status(400).json({
            error: 'Invalid ID',
            message: 'ID must be a valid MongoDB ObjectId'
        });
    }
    next();
}

/**
 * Middleware to validate email format
 */
function validateEmailFormat(req, res, next) {
    const email = req.body.email || req.body.newEmail;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({
            error: 'Invalid email',
            message: 'Please enter a valid email address'
        });
    }
    next();
}

/**
 * Middleware to validate password strength
 */
function validatePasswordStrength(req, res, next) {
    const password = req.body.password || req.body.newPassword;
    if (password) {
        const { validatePasswordStrength } = require('./sanitize');
        const result = validatePasswordStrength(password);
        if (!result.valid) {
            return res.status(400).json({
                error: 'Weak password',
                message: result.errors.join('. ')
            });
        }
    }
    next();
}

/**
 * Middleware to sanitize all string fields in request body
 */
function sanitizeBody(req, res, next) {
    if (req.body && typeof req.body === 'object') {
        const sanitized = sanitizeObject(req.body, ['password', 'currentPassword', 'newPassword']);
        req.body = sanitized;
    }
    next();
}

/**
 * Middleware to validate content type
 */
function requireContentType(contentType = 'application/json') {
    return (req, res, next) => {
        const receivedType = req.headers['content-type'] || '';
        if (!receivedType.includes(contentType)) {
            return res.status(415).json({
                error: 'Unsupported media type',
                message: `Expected ${contentType}`
            });
        }
        next();
    };
}

// ============================================================
// NEW: NoSQL injection detection middleware
// ============================================================

/**
 * Middleware to detect NoSQL injection attempts in request body/params/query
 */
function detectNoSQLInjection(req, res, next) {
    if (req.body && typeof req.body === 'object') {
        const bodyStr = JSON.stringify(req.body);
        if (hasNoSQLInjection(bodyStr)) {
            return res.status(400).json({
                error: 'Invalid request',
                message: 'Request contains invalid characters'
            });
        }
    }

    // Check params
    for (const key of Object.keys(req.params)) {
        if (hasNoSQLInjection(req.params[key])) {
            return res.status(400).json({
                error: 'Invalid parameter',
                message: 'Parameter contains invalid characters'
            });
        }
    }

    // Check query
    for (const key of Object.keys(req.query)) {
        if (hasNoSQLInjection(req.query[key])) {
            return res.status(400).json({
                error: 'Invalid query parameter',
                message: 'Query contains invalid characters'
            });
        }
    }

    next();
}

/**
 * Middleware to validate MongoDB ObjectId parameters
 */
function validateObjectId(req, res, next) {
    const idParams = ['id', 'leadId', 'userId', 'sessionId', 'messageId'];
    for (const param of idParams) {
        if (req.params[param]) {
            if (!isValidObjectId(req.params[param])) {
                return res.status(400).json({
                    error: 'Invalid ID format',
                    message: `${param} must be a valid MongoDB ObjectId`
                });
            }
        }
    }
    next();
}

module.exports = {
    validate,
    validators,
    requireField,
    validateIdParam,
    validateEmailFormat,
    validatePasswordStrength,
    sanitizeBody,
    requireContentType,
    // NEW exports
    detectNoSQLInjection,
    validateObjectId
};
