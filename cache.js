// ============================================================
// cache.js - Skyline AA-1 Caching Layer
// In-memory caching with TTL support
// Can be extended to use Redis later
// ============================================================

// ──────────────────────────────────────────────────────────────
//  CONFIGURATION
// ──────────────────────────────────────────────────────────────

const DEFAULT_TTL = 300000; // 5 minutes
const MAX_CACHE_SIZE = 1000; // Maximum number of cache entries

// ──────────────────────────────────────────────────────────────
//  IN-MEMORY CACHE STORE
// ──────────────────────────────────────────────────────────────

class CacheStore {
    constructor() {
        this.store = new Map();
        this.stats = {
            hits: 0,
            misses: 0,
            sets: 0,
            deletes: 0,
            totalEntries: 0
        };
        
        // Start cleanup interval
        this._startCleanup();
    }

    // ─── Get value from cache ───
    get(key) {
        const entry = this.store.get(key);
        if (!entry) {
            this.stats.misses++;
            return null;
        }

        // Check if expired
        if (entry.expires && Date.now() > entry.expires) {
            this.store.delete(key);
            this.stats.misses++;
            this.stats.totalEntries = this.store.size;
            return null;
        }

        this.stats.hits++;
        return entry.value;
    }

    // ─── Set value in cache ───
    set(key, value, ttl = DEFAULT_TTL) {
        // Check cache size limit
        if (this.store.size >= MAX_CACHE_SIZE) {
            // Remove oldest entry (first key)
            const firstKey = this.store.keys().next().value;
            if (firstKey) {
                this.store.delete(firstKey);
            }
        }

        const entry = {
            value: value,
            expires: Date.now() + ttl,
            createdAt: Date.now()
        };

        this.store.set(key, entry);
        this.stats.sets++;
        this.stats.totalEntries = this.store.size;
        return true;
    }

    // ─── Delete from cache ───
    delete(key) {
        const deleted = this.store.delete(key);
        if (deleted) {
            this.stats.deletes++;
            this.stats.totalEntries = this.store.size;
        }
        return deleted;
    }

    // ─── Check if key exists ───
    has(key) {
        const entry = this.store.get(key);
        if (!entry) return false;
        
        if (entry.expires && Date.now() > entry.expires) {
            this.store.delete(key);
            this.stats.totalEntries = this.store.size;
            return false;
        }
        
        return true;
    }

    // ─── Clear entire cache ───
    clear() {
        this.store.clear();
        this.stats.totalEntries = 0;
        this.stats.hits = 0;
        this.stats.misses = 0;
        return true;
    }

    // ─── Get cache stats ───
    getStats() {
        const hitRate = this.stats.hits + this.stats.misses > 0
            ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(1)
            : 0;
        
        return {
            ...this.stats,
            hitRate: parseFloat(hitRate),
            size: this.store.size,
            maxSize: MAX_CACHE_SIZE
        };
    }

    // ─── Get all keys (for debugging) ───
    keys() {
        return Array.from(this.store.keys());
    }

    // ─── Clean expired entries ───
    _cleanup() {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [key, entry] of this.store) {
            if (entry.expires && now > entry.expires) {
                this.store.delete(key);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            this.stats.totalEntries = this.store.size;
            console.log(`🧹 [CACHE] Cleaned ${cleaned} expired entries`);
        }
    }

    // ─── Start automatic cleanup ───
    _startCleanup() {
        this._cleanupInterval = setInterval(() => {
            this._cleanup();
        }, 60000); // Every minute
    }

    // ─── Stop cleanup ───
    stopCleanup() {
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
            this._cleanupInterval = null;
        }
    }
}

// ──────────────────────────────────────────────────────────────
//  CACHE KEYS (Organized for easy management)
// ──────────────────────────────────────────────────────────────

