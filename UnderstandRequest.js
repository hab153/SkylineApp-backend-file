'use strict';

const OpenAI = require('openai');

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = 'gpt-4o-mini';
const FALLBACK_TARGET = 'company';
const FALLBACK_PROBLEM = 'customer';
const MAX_ATTEMPTS = 2;

// ────────────────────────────────────────────────────────────────
// GPT INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
Your only task is to understand the complete meaning of the user's request
and identify:

1. The main target entity the user is looking for.
2. The main problem, need, or area of interest connected to that target entity.

Read the complete user request. Do not rely only on exact keywords.

The target entity is the type of thing the user is looking for, such as a company,
school, restaurant, hotel, agency, hospital, software, product, person, location,
or any other suitable entity.

The problem is the name of the problem, need, or area of interest that the user
wants to focus on. Extract it from the user's complete request.

Do not explain your answer.
Do not perform a search.
Do not provide recommendations.
Do not add evidence.
Do not add confidence scores.
Do not invent unnecessary details.

Return only valid JSON using exactly this format:

{
  "targetEntity": "the identified target",
  "problem": "the identified problem or need"
}

If the target entity cannot be clearly identified, return:

{
  "targetEntity": null,
  "problem": "customer"
}

If the problem, need, or area of interest cannot be clearly identified,
use "customer" as the problem value.

The problem value must never be null or empty.
`;

// ────────────────────────────────────────────────────────────────
// UNDERSTAND REQUEST
// ────────────────────────────────────────────────────────────────

async function understandRequest(message) {
    console.log('[UnderstandRequest] Started');
    console.log('[UnderstandRequest] Received message:', message);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(
            `[UnderstandRequest] Attempt ${attempt}/${MAX_ATTEMPTS}`
        );

        try {
            const completion = await openai.chat.completions.create({
                model: MODEL,
                temperature: 0,
                response_format: {
                    type: 'json_object',
                },
                messages: [
                    {
                        role: 'system',
                        content: SYSTEM_INSTRUCTIONS,
                    },
                    {
                        role: 'user',
                        content: message,
                    },
                ],
            });

            console.log('[UnderstandRequest] OpenAI response received');

            const content = completion.choices?.[0]?.message?.content;

            console.log('[UnderstandRequest] Raw model response:', content);

            if (!content) {
                console.error(
                    '[UnderstandRequest] Model returned an empty response'
                );
                continue;
            }

            const parsedResult = JSON.parse(content);

            console.log(
                '[UnderstandRequest] Parsed model response:',
                parsedResult
            );

            const targetEntity = parsedResult?.targetEntity;
            const problem = parsedResult?.problem;

            if (
                typeof targetEntity === 'string' &&
                targetEntity.trim().length > 0
            ) {
                const result = {
                    targetEntity: targetEntity.trim(),
                    problem:
                        typeof problem === 'string' &&
                        problem.trim().length > 0
                            ? problem.trim()
                            : FALLBACK_PROBLEM,
                };

                console.log('[UnderstandRequest] Final result:', result);

                return result;
            }

            console.warn(
                '[UnderstandRequest] No valid target entity returned'
            );
        } catch (error) {
            console.error(
                `[UnderstandRequest] Attempt ${attempt} failed`
            );

            console.error('[UnderstandRequest] Error name:', error.name);
            console.error('[UnderstandRequest] Error message:', error.message);
            console.error('[UnderstandRequest] Error status:', error.status);
            console.error('[UnderstandRequest] Full error:', error);
        }
    }

    const fallbackResult = {
        targetEntity: FALLBACK_TARGET,
        problem: FALLBACK_PROBLEM,
    };

    console.warn(
        '[UnderstandRequest] All attempts failed. Using fallback:',
        fallbackResult
    );

    return fallbackResult;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = understandRequest;
