const { generateSuggestion } = require('./aiSuggestion');

const generateHint = async (req, res) => {
    try {
        const { messages } = req.body;
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Invalid message format.' });
        }

        const contextMessages = messages.slice(-3);
        const suggestion = await generateSuggestion(contextMessages);

        // remainingHints is attached by the checkHintLimit middleware
        res.json({
            suggestion,
            remainingHints: req.remainingHints
        });
    } catch (error) {
        console.error('AI Suggestion Error:', error);
        res.status(500).json({ error: 'Failed to generate suggestion.' });
    }
};

module.exports = { generateHint };
