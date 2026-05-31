const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    console.log('🔐 [AUTH] Authorization header:', authHeader ? 'present' : 'missing');
    
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        console.error('❌ [AUTH] No token provided');
        return res.status(403).json({ message: 'No token provided' });
    }
    
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secretkey');
        req.userId = decoded.user.id;
        console.log('✅ [AUTH] Token verified, userId =', req.userId);
        next();
    } catch (err) {
        console.error('❌ [AUTH] Invalid token:', err.message);
        return res.status(401).json({ message: 'Invalid token' });
    }
};

module.exports = { verifyToken };
