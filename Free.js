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
const MAX_ATTEMPTS = 2;

// ────────────────────────────────────────────────────────────────
// GPT INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
Your only task is to identify the main target entity in the user's request.

Understand the complete meaning of the request, not only exact keywords.

The target entity is the type of thing the user is looking for, such as a company,
school, restaurant, hotel, agency, hospital, software, product, person, location,
or any other suitable entity.

Do not explain your answer.
Do not perform a search.
Do not provide recommendations.

Return only valid JSON using exactly this format:

{
  "targetEntity": "the identified target"
}

If the request is too unclear and you cannot determine the target entity, return:

{
  "targetEntity": null
}
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

            if (
                typeof targetEntity === 'string' &&
                targetEntity.trim().length > 0
            ) {
                const result = {
                    targetEntity: targetEntity.trim(),
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
