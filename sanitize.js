// sanitize.js

/**
 * Sanitize string input (remove XSS vectors)
 * @param {string} input - The string to sanitize
 * @returns {string} - Sanitized string
 */
function sanitizeString(input) {
    if (!input || typeof input !== 'string') return input;
    
    // Remove any HTML tags
    let sanitized = input.replace(/<[^>]*>/g, '');
    
    // Remove any script-like content
    sanitized = sanitized.replace(/javascript:/gi, '');
    sanitized = sanitized.replace(/on\w+=/gi, '');
    sanitized = sanitized.replace(/data:text\/html/gi, '');
    
    // Remove extra whitespace (preserve meaningful spaces)
    sanitized = sanitized.replace(/\s+/g, ' ').trim();
    
    // Escape any remaining special characters
    sanitized = sanitized
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    
    return sanitized;
}

/**
 * Sanitize email address
 * @param {string} email - The email to sanitize
 * @returns {string} - Sanitized email (lowercase, trimmed)
 */
function sanitizeEmail(email) {
    if (!email || typeof email !== 'string') return email;
    return email.toLowerCase().trim();
}

/**
 * Sanitize username
 * @param {string} username - The username to sanitize
 * @returns {string} - Sanitized username
 */
function sanitizeUsername(username) {
    if (!username || typeof username !== 'string') return username;
    // Remove any special characters except letters, numbers, underscore
    return username.trim().replace(/[^a-zA-Z0-9_]/g, '');
}

/**
 * Sanitize an entire object (recursive)
 * @param {object} obj - The object to sanitize
 * @param {array} exclude - Fields to exclude from sanitization
 * @returns {object} - Sanitized object
 */
function sanitizeObject(obj, exclude = []) {
    if (!obj || typeof obj !== 'object') return obj;
    
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        // Skip excluded fields
        if (exclude.includes(key)) {
            result[key] = value;
            continue;
        }
        
        if (typeof value === 'string') {
            // Special handling for email fields
            if (key === 'email' || key === 'newEmail') {
                result[key] = sanitizeEmail(value);
            } else if (key === 'username' || key === 'identifier') {
                result[key] = sanitizeUsername(value);
            } else {
                result[key] = sanitizeString(value);
            }
        } else if (Array.isArray(value)) {
            result[key] = value.map(item => {
                if (typeof item === 'string') return sanitizeString(item);
                if (typeof item === 'object') return sanitizeObject(item, exclude);
                return item;
            });
        } else if (typeof value === 'object' && value !== null) {
            result[key] = sanitizeObject(value, exclude);
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Validate that a string does not contain injection patterns
 * @param {string} input - The string to check
 * @returns {boolean} - True if safe
 */
function isSafeString(input) {
    if (!input || typeof input !== 'string') return true;
    
    // Check for dangerous patterns
    const dangerousPatterns = [
        /<script/i,
        /javascript:/i,
        /on\w+=/i,
        /alert\(/i,
        /eval\(/i,
        /document\./i,
        /window\./i,
        /<iframe/i,
        /<object/i,
        /<embed/i,
        /<form/i,
        /<input/i
    ];
    
    for (const pattern of dangerousPatterns) {
        if (pattern.test(input)) {
            return false;
        }
    }
    return true;
}

/**
 * Validate that a string is a valid password
 * @param {string} password - The password to check
 * @returns {object} - { valid: boolean, errors: string[] }
 */
function validatePasswordStrength(password) {
    const errors = [];
    
    if (!password || password.length < 8) {
        errors.push('Password must be at least 8 characters');
    }
    if (!/[a-z]/.test(password)) {
        errors.push('Password must contain at least one lowercase letter');
    }
    if (!/[A-Z]/.test(password)) {
        errors.push('Password must contain at least one uppercase letter');
    }
    if (!/\d/.test(password)) {
        errors.push('Password must contain at least one number');
    }
    if (password.length > 100) {
        errors.push('Password cannot exceed 100 characters');
    }
    
    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Check if a string is a valid email
 * @param {string} email - The email to check
 * @returns {boolean} - True if valid
 */
function isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

module.exports = {
    sanitizeString,
    sanitizeEmail,
    sanitizeUsername,
    sanitizeObject,
    isSafeString,
    validatePasswordStrength,
    isValidEmail
};
