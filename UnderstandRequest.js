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

The target entity is the type of thing the user is looking for, such as:
- company
- school
- restaurant
- hotel
- agency
- hospital
- software
- product
- person
- location
- or any other suitable entity

Do not explain your answer.
Do not perform a search.
Do not provide recommendations.
Do not analyze anything else.

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
// TARGET VALIDATION
// ────────────────────────────────────────────────────────────────

function getValidTarget(result) {
    if (!result || typeof result !== 'object') {
        return null;
    }

    if (typeof result.targetEntity !== 'string') {
        return null;
    }

    const targetEntity = result.targetEntity.trim();

    if (!targetEntity) {
        return null;
    }

    return targetEntity;
}

// ────────────────────────────────────────────────────────────────
// UNDERSTAND REQUEST
// ────────────────────────────────────────────────────────────────

async function understandRequest(message) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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

            const content = completion.choices?.[0]?.message?.content;

            if (!content) {
                continue;
            }

            const parsedResult = JSON.parse(content);
            const targetEntity = getValidTarget(parsedResult);

            if (targetEntity) {
                return {
                    targetEntity,
                };
            }
        } catch (error) {
            // If this was the first failed attempt, the loop retries.
            // If this was the second failed attempt, the fallback is returned.
        }
    }

    // Fallback after two failed attempts or an unclear response.
    return {
        targetEntity: FALLBACK_TARGET,
    };
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = understandRequest;
