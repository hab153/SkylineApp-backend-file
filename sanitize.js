// sanitize.js

/**
 * Sanitize string input - SAFE VERSION
 * Only escapes dangerous characters, does NOT remove content
 */
function sanitizeString(input) {
    if (!input || typeof input !== 'string') return input;
    
    let sanitized = String(input);
    
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
 */
function sanitizeEmail(email) {
    if (!email || typeof email !== 'string') return email;
    return email.toLowerCase().trim();
}

/**
 * Sanitize username - preserves dots and underscores
 */
function sanitizeUsername(username) {
    if (!username || typeof username !== 'string') return username;
    return username.trim().replace(/[^a-zA-Z0-9_.]/g, '');
}

/**
 * Sanitize an entire object (recursive)
 */
function sanitizeObject(obj, exclude = []) {
    if (!obj || typeof obj !== 'object') return obj;
    
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        if (exclude.includes(key)) {
            result[key] = value;
            continue;
        }
        
        if (typeof value === 'string') {
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
 */
function isSafeString(input) {
    if (!input || typeof input !== 'string') return true;
    
    const dangerousPatterns = [
        /<script/i, /javascript:/i, /on\w+=/i, /alert\(/i,
        /eval\(/i, /document\./i, /window\./i,
        /<iframe/i, /<object/i, /<embed/i, /<form/i, /<input/i
    ];
    
    for (const pattern of dangerousPatterns) {
        if (pattern.test(input)) return false;
    }
    return true;
}

/**
 * Validate that a string is a valid password
 */
function validatePasswordStrength(password) {
    const errors = [];
    
    if (!password || password.length < 8) errors.push('Password must be at least 8 characters');
    if (!/[a-z]/.test(password)) errors.push('Password must contain at least one lowercase letter');
    if (!/[A-Z]/.test(password)) errors.push('Password must contain at least one uppercase letter');
    if (!/\d/.test(password)) errors.push('Password must contain at least one number');
    if (password.length > 100) errors.push('Password cannot exceed 100 characters');
    
    return { valid: errors.length === 0, errors };
}

/**
 * Check if a string is a valid email
 */
function isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ============================================================
// XSS PROTECTION FUNCTIONS
// ============================================================

function escapeHtml(str) {
    if (!str || typeof str !== 'string') return str;
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function sanitizeOutput(data, seen = new Set()) {
    if (!data) return data;
    if (typeof data === 'string') return escapeHtml(data);
    if (typeof data !== 'object') return data;
    if (data instanceof Date) return data.toISOString();
    
    if (data.toObject && typeof data.toObject === 'function') {
        try {
            data = data.toObject({ virtuals: false, getters: false });
        } catch (e) {
            data = { ...data };
        }
    }
    
    if (seen.has(data)) return '[Circular]';
    seen.add(data);
    
    if (Array.isArray(data)) {
        const result = data.map(item => sanitizeOutput(item, seen));
        seen.delete(data);
        return result;
    }
    
    if (typeof data === 'object' && data !== null) {
        const result = {};
        for (const [key, value] of Object.entries(data)) {
            if (key.startsWith('$') || key === '__v' || key === '_doc') continue;
            if (key === '_id') {
                result[key] = value?.toString ? value.toString() : value;
                continue;
            }
            if (key === 'replies' && Array.isArray(value)) {
                result[key] = value.map(reply => {
                    if (reply && typeof reply === 'object') {
                        const plain = reply.toObject ? reply.toObject() : { ...reply };
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
 * Only flags actual injection patterns, not normal text
 */
function hasNoSQLInjection(input) {
    if (!input || typeof input !== 'string') return false;

    // ✅ Only flag actual JSON-like injection patterns
    // NOT fields that happen to have "in" or "or" in them (like "main", "information")
    
    // Check for operators embedded in strings with quotes (JSON injection)
    if (/\{\s*"\$[a-z]+"\s*:/.test(input)) return true;
    if (/\$where\s*:/.test(input)) return true;
    if (/\$regex\s*:/.test(input)) return true;
    
    // Check for null bytes
    if (input.includes('\0')) return true;
    
    return false;
}

/**
 * ════════════════════════════════════════════════════════════════
 * ✅ CRITICAL FIX: sanitizeQuery — Preserves $or, $and, $nor
 * ════════════════════════════════════════════════════════════════
 *
 * The previous version stripped ALL keys starting with '$', which
 * destroyed `$or` queries. This turned `{ $or: [...] }` into `{}`,
 * which made `User.findOne({})` return the FIRST user in the DB.
 *
 * That's why logging in as "saygmail.com" returned "saa@gmail.com"!
 */
function sanitizeQuery(query) {
    if (!query || typeof query !== 'object') return query;

    const sanitized = {};
    
    for (const [key, value] of Object.entries(query)) {
        // ✅ ALLOW: Safe logical operators
        if (key === '$or' || key === '$and' || key === '$nor') {
            if (Array.isArray(value)) {
                const sanitizedArray = value
                    .map(item => sanitizeQuery(item))
                    .filter(item => item && Object.keys(item).length > 0);
                // ✅ Only keep if there's at least one valid clause
                if (sanitizedArray.length > 0) {
                    sanitized[key] = sanitizedArray;
                }
            }
            continue;
        }

        // ✅ ALLOW: Safe comparison operators ($gt, $lt, etc.) — used for dates
        const SAFE_COMPARISON_OPS = ['$gt', '$gte', '$lt', '$lte', '$eq', '$ne', '$in', '$nin', '$exists'];
        if (SAFE_COMPARISON_OPS.includes(key)) {
            sanitized[key] = value;
            continue;
        }

        // ❌ BLOCK: Dangerous operators (code execution / regex DoS)
        const DANGEROUS_OPS = ['$where', '$function', '$accumulator', '$expr', '$regex', '$text', '$jsonSchema'];
        if (DANGEROUS_OPS.includes(key)) {
            continue;
        }

        // ❌ BLOCK: Any other unknown $ operator
        if (key.startsWith('$')) {
            continue;
        }

        // Handle nested objects (e.g., { resetTokenExpiry: { $gt: Date } })
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const sanitizedValue = sanitizeQuery(value);
            // ✅ Only skip if it's truly empty (would match everything)
            if (Object.keys(sanitizedValue).length > 0) {
                sanitized[key] = sanitizedValue;
            }
            continue;
        }

        // Handle strings — reject if they contain actual injection patterns
        if (typeof value === 'string') {
            if (!hasNoSQLInjection(value)) {
                sanitized[key] = value;
            }
            continue;
        }

        // Handle arrays and primitives
        sanitized[key] = value;
    }
    
    return sanitized;
}

/**
 * Validate MongoDB ObjectId
 */
function isValidObjectId(id) {
    if (!id || typeof id !== 'string') return false;
    return /^[a-fA-F0-9]{24}$/.test(id) || id === 'assistant';
}

/**
 * Sanitize a string ID
 */
function sanitizeId(id) {
    if (!id || typeof id !== 'string') return null;
    const cleaned = id.replace(/[^a-zA-Z0-9-]/g, '');
    return cleaned || null;
}

module.exports = {
    sanitizeString,
    sanitizeEmail,
    sanitizeUsername,
    sanitizeObject,
    isSafeString,
    validatePasswordStrength,
    isValidEmail,
    escapeHtml,
    sanitizeOutput,
    hasNoSQLInjection,
    sanitizeQuery,
    isValidObjectId,
    sanitizeId
};
