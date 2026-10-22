// streamRoutes.js
'use strict';

const express = require('express');
const router = express.Router();

const { streamPipeline } = require('./Stream');

// Middleware
const { verifyToken } = require('./authMiddleware');
const { checkSubscriptionExpiry } = require('./subscriptionMiddleware');
const { researchLimitMiddleware } = require('./researchLimitMiddleware'); // ⭐ NEW

function setSSEHeaders(res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': 'https://skylineai-app.vercel.app',
        'Access-Control-Allow-Credentials': 'true',
    });

    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }
}

function writeSSEEvent(res, payload) {
    res.write('event: stage\n');
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

function bridgeQueryToken(req, res, next) {
    if (
        (!req.headers.authorization || req.headers.authorization.length === 0) &&
        typeof req.query.token === 'string' &&
        req.query.token.length > 0
    ) {
        req.headers.authorization = 'Bearer ' + req.query.token;
    }
    next();
}

// ⭐ UPDATED ROUTE: Now uses researchLimitMiddleware
router.get(
    '/pipeline',
    bridgeQueryToken,
    verifyToken,
    checkSubscriptionExpiry,
    researchLimitMiddleware, // ⭐ NEW — attaches req.remainingResearch
    async function (req, res) {
        const message = typeof req.query.message === 'string'
            ? req.query.message.trim()
            : '';

        if (message.length === 0) {
            res.status(400).json({
                error: 'message query parameter is required',
            });
            return;
        }

        console.log('[StreamRoutes] Pipeline stream opened');
        console.log('[StreamRoutes] User:', req.userId);
        
        // Log remaining research (attached by researchLimitMiddleware)
        if (req.remainingResearch) {
            console.log('[StreamRoutes] Remaining Research:', req.remainingResearch.remaining);
        }

        setSSEHeaders(res);

        let closed = false;

        req.on('close', function () {
            closed = true;
        });

        req.on('error', function () {
            closed = true;
        });

        function onStage(label, data) {
            if (closed) return;
            try {
                // ⭐ If this is the final 'done' or 's5' stage, attach remaining limits
                if (label === 'done' || label === 's5') {
                    const enrichedData = {
                        ...(data || {}),
                        remainingLimits: req.remainingResearch || null
                    };
                    writeSSEEvent(res, { stage: label, data: enrichedData });
                } else {
                    writeSSEEvent(res, { stage: label, data });
                }
            } catch (writeErr) {
                closed = true;
            }
        }

        try {
            await streamPipeline(message, { userId: req.userId }, onStage);
        } catch (pipelineErr) {
            console.error('[StreamRoutes] Pipeline failed:', pipelineErr.message);
            if (!closed) {
                try {
                    writeSSEEvent(res, {
                        stage: 'error',
                        data: {
                            message: 'Something went wrong.',
                            remainingLimits: req.remainingResearch || null
                        },
                    });
                } catch (_) {}
            }
        } finally {
            if (!closed) {
                try { res.end(); } catch (_) {}
            }
        }
    }
);

module.exports = router;
