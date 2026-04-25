// image.js
const axios = require('axios');

/**
 * Analyzes an image using GPT-4o-mini and returns a concise but detailed text description.
 * Optimized for cost and speed.
 * @param {Buffer} imageBuffer - The resized image buffer.
 * @returns {Promise<string>} - The detailed text description of the image.
 */
async function analyzeImage(imageBuffer) {
    try {
        // Convert buffer to base64 string
        const base64Image = imageBuffer.toString('base64');

        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "user",
                    content: [
                        { 
                            type: "text", 
                            text: "Describe this image precisely. Include key objects, colors, text, and context. If it's a diagram or sketch, explain its structure and meaning. Keep the description under 150 words." 
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Image}`
                            }
                        }
                    ]
                }
            ],
            max_tokens: 250 // Reduced from 500 to save cost
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data.choices[0].message.content;

    } catch (error) {
        console.error("❌ Error analyzing image:", error.response ? error.response.data : error.message);
        throw new Error("Failed to analyze image");
    }
}

module.exports = { analyzeImage };
