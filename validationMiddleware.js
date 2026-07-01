// validationMiddleware.js
const Joi = require('joi');
const { sanitizeObject } = require('./sanitize');

/**
 * Global validation middleware
 * Validates request body against a Joi schema
 * @param {Joi.Schema} schema - Joi validation schema
 * @param {string} source - 'body', 'query', or 'params'
 * @param {array} exclude - Fields to exclude from sanitization
 */
function validate(schema, source = 'body', exclude = []) {
    return (req, res, next) => {
        // Get data from the specified source
        let data = req[source];
        
        if (!data) {
            return res.status(400).json({
                error: 'Missing request data',
                message: `No data found in ${source}`
            });
        }
        
        // Sanitize input (exclude sensitive fields like password)
        const sanitizedData = sanitizeObject(data, ['password', 'currentPassword', 'newPassword', 'token']);
        
        // Replace req[source] with sanitized data
        req[source] = sanitizedData;
        
        // Validate against schema
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
        
        // Replace with validated (and possibly transformed) value
        req[source] = value;
        next();
    };
}

/**
 * Simplified validation for common endpoint patterns
 */
const validators = {
    /**
     * Validate registration request
     */
    register: (req, res, next) => {
        const { registerSchema } = require('./validationSchemas');
        return validate(registerSchema)(req, res, next);
    },

    /**
     * Validate login request
     */
    login: (req, res, next) => {
        const { loginSchema } = require('./validationSchemas');
        return validate(loginSchema)(req, res, next);
    },

    /**
     * Validate chat message
     */
    chat: (req, res, next) => {
        const { chatSchema } = require('./validationSchemas');
        return validate(chatSchema)(req, res, next);
    },

    /**
     * Validate batch send
     */
    batchSend: (req, res, next) => {
        const { batchSendSchema } = require('./validationSchemas');
        return validate(batchSendSchema)(req, res, next);
    },

    /**
     * Validate report submission
     */
    report: (req, res, next) => {
        const { reportSchema } = require('./validationSchemas');
        return validate(reportSchema)(req, res, next);
    },

    /**
     * Validate admin message
     */
    adminMessage: (req, res, next) => {
        const { adminMessageSchema } = require('./validationSchemas');
        return validate(adminMessageSchema)(req, res, next);
    }
};

/**
 * Middleware to validate that a field exists and is not empty
 * @param {string} field - Field name
 * @param {string} source - 'body', 'query', or 'params'
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
    // Check if it's a valid MongoDB ObjectId (24 hex chars)
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
        const { sanitize } = require('./sanitize');
        const result = sanitize.validatePasswordStrength(password);
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
        // Don't sanitize passwords (leave them untouched)
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

module.exports = {
    validate,
    validators,
    requireField,
    validateIdParam,
    validateEmailFormat,
    validatePasswordStrength,
    sanitizeBody,
    requireContentType
};
