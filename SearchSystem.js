'use strict';

// ────────────────────────────────────────────────────────────────
// IMPORTS
// ────────────────────────────────────────────────────────────────

const { saving } = require('./Saving');

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

// Fixed Tavily search parameters used for every search.
// These are the same for every phrase — only the query changes.
//
// max_results is set to 20 per search — the maximum Tavily allows.
// Ten searches return up to 200 pages total. More pages means more
// companies discovered for the same credit cost (Tavily charges per
// search, not per result).
//
// Reference: https://docs.tavily.com/documentation/api-reference/endpoint/search
const TAVILY_PARAMS = {
    search_depth: 'basic',
    max_results: 20,
    topic: 'general',
    include_answer: false,
    include_raw_content: false,
    include_favicon: false,
};

// ────────────────────────────────────────────────────────────────
// SEARCH SYSTEM
// ────────────────────────────────────────────────────────────────

// Receives one search phrase from Controlling.js, sends it to Tavily,
// receives the response, and passes the response to Saving.js.
//
// It does not decide which search to run. It does not generate searches.
// It does not store results. It only executes one search and hands the
// result to Saving.

async function searchSystem(searchPhrase) {
    console.log('[SearchSystem] Started');
    console.log('[SearchSystem] Received search phrase:', searchPhrase);

    // ── Guard: searchPhrase must be a non-empty string ──
    if (typeof searchPhrase !== 'string' || searchPhrase.trim().length === 0) {
        throw new Error(
            '[SearchSystem] searchPhrase must be a non-empty string'
        );
    }

    const query = searchPhrase.trim();

    // ── Read the Tavily API key from the environment ──
    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        throw new Error(
            '[SearchSystem] TAVILY_API_KEY is not set in the environment'
        );
    }

    console.log('[SearchSystem] Sending request to Tavily:', query);

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
            '[SearchSystem] Network error while contacting Tavily:',
            networkError && networkError.message
                ? networkError.message
                : networkError
        );
        throw networkError;
    }

    console.log(
        '[SearchSystem] Tavily HTTP status:',
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

        const message = `[SearchSystem] Tavily request failed with status ${response.status}: ${errorBody}`;

        console.error(message);

        throw new Error(message);
    }

    // ── Parse JSON ──
    let tavilyResponse;

    try {
        tavilyResponse = await response.json();
    } catch (parseError) {
        console.error(
            '[SearchSystem] Failed to parse Tavily response as JSON:',
            parseError && parseError.message
                ? parseError.message
                : parseError
        );
        throw parseError;
    }

    console.log(
        '[SearchSystem] Tavily response received. Results:',
        Array.isArray(tavilyResponse && tavilyResponse.results)
            ? tavilyResponse.results.length
            : 0
    );

    // ── Hand the result to Saving.js ──
    await saving({
        search: query,
        response: tavilyResponse,
    });

    console.log('[SearchSystem] Result handed to Saving');

    // ── Return nothing ──
    return;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = searchSystem;
