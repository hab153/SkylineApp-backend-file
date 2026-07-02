// xssMiddleware.js
const { sanitizeObject, escapeHtml, sanitizeOutput } = require('./sanitize');

/**
 * Middleware to sanitize all incoming request data (XSS protection)
 */
function xssProtection(req, res, next) {
    // Sanitize request body
    if (req.body && typeof req.body === 'object') {
        req.body = sanitizeObject(req.body);
    }
    
    // Sanitize query parameters
    if (req.query && typeof req.query === 'object') {
        for (const key of Object.keys(req.query)) {
            if (typeof req.query[key] === 'string') {
                req.query[key] = escapeHtml(req.query[key]);
            }
        }
    }
    
    // Sanitize URL parameters
    if (req.params && typeof req.params === 'object') {
        for (const key of Object.keys(req.params)) {
            if (typeof req.params[key] === 'string') {
                req.params[key] = escapeHtml(req.params[key]);
            }
        }
    }
    
    next();
}

/**
 * Middleware to sanitize JSON responses (escape HTML in output)
 */
function xssOutputProtection(req, res, next) {
    const originalJson = res.json;
    
    res.json = function(data) {
        const sanitizedData = sanitizeOutput(data);
        originalJson.call(this, sanitizedData);
    };
    
    next();
}

/**
 * Middleware to set XSS protection headers
 */
function xssHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
}

module.exports = { 
    xssProtection, 
    xssOutputProtection, 
    xssHeaders 
};
