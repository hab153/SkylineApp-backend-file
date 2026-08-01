// authMiddleware.js
const jwt = require('jsonwebtoken');
const User = require('./User');

// ✅ SECURE: Strict JWT secret getter - NO FALLBACKS, NO DEFAULTS
const getJwtSecret = () => {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        console.error('❌ CRITICAL: JWT_SECRET is not defined in environment variables');
        throw new Error('JWT_SECRET is not configured');
    }
    return secret;
};

const verifyToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Unauthorized: No token provided' });
        }

        const token = authHeader.split(' ')[1];
        if (!token) {
            return res.status(401).json({ message: 'Unauthorized: Invalid token format' });
        }

        // ✅ SECURE: Get secret with strict check
        const secret = getJwtSecret();
        let decoded;
        
        try {
            decoded = jwt.verify(token, secret);
        } catch (err) {
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ message: 'Unauthorized: Token expired' });
            }
            if (err.name === 'JsonWebTokenError') {
                return res.status(401).json({ message: 'Unauthorized: Invalid token' });
            }
            console.error('❌ [AUTH] JWT verification error:', err.message);
            return res.status(401).json({ message: 'Unauthorized: Token verification failed' });
        }

        // Extract user ID from token
        const userId = decoded.user?.id || decoded.id;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized: Invalid token payload' });
        }

        // Check for special tokens (layer tokens)
        const isLayerToken = decoded.step && ['layer2', 'layer3'].includes(decoded.step);
        const isAdminToken = decoded.isAdmin === true;

        // Fetch user from database
        let user;
        try {
            user = await User.findById(userId).select('tokenVersion isSuspended suspensionEnds');
        } catch (dbErr) {
            console.error('❌ [AUTH] Database error:', dbErr.message);
            return res.status(500).json({ message: 'Server error during authentication' });
        }

        if (!user) {
            return res.status(401).json({ message: 'Unauthorized: User not found' });
        }

        // Check if user is suspended
        if (user.isSuspended) {
            const now = new Date();
            if (user.suspensionEnds && now < user.suspensionEnds) {
                return res.status(403).json({ 
                    message: 'Account suspended', 
                    suspensionEnds: user.suspensionEnds 
                });
            }
        }

        // ✅ Special tokens: skip tokenVersion check
        if (isLayerToken || isAdminToken) {
            req.userId = userId;
            if (isLayerToken) req.layerStep = decoded.step;
            return next();
        }

        // ✅ Normal token: verify tokenVersion matches user's current version
        const tokenVersion = decoded.user?.tokenVersion;
        if (tokenVersion === undefined || tokenVersion !== user.tokenVersion) {
            return res.status(401).json({ message: 'Unauthorized: Token revoked' });
        }

        // ✅ Attach user to request
        req.userId = userId;
        req.user = user;
        next();

    } catch (error) {
        console.error('❌ [AUTH] Unexpected error:', error.message);
        return res.status(500).json({ message: 'Authentication error' });
    }
};

module.exports = { verifyToken };
