// ============================================================
// researchLimitMiddleware.js
// Express middleware — verifies & increments research limit
// Attaches remaining count to req.remainingResearch
// ============================================================

const { verifyAndIncrement } = require('./researchLimitService');

/**
 * Middleware: researchLimitMiddleware
 * 
 * Flow:
 *   1. Called on /api/stream/pipeline route
 *   2. Calls verifyAndIncrement(userId)
 *   3. If limit reached → returns 429, stops request
 *   4. If allowed → attaches req.remainingResearch → calls next()
 */
async function researchLimitMiddleware(req, res, next) {
    try {
        // ─── Ensure user is authenticated ───
        if (!req.userId) {
            console.log('❌ [RESEARCH LIMIT] No userId on request');
            return res.status(401).json({
                success: false,
                error: 'Unauthorized: No user ID'
            });
        }

        console.log(`🛡️ [RESEARCH LIMIT] Checking limit for user: ${req.userId}`);

        // ─── Verify and increment ───
        const result = await verifyAndIncrement(req.userId);

        console.log(`🛡️ [RESEARCH LIMIT] Result:`, {
            allowed: result.allowed,
            remaining: result.remaining,
            limit: result.limit,
            used: result.used,
            tier: result.tier,
            error: result.error || null
        });

        // ─── If limit reached or error ───
        if (!result.allowed) {
            const statusCode = result.error === 'User not found' ? 404 : 429;
            return res.status(statusCode).json({
                success: false,
                error: result.error || 'Daily research limit reached',
                limit: result.limit,
                remaining: result.remaining,
                used: result.used,
                tier: result.tier,
                message: 'Upgrade your plan or wait 24 hours for limits to reset.'
            });
        }

        // ─── Attach limits to request for downstream use ───
        // This is read by streamRoutes.js to include in SSE 'done' event
        req.remainingResearch = {
            remaining: result.remaining,
            limit: result.limit,
            used: result.used,
            tier: result.tier
        };

        console.log(`✅ [RESEARCH LIMIT] Passed. Attached to req.remainingResearch`);

        // ─── Continue to next middleware (pipeline handler) ───
        next();

    } catch (err) {
        console.error('❌ [RESEARCH LIMIT] Unexpected error:', err.message);
        console.error('❌ [RESEARCH LIMIT] Stack:', err.stack);
        return res.status(500).json({
            success: false,
            error: 'Server error verifying research limit'
        });
    }
}

module.exports = { researchLimitMiddleware };
