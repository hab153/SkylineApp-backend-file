'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const { handling } = require('./Handling');

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

// Fixed Tavily search parameters used for every domain-discovery search.
// Fewer results than the company-finding phase — the official site
// is usually at the top, so max_results: 5 is enough.
const TAVILY_PARAMS = {
    search_depth: 'basic',
    max_results: 5,
    topic: 'general',
    include_answer: false,
    include_raw_content: false,
    include_favicon: false,
};

// ────────────────────────────────────────────────────────────────
// SEARCH HANDLER
// ────────────────────────────────────────────────────────────────

// Receives one search phrase from SearchController.js, sends it to
// Tavily, receives the response, and passes the response to Handling.js.
//
// This file does not decide what to search. It does not loop. It does
// not store results. It executes one search and hands the result to
// Handling.
//
// Returns nothing — SearchController moves on to the next search.

async function searchHandler(searchPhrase) {
    console.log('[SearchHandler] Started');
    console.log('[SearchHandler] Received search phrase:', searchPhrase);

    // ── Guard: searchPhrase must be a non-empty string ──
    if (typeof searchPhrase !== 'string' || searchPhrase.trim().length === 0) {
        throw new Error(
            '[SearchHandler] searchPhrase must be a non-empty string'
        );
    }

    const query = searchPhrase.trim();

    // ── Read the Tavily API key from the environment ──
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        throw new Error(
            '[SearchHandler] TAVILY_API_KEY is not set in the environment'
        );
    }

    console.log('[SearchHandler] Sending request to Tavily:', query);

    // ── Send the request to Tavily ──
    let response;

    try {
        response = await fetch(TAVILY_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                query,
                ...TAVILY_PARAMS,
            }),
        });
    } catch (networkError) {
        console.error(
            '[SearchHandler] Network error while contacting Tavily:',
            networkError && networkError.message
                ? networkError.message
                : networkError
        );
        throw networkError;
    }

    console.log(
        '[SearchHandler] Tavily HTTP status:',
        response.status
    );

    // ── Non-2xx response → throw ──
    if (!response.ok) {
        let errorBody = '';

        try {
            errorBody = await response.text();
        } catch (_) {
            errorBody = '(unable to read error body)';
        }

        const message = `[SearchHandler] Tavily request failed with status ${response.status}: ${errorBody}`;

        console.error(message);

        throw new Error(message);
    }

    // ── Parse JSON ──
    let tavilyResponse;

    try {
        tavilyResponse = await response.json();
    } catch (parseError) {
        console.error(
            '[SearchHandler] Failed to parse Tavily response as JSON:',
            parseError && parseError.message
                ? parseError.message
                : parseError
        );
        throw parseError;
    }

    console.log(
        '[SearchHandler] Tavily response received. Results:',
        Array.isArray(tavilyResponse && tavilyResponse.results)
            ? tavilyResponse.results.length
            : 0
    );

    // ── Hand the result to Handling.js ──
    await handling({
        search: query,
        response: tavilyResponse,
    });

    console.log('[SearchHandler] Result handed to Handling');

    // ── Return nothing ──
    return;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = searchHandler;
