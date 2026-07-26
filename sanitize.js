// sanitize.js

/**
 * Sanitize string input - SAFE VERSION
 * Only escapes dangerous characters, does NOT remove content
 * @param {string} input - The string to sanitize
 * @returns {string} - Sanitized string (escaped, but content preserved)
 */
function sanitizeString(input) {
    if (!input || typeof input !== 'string') return input;
    
    // ✅ Only escape dangerous characters, don't remove anything
    let sanitized = String(input);
    
    // ✅ Escape HTML entities to prevent XSS
    sanitized = sanitized
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/`/g, '&#x60;');
    
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
 * Sanitize username - ✅ FIXED: Preserves original username format, only removes dangerous characters
 * @param {string} username - The username to sanitize
 * @returns {string} - Sanitized username
 */
function sanitizeUsername(username) {
    if (!username || typeof username !== 'string') return username;
    // ✅ Only remove dangerous characters, but keep letters, numbers, underscores, and dots
    // This allows usernames like "john.doe" or "john_doe"
    return username.trim().replace(/[^a-zA-Z0-9_.]/g, '');
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

// ============================================================
// XSS PROTECTION FUNCTIONS
// ============================================================

/**
 * Escape HTML special characters to prevent XSS attacks
 * @param {string} str - The string to escape
 * @returns {string} - Escaped string safe for HTML output
 */
function escapeHtml(str) {
    if (!str || typeof str !== 'string') return str;
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Sanitize output for JSON responses (HTML-safe)
 * ✅ FIXED: Handles circular references and Mongoose documents
 * @param {any} data - The data to sanitize
 * @param {Set} seen - Set of seen objects to prevent circular references
 * @returns {any} - Sanitized data
 */
function sanitizeOutput(data, seen = new Set()) {
    if (!data) return data;
    
    // Handle primitive types
    if (typeof data === 'string') {
        return escapeHtml(data);
    }
    if (typeof data !== 'object') {
        return data;
    }
    
    // Handle Date objects
    if (data instanceof Date) {
        return data.toISOString();
    }
    
    // Handle Mongoose documents
    if (data.toObject && typeof data.toObject === 'function') {
        try {
            data = data.toObject({ virtuals: false, getters: false });
        } catch (e) {
            // If toObject fails, try spreading
            data = { ...data };
        }
    }
    
    // Check for circular references
    if (seen.has(data)) {
        return '[Circular]';
    }
    seen.add(data);
    
    // Handle arrays
    if (Array.isArray(data)) {
        const result = data.map(item => sanitizeOutput(item, seen));
        seen.delete(data);
        return result;
    }
    
    // Handle objects
    if (typeof data === 'object' && data !== null) {
        const result = {};
        for (const [key, value] of Object.entries(data)) {
            // Skip Mongoose internal fields
            if (key.startsWith('$') || key === '__v' || key === '_doc') {
                continue;
            }
            // Handle _id specially
            if (key === '_id') {
                result[key] = value?.toString ? value.toString() : value;
                continue;
            }
            // Handle replies array specially
            if (key === 'replies' && Array.isArray(value)) {
                result[key] = value.map(reply => {
                    if (reply && typeof reply === 'object') {
                        // Convert Mongoose subdocument to plain object
                        const plain = reply.toObject ? reply.toObject() : { ...reply };
                        // Remove Mongoose internal fields
                        delete plain.$__;
                        delete plain.$isNew;
                        delete plain._doc;
                        return sanitizeOutput(plain, seen);
                    }
                    return sanitizeOutput(reply, seen);
                });
                continue;
            }
            result[key] = sanitizeOutput(value, seen);
        }
        seen.delete(data);
        return result;
    }
    
    return data;
}

// ============================================================
// NOSQL INJECTION PROTECTION
// ============================================================

/**
 * Check if input string contains NoSQL injection operators
 * @param {any} input - The value to check
 * @returns {boolean} - True if dangerous patterns found
 */
function hasNoSQLInjection(input) {
    if (!input || typeof input !== 'string') return false;

    const operators = [
        '$eq', '$ne', '$gt', '$gte', '$lt', '$lte',
        '$in', '$nin', '$or', '$and', '$not', '$nor',
        '$exists', '$type', '$regex', '$where',
        '$all', '$elemMatch', '$size', '$slice'
    ];

    for (const op of operators) {
        if (input.includes(op)) return true;
    }

    // Check for JSON-like injection patterns
    if (/{"\$[a-z]+":/i.test(input)) return true;
    if (/{\s*"\$[a-z]+"\s*:/i.test(input)) return true;

    return false;
}

/**
 * Sanitize a query object (remove any keys with $)
 * @param {object} query - The query object to sanitize
 * @returns {object} - Sanitized query
 */
function sanitizeQuery(query) {
    if (!query || typeof query !== 'object') return query;

    const sanitized = {};
    for (const [key, value] of Object.entries(query)) {
        // Skip any key starting with '$'
        if (key.startsWith('$')) continue;

        if (value && typeof value === 'object' && !Array.isArray(value)) {
            // Check if value contains operator keys
            const hasOperator = Object.keys(value).some(k => k.startsWith('$'));
            if (hasOperator) continue; // strip operator objects
            sanitized[key] = sanitizeQuery(value);
        } else if (typeof value === 'string') {
            if (!hasNoSQLInjection(value)) {
                sanitized[key] = value;
            }
            // if injection detected, skip this field
        } else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

/**
 * Validate MongoDB ObjectId
 * @param {string} id - The ID to validate
 * @returns {boolean} - True if valid
 */
function isValidObjectId(id) {
    if (!id || typeof id !== 'string') return false;
    return /^[a-fA-F0-9]{24}$/.test(id) || id === 'assistant';
}

/**
 * Sanitize a string ID (remove special characters)
 * @param {string} id - The ID string
 * @returns {string|null} - Sanitized ID or null
 */
function sanitizeId(id) {
    if (!id || typeof id !== 'string') return null;
    const cleaned = id.replace(/[^a-zA-Z0-9-]/g, '');
    return cleaned || null;
}

module.exports = {
    // Existing exports
    sanitizeString,
    sanitizeEmail,
    sanitizeUsername,
    sanitizeObject,
    isSafeString,
    validatePasswordStrength,
    isValidEmail,
    // XSS exports
    escapeHtml,
    sanitizeOutput,
    // NoSQL exports
    hasNoSQLInjection,
    sanitizeQuery,
    isValidObjectId,
    sanitizeId
};
