'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();

const { streamPipeline } = require('./Stream');
const { verifyToken } = require('./authMiddleware');
const {
    checkSubscriptionExpiry,
    checkDailyLimit,
} = require('./dailyLimitMiddleware');

// ────────────────────────────────────────────────────────────────
// SSE HEADERS
// ────────────────────────────────────────────────────────────────

// Applies the standard SSE headers to the response.

function setSSEHeaders(res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': 'https://skylineai-app.vercel.app',
        'Access-Control-Allow-Credentials': 'true',
    });

    // Flush headers immediately so the client sees the connection open.
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }
}

// ────────────────────────────────────────────────────────────────
// EVENT WRITER
// ────────────────────────────────────────────────────────────────

// Writes a single SSE event to the response.
// The event name is always "stage". The payload is JSON.

function writeSSEEvent(res, payload) {
    res.write('event: stage\n');
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

// ────────────────────────────────────────────────────────────────
// QUERY-STRING TOKEN BRIDGE
// ────────────────────────────────────────────────────────────────

// EventSource cannot send headers. So the client sends the JWT as a
// query parameter. If a bearer token is present in the header, it is
// used. Otherwise, the query-string token is promoted to the
// Authorization header so the existing verifyToken middleware works.

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

// GET /api/stream/pipeline?message=...&token=...
//
// Streams each pipeline stage as it completes.
// The wire only ever carries neutral stage labels — never the
// internal stage names.

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

        // ── Guard: message must be present ──
        if (message.length === 0) {
            res.status(400).json({
                error: 'message query parameter is required',
            });
            return;
        }

        console.log('[StreamRoutes] Pipeline stream opened');
        console.log('[StreamRoutes] User:', req.userId);
        console.log('[StreamRoutes] Message length:', message.length);

        // ── Set SSE headers ──
        setSSEHeaders(res);

        // ── Track whether the connection is still open ──
        let closed = false;

        req.on('close', function () {
            closed = true;
            console.log('[StreamRoutes] Client disconnected');
        });

        req.on('error', function () {
            closed = true;
            console.log('[StreamRoutes] Client connection error');
        });

        // ── The onStage callback ──
        // Receives the neutral stage label and the stage data.
        // Writes one SSE event per stage.

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

        // ── Run the pipeline ──
        try {
            await streamPipeline(message, { userId: req.userId }, onStage);
        } catch (pipelineErr) {
            // Log the real error server-side.
            console.error(
                '[StreamRoutes] Pipeline failed:',
                pipelineErr && pipelineErr.message
                    ? pipelineErr.message
                    : pipelineErr
            );

            // Send a sanitized error event to the client.
            // No internal details are exposed.
            if (!closed) {
                try {
                    writeSSEEvent(res, {
                        stage: 'error',
                        data: {
                            message: 'Something went wrong while processing your request. Please try again.',
                        },
                    });
                } catch (_) {
                    // If writing fails, the connection is already broken.
                }
            }
        } finally {
            if (!closed) {
                try {
                    res.end();
                } catch (_) {
                    // Nothing to do if the connection is already closed.
                }
            }

            console.log('[StreamRoutes] Pipeline stream closed');
        }
    }
);

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = router;
