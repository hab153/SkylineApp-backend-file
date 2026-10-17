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
// ACTIVE REQUEST REGISTRY
// ────────────────────────────────────────────────────────────────

// Maps requestId → { cancelled, abortController, userId }
//
// Every stream pipeline request gets an entry here. The cancel
// endpoint flips `cancelled` to true and aborts the AbortController,
// which cascades into every in-flight fetch (OpenAI, Tavily) tied to
// that request.
//
// Entries are removed when the request finishes (success, error, or
// cancel).

const activeRequests = new Map();

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
// REQUEST ID
// ────────────────────────────────────────────────────────────────

// Reads requestId from query string. If missing, generates one so the
// route still works even without a client-supplied ID.

function readRequestId(req) {
    if (typeof req.query.requestId === 'string' && req.query.requestId.length > 0) {
        return req.query.requestId;
    }

    return (
        'req_' +
        Date.now().toString(36) +
        '_' +
        Math.random().toString(36).slice(2, 10)
    );
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

        const requestId = readRequestId(req);
        const abortController = new AbortController();

        console.log('[StreamRoutes] Pipeline stream opened');
        console.log('[StreamRoutes] User:', req.userId);
        console.log('[StreamRoutes] RequestId:', requestId);
        console.log('[StreamRoutes] Message length:', message.length);

        // Register this request so /cancel/:requestId can find it.
        activeRequests.set(requestId, {
            cancelled: false,
            abortController: abortController,
            userId: req.userId,
        });

        setSSEHeaders(res);

        // Send the requestId to the client immediately so it knows
        // what ID to use when calling /cancel.
        writeSSEEvent(res, {
            stage: 'started',
            data: { requestId: requestId },
        });

        let closed = false;

        req.on('close', function () {
            closed = true;
            console.log('[StreamRoutes] Client disconnected — requestId:', requestId);

            // Client disconnected. Cancel the server-side work too —
            // no point in continuing if nobody is listening.
            const entry = activeRequests.get(requestId);
            if (entry) {
                entry.cancelled = true;
                try { entry.abortController.abort(); } catch (_) {}
            }
        });

        req.on('error', function () {
            closed = true;
            console.log('[StreamRoutes] Client connection error — requestId:', requestId);

            const entry = activeRequests.get(requestId);
            if (entry) {
                entry.cancelled = true;
                try { entry.abortController.abort(); } catch (_) {}
            }
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
            await streamPipeline(
                message,
                {
                    userId: req.userId,
                    requestId: requestId,
                    signal: abortController.signal,
                    isCancelled: function () {
                        const entry = activeRequests.get(requestId);
                        return !entry || entry.cancelled === true;
                    },
                },
                onStage
            );
        } catch (pipelineErr) {
            // Distinguish cancellation from real errors.
            const wasCancelled =
                pipelineErr &&
                (pipelineErr.name === 'AbortError' ||
                 pipelineErr.message === 'cancelled' ||
                 pipelineErr.code === 'CANCELLED');

            if (wasCancelled) {
                console.log('[StreamRoutes] Pipeline cancelled by user — requestId:', requestId);

                if (!closed) {
                    try {
                        writeSSEEvent(res, {
                            stage: 'cancelled',
                            data: { requestId: requestId },
                        });
                    } catch (_) {}
                }
            } else {
                console.error(
                    '[StreamRoutes] Pipeline failed — requestId:', requestId,
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
            }
        } finally {
            activeRequests.delete(requestId);

            if (!closed) {
                try {
                    res.end();
                } catch (_) {}
            }

            console.log('[StreamRoutes] Pipeline stream closed — requestId:', requestId);
        }
    }
);

// ────────────────────────────────────────────────────────────────
// CANCEL ROUTE
// ────────────────────────────────────────────────────────────────

// POST /api/stream/cancel/:requestId
//
// Marks the request as cancelled and aborts its AbortController.
// Every in-flight fetch tied to that request (OpenAI, Tavily) aborts
// immediately. The pipeline stops between stages via isCancelled().

router.post(
    '/cancel/:requestId',
    bridgeQueryToken,
    verifyToken,
    function (req, res) {
        const requestId = req.params.requestId;

        console.log('[StreamRoutes] Cancel requested — requestId:', requestId, 'user:', req.userId);

        const entry = activeRequests.get(requestId);

        if (!entry) {
            console.warn('[StreamRoutes] Cancel: no active request with requestId:', requestId);
            return res.json({
                cancelled: false,
                reason: 'no active request with that requestId',
            });
        }

        // Only the owner of the request may cancel it.
        if (String(entry.userId) !== String(req.userId)) {
            console.warn('[StreamRoutes] Cancel: user mismatch — entry.userId:', entry.userId, 'req.userId:', req.userId);
            return res.status(403).json({
                cancelled: false,
                reason: 'not the owner of this request',
            });
        }

        entry.cancelled = true;
        try { entry.abortController.abort(); } catch (_) {}

        console.log('[StreamRoutes] Cancel: aborted — requestId:', requestId);

        res.json({ cancelled: true });
    }
);

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = router;
