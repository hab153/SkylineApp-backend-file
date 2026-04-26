// converter.js
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const csv = require('csv-parser');
const fs = require('fs');

/**
 * Converts a file buffer to text based on its MIME type.
 * @param {string} filePath - Path to the temporary uploaded file.
 * @param {string} mimeType - The MIME type of the file.
 * @returns {Promise<string>} - The extracted text content.
 */
async function convertFileToText(filePath, mimeType) {
    try {
        if (mimeType === 'application/pdf') {
            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdf(dataBuffer);
            return data.text;
        } 
        else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            // .docx
            const result = await mammoth.extractRawText({ path: filePath });
            return result.value;
        } 
        else if (mimeType === 'text/csv') {
            // .csv
            return new Promise((resolve, reject) => {
                let results = [];
                fs.createReadStream(filePath)
                    .pipe(csv())
                    .on('data', (data) => results.push(data))
                    .on('end', () => resolve(JSON.stringify(results)))
                    .on('error', (err) => reject(err));
            });
        } 
        else if (mimeType === 'text/plain') {
            // .txt
            return fs.readFileSync(filePath, 'utf8');
        } 
        else {
            throw new Error("Unsupported file type");
        }
    } catch (error) {
        console.error("❌ Error converting file:", error);
        throw new Error("Failed to convert file to text");
    }
}

module.exports = { convertFileToText };
