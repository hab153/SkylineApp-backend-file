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
        console.log('🔑 [AUTH] ===== VERIFYING TOKEN =====');
        
        const authHeader = req.headers.authorization;
        console.log('🔑 [AUTH] Authorization header:', authHeader ? 'Present' : 'Missing');
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.log('❌ [AUTH] No Bearer token');
            return res.status(401).json({ message: 'Unauthorized: No token provided' });
        }

        const token = authHeader.split(' ')[1];
        if (!token) {
            console.log('❌ [AUTH] Invalid token format');
            return res.status(401).json({ message: 'Unauthorized: Invalid token format' });
        }

        console.log('🔑 [AUTH] Token (first 20 chars):', token.substring(0, 20) + '...');

        // ✅ SECURE: Get secret with strict check
        const secret = getJwtSecret();
        let decoded;
        
        try {
            decoded = jwt.verify(token, secret);
            
            // ✅ DEBUG: Log the entire decoded token
            console.log('🔑 [AUTH] Decoded token:', JSON.stringify(decoded, null, 2));
            console.log('🔑 [AUTH] decoded.user:', decoded.user);
            console.log('🔑 [AUTH] decoded.user?.id:', decoded.user?.id);
            console.log('🔑 [AUTH] decoded.id:', decoded.id);
            console.log('🔑 [AUTH] decoded.userId:', decoded.userId);
            console.log('🔑 [AUTH] decoded._id:', decoded._id);
            
        } catch (err) {
            if (err.name === 'TokenExpiredError') {
                console.log('❌ [AUTH] Token expired');
                return res.status(401).json({ message: 'Unauthorized: Token expired' });
            }
            if (err.name === 'JsonWebTokenError') {
                console.log('❌ [AUTH] Invalid token');
                return res.status(401).json({ message: 'Unauthorized: Invalid token' });
            }
            console.error('❌ [AUTH] JWT verification error:', err.message);
            return res.status(401).json({ message: 'Unauthorized: Token verification failed' });
        }

        // Extract user ID from token - try multiple possible field names
        const userId = decoded.user?.id || decoded.id || decoded.userId || decoded._id;
        console.log('🔑 [AUTH] Extracted userId:', userId);
        
        if (!userId) {
            console.log('❌ [AUTH] No user ID found in token');
            return res.status(401).json({ message: 'Unauthorized: Invalid token payload' });
        }

        // Check for special tokens (layer tokens)
        const isLayerToken = decoded.step && ['layer2', 'layer3'].includes(decoded.step);
        const isAdminToken = decoded.isAdmin === true;

        // Fetch user from database
        let user;
        try {
            console.log('🔑 [AUTH] Fetching user from database with ID:', userId);
            user = await User.findById(userId).select('tokenVersion isSuspended suspensionEnds');
            console.log('🔑 [AUTH] User found:', user ? 'Yes' : 'No');
            if (user) {
                console.log('🔑 [AUTH] User email:', user.email);
                console.log('🔑 [AUTH] User tokenVersion:', user.tokenVersion);
            }
        } catch (dbErr) {
            console.error('❌ [AUTH] Database error:', dbErr.message);
            return res.status(500).json({ message: 'Server error during authentication' });
        }

        if (!user) {
            console.log('❌ [AUTH] User not found in database for ID:', userId);
            return res.status(401).json({ message: 'Unauthorized: User not found' });
        }

        // Check if user is suspended
        if (user.isSuspended) {
            const now = new Date();
            if (user.suspensionEnds && now < user.suspensionEnds) {
                console.log('❌ [AUTH] Account suspended');
                return res.status(403).json({ 
                    message: 'Account suspended', 
                    suspensionEnds: user.suspensionEnds 
                });
            }
        }

        // ✅ Special tokens: skip tokenVersion check
        if (isLayerToken || isAdminToken) {
            console.log('🔑 [AUTH] Special token (layer/admin) - skipping tokenVersion check');
            req.userId = userId;
            if (isLayerToken) req.layerStep = decoded.step;
            console.log('✅ [AUTH] User authenticated (special token):', userId);
            return next();
        }

        // ✅ Normal token: verify tokenVersion matches user's current version
        const tokenVersion = decoded.user?.tokenVersion;
        console.log('🔑 [AUTH] Token version:', tokenVersion);
        console.log('🔑 [AUTH] User token version:', user.tokenVersion);
        
        if (tokenVersion === undefined || tokenVersion !== user.tokenVersion) {
            console.log('❌ [AUTH] Token version mismatch - token revoked');
            return res.status(401).json({ message: 'Unauthorized: Token revoked' });
        }

        // ✅ Attach user to request
        req.userId = userId;
        req.user = user;
        
        console.log('✅ [AUTH] User authenticated successfully:', userId);
        console.log('🔑 [AUTH] ===== TOKEN VERIFIED =====');
        
        next();

    } catch (error) {
        console.error('❌ [AUTH] Unexpected error:', error.message);
        console.error('❌ [AUTH] Stack:', error.stack);
        return res.status(500).json({ message: 'Authentication error' });
    }
};

module.exports = { verifyToken };
