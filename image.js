// image.js
const axios = require('axios');

/**
 * Analyzes an image using GPT-4o-mini and returns a text description.
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
                            text: "Describe this image in full detail. If it is a drawing, sketch, diagram, or chart, describe every element, color, shape, text, and potential meaning. If it is a photo, describe the scene, objects, people, actions, and context thoroughly. Be precise and objective." 
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
            max_tokens: 500
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
