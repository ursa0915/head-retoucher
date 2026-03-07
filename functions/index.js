const functions = require("firebase-functions");
const { GoogleGenAI } = require("@google/genai");

// The core retouching prompt
const RETOUCH_PROMPT = `Role: Expert Retoucher & Generative AI Artist.
Task: Edit the provided photo following ALL instructions below with absolute precision.

CRITICAL CONSTRAINTS (MUST NOT VIOLATE):
- FREEZE the person's facial expression exactly as-is. Do NOT alter the expression in any way.
- FREEZE the head angle/pose exactly as-is. Do NOT rotate, tilt, or shift the head.
- Output ONLY the isolated head on a PURE WHITE (#FFFFFF) background.
- Cut precisely at the jawline/chin area. Include NO neck, NO shoulders, NO body.
- The result must be a clean head cutout with no visible edge artifacts.

STEP 1 - INPAINTING & COMPLETION:
- If the top of the head, hair, or chin is cropped/cut off in the original photo, you MUST generate and seamlessly fill in the missing areas to create a complete, uncropped head.
- The inpainted areas must blend perfectly with the existing image.

STEP 2 - HAIR:
- Maintain the original hairstyle exactly. Strictly KEEP the original hair length — do NOT elongate or shorten the hair.
- Make hair neat, smooth, and frizz-free.
- CRITICAL for braids/pigtails: They MUST be perfectly neat, smooth, and absolutely symmetrical. Fill in any visible gaps or sparse areas in the hair structure to create a full, dense, and neat appearance.

STEP 3 - LIGHTING:
- Apply soft, bright natural daylight lighting evenly across the face.
- Gently brighten the overall exposure to create a fresh, well-lit appearance.

STEP 4 - SKIN:
- Increase skin brightness slightly to achieve a fairer, paler tone that still looks healthy (avoid "dead white" or washed out).
- Add a very pale, barely-there natural pink blush to the cheeks.
- Add a minimal, subtle healthy sheen (micro-highlight) on the cheekbones only.

OUTPUT FORMAT:
- Head only, cleanly isolated on a pure white (#FFFFFF) background.
- High resolution, professional retouching quality.
- Photorealistic result — must look like a real photograph, not AI-generated art.`;

exports.retouchHead = functions
    .runWith({
        timeoutSeconds: 300,
        memory: "1GB",
        maxInstances: 10,
        secrets: ["GEMINI_API_KEY"],
    })
    .https.onRequest((req, res) => {
        // Handle CORS
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.set("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
            res.status(204).send("");
            return;
        }

        // Only allow POST
        if (req.method !== "POST") {
            res.status(405).json({ error: "Method not allowed. Use POST." });
            return;
        }

        (async () => {
            try {
                const { imageBase64, mimeType } = req.body;

                // Validate input
                if (!imageBase64) {
                    res.status(400).json({ error: "Missing imageBase64 in request body." });
                    return;
                }

                const resolvedMimeType = mimeType || "image/jpeg";

                // Initialize Gemini AI client
                const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

                // Build the request with image + prompt
                const contents = [
                    {
                        text: RETOUCH_PROMPT,
                    },
                    {
                        inlineData: {
                            mimeType: resolvedMimeType,
                            data: imageBase64,
                        },
                    },
                ];

                // Call Gemini API
                const response = await ai.models.generateContent({
                    model: "gemini-3-pro-image-preview",
                    contents: contents,
                    config: {
                        responseModalities: ["Image"],
                    },
                });

                // Extract the generated image from the response
                const candidates = response.candidates;
                if (!candidates || candidates.length === 0) {
                    res.status(500).json({
                        error: "No response from Gemini API.",
                        details: "The model did not return any candidates.",
                    });
                    return;
                }

                const parts = candidates[0].content.parts;
                let resultImage = null;

                for (const part of parts) {
                    if (part.inlineData) {
                        resultImage = {
                            data: part.inlineData.data,
                            mimeType: part.inlineData.mimeType || "image/png",
                        };
                        break;
                    }
                }

                if (!resultImage) {
                    // Check if there's text feedback (e.g., safety block reason)
                    let textFeedback = "";
                    for (const part of parts) {
                        if (part.text) {
                            textFeedback += part.text;
                        }
                    }
                    res.status(500).json({
                        error: "No image generated.",
                        details:
                            textFeedback ||
                            "The model did not return an image. This may be due to content safety filters.",
                    });
                    return;
                }

                // Return the processed image
                res.status(200).json({
                    success: true,
                    image: {
                        data: resultImage.data,
                        mimeType: resultImage.mimeType,
                    },
                });
            } catch (error) {
                console.error("Error processing image:", error);

                // Provide meaningful error messages
                let errorMessage = "Internal server error.";
                if (error.message) {
                    if (error.message.includes("SAFETY")) {
                        errorMessage =
                            "Image was blocked by safety filters. Please try a different photo.";
                    } else if (error.message.includes("quota")) {
                        errorMessage = "API quota exceeded. Please try again later.";
                    } else {
                        errorMessage = error.message;
                    }
                }

                res.status(500).json({
                    error: errorMessage,
                    details: error.message || "Unknown error",
                });
            }
        })();
    });