const CACHE_KEYS = {
    // User related
    USER: (userId) => `user:${userId}`,
    USER_PROFILE: (userId) => `user:profile:${userId}`,
    DASHBOARD: (userId) => `user:dashboard:${userId}`,
    
    // Lead related
    LEADS: (userId) => `leads:${userId}`,
    LEAD: (leadId) => `lead:${leadId}`,
    CONVERSATIONS: (userId) => `conversations:${userId}`,
    CONVERSATION: (leadId) => `conversation:${leadId}`,
    
    // Session related
    SESSIONS: (userId) => `sessions:${userId}`,
    SESSION: (userId, sessionId) => `session:${userId}:${sessionId}`,
    SESSION_MESSAGES: (userId, sessionId) => `session:${userId}:${sessionId}:messages`,
    
    // Notification related
    NOTIFICATIONS: (userId) => `notifications:${userId}`,
    NOTIFICATION_COUNT: (userId) => `notifications:count:${userId}`,
    UNREAD_COUNT: (userId) => `unread:${userId}`,
    
    // Email related
    EMAIL_STATUS: (userId) => `email:status:${userId}`,
    NYLAS_TOKEN: (userId) => `nylas:token:${userId}`,
    
    // Plan/Subscription
    SUBSCRIPTION: (userId) => `subscription:${userId}`,
    PLAN: (userId) => `plan:${userId}`,
    
    // AI responses (for caching expensive AI calls)
    AI_RESPONSE: (hash) => `ai:response:${hash}`,
    SUGGESTION: (hash) => `ai:suggestion:${hash}`,
    
    // Search
    SEARCH_RESULTS: (hash) => `search:${hash}`,
    COMPANY_SEARCH: (hash) => `search:company:${hash}`,
    
    // API rate limiting
    RATE_LIMIT: (key) => `rate:${key}`,
};

// ──────────────────────────────────────────────────────────────
//  MAIN CACHE EXPORTS
// ──────────────────────────────────────────────────────────────

const cache = new CacheStore();

// ─── Helper: Generate cache key from object ───
function generateKey(prefix, data) {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    const hash = require('crypto')
        .createHash('sha256')
        .update(str)
        .digest('hex')
        .substring(0, 16);
    return `${prefix}:${hash}`;
}

// ─── Helper: Get with fallback ───
async function getOrSet(key, fetchFn, ttl = DEFAULT_TTL) {
    // Try cache first
    const cached = cache.get(key);
    if (cached !== null) {
        return cached;
    }
    
    // Fetch fresh data
    try {
        const data = await fetchFn();
        if (data !== null && data !== undefined) {
            cache.set(key, data, ttl);
        }
        return data;
    } catch (error) {
        console.error(`❌ [CACHE] Failed to fetch for key: ${key}`, error.message);
        throw error;
    }
}

// ─── Helper: Invalidate by pattern ───
function invalidatePattern(pattern) {
    let count = 0;
    for (const key of cache.keys()) {
        if (key.includes(pattern)) {
            cache.delete(key);
            count++;
        }
    }
    return count;
}

// ─── Helper: Invalidate by userId ───
function invalidateUser(userId) {
    const patterns = [
        `user:${userId}`,
        `leads:${userId}`,
        `conversations:${userId}`,
        `sessions:${userId}`,
        `notifications:${userId}`,
        `email:status:${userId}`,
        `subscription:${userId}`,
        `plan:${userId}`,
        `unread:${userId}`,
        `user:dashboard:${userId}`,
    ];
    
    let count = 0;
    for (const pattern of patterns) {
        const deleted = cache.delete(pattern);
        if (deleted) count++;
    }
    
    // Also delete any keys containing the userId pattern
    const deleted = invalidatePattern(`:${userId}`);
    count += deleted;
    
    return count;
}

// ─── Helper: Get cache stats ───
function getCacheStats() {
    return cache.getStats();
}

// ─── Export ───
module.exports = {
    // Main cache instance
    cache,
    
    // Cache keys
    CACHE_KEYS,
    
    // Core operations
    get: (key) => cache.get(key),
    set: (key, value, ttl) => cache.set(key, value, ttl),
    delete: (key) => cache.delete(key),
    has: (key) => cache.has(key),
    clear: () => cache.clear(),
    stats: () => cache.getStats(),
    
    // Advanced operations
    getOrSet,
    generateKey,
    invalidatePattern,
    invalidateUser,
    getCacheStats,
    
    // Constants
    DEFAULT_TTL,
    MAX_CACHE_SIZE,
};

console.log('✅ [CACHE] Cache layer initialized');
console.log(`   📋 Max entries: ${MAX_CACHE_SIZE}`);
console.log(`   ⏰ Default TTL: ${DEFAULT_TTL / 1000}s`);
