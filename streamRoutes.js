'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();

const { streamPipeline } = require('./Stream');

// Middleware — imported from the same files server.js uses.
const { verifyToken } = require('./authMiddleware');
const { checkSubscriptionExpiry } = require('./subscriptionMiddleware');
const { checkDailyLimit } = require('./dailyLimitMiddleware');

// ────────────────────────────────────────────────────────────────
// SSE HEADERS
// ────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────
// EVENT WRITER
// ────────────────────────────────────────────────────────────────

function writeSSEEvent(res, payload) {
    res.write('event: stage\n');
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

// ────────────────────────────────────────────────────────────────
// QUERY-STRING TOKEN BRIDGE
// ────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────
// PIPELINE STREAM ROUTE
// ────────────────────────────────────────────────────────────────

router.get(
    '/pipeline',
    bridgeQueryToken,
    verifyToken,
    checkSubscriptionExpiry,
    checkDailyLimit,
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
        console.log('[StreamRoutes] Message length:', message.length);

        setSSEHeaders(res);

        let closed = false;

        req.on('close', function () {
            closed = true;
            console.log('[StreamRoutes] Client disconnected');
        });

        req.on('error', function () {
            closed = true;
            console.log('[StreamRoutes] Client connection error');
        });

        function onStage(label, data) {
            if (closed) return;

            try {
                writeSSEEvent(res, { stage: label, data });
            } catch (writeErr) {
                console.error(
                    '[StreamRoutes] Failed to write SSE event:',
                    writeErr && writeErr.message ? writeErr.message : writeErr
                );
                closed = true;
            }
        }

        try {
            await streamPipeline(message, { userId: req.userId }, onStage);
        } catch (pipelineErr) {
            console.error(
                '[StreamRoutes] Pipeline failed:',
                pipelineErr && pipelineErr.message
                    ? pipelineErr.message
                    : pipelineErr
            );

            if (!closed) {
                try {
                    writeSSEEvent(res, {
                        stage: 'error',
                        data: {
                            message: 'Something went wrong while processing your request. Please try again.',
                        },
                    });
                } catch (_) {}
            }
        } finally {
            if (!closed) {
                try {
                    res.end();
                } catch (_) {}
            }

            console.log('[StreamRoutes] Pipeline stream closed');
        }
    }
);

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = router;
