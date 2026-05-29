/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, FinishReason } from "@google/genai";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API routes FIRST
  app.post("/api/generate", async (req, res) => {
    try {
      const { modelName, prompt, videoUrl, temperature = 0.75 } = req.body;

      // Access key in server-side process environment
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server." });
      }

      const ai = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      // Map any unrecognized or unavailable proprietary models to the fully available, free gemini-3.5-flash
      let modelToUse = modelName;
      if (!modelName || modelName.startsWith('gemini-2.5') || modelName.startsWith('gemini-2.0') || modelName.startsWith('gemini-1.5') || modelName === 'gemini-pro') {
        modelToUse = 'gemini-3.5-flash';
      }

      const parts: any[] = [{ text: prompt }];

      if (videoUrl) {
        try {
          parts.push({
            fileData: {
              mimeType: 'video/mp4',
              fileUri: videoUrl,
            },
          });
        } catch (error) {
          console.error('Error processing video input:', error);
          return res.status(400).json({ error: `Failed to process video input from URL: ${videoUrl}` });
        }
      }

      let response;
      let attempts = 3;
      for (let i = 0; i < attempts; i++) {
        try {
          response = await ai.models.generateContent({
            model: modelToUse,
            contents: [{ role: 'user', parts }],
            config: {
              temperature,
            },
          });
          break; // success!
        } catch (genError: any) {
          const isRateLimitOrUnavailable = 
            genError.status === 429 || 
            genError.status === 503 ||
            genError.statusCode === 429 ||
            genError.statusCode === 503 ||
            String(genError).includes('503') ||
            String(genError).includes('UNAVAILABLE') ||
            String(genError.message).includes('overloaded') ||
            String(genError.message).includes('demand') ||
            String(genError.status).includes('UNAVAILABLE');

          if (isRateLimitOrUnavailable && i < attempts - 1) {
            const delay = (i + 1) * 1500;
            console.warn(`Gemini API busy (attempt ${i + 1}/${attempts}). Retrying in ${delay}ms...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
          } else {
            throw genError;
          }
        }
      }

      // Check for prompt blockage
      if (response.promptFeedback?.blockReason) {
        return res.status(400).json({
          error: `Content generation failed: Prompt blocked (reason: ${response.promptFeedback.blockReason})`,
        });
      }

      // Check for response blockage
      if (!response.candidates || response.candidates.length === 0) {
        return res.status(500).json({ error: 'Content generation failed: No candidates returned.' });
      }

      const firstCandidate = response.candidates[0];

      // Check for finish reasons other than STOP
      if (
        firstCandidate.finishReason &&
        firstCandidate.finishReason !== FinishReason.STOP
      ) {
        if (firstCandidate.finishReason === FinishReason.SAFETY) {
          return res.status(400).json({
            error: 'Content generation failed: Response blocked due to safety settings.',
          });
        } else {
          return res.status(400).json({
            error: `Content generation failed: Stopped due to ${firstCandidate.finishReason}.`,
          });
        }
      }

      return res.json({ text: response.text });
    } catch (error: any) {
      console.error('An error occurred during Gemini API call or response processing:', error);
      
      let statusCode = 500;
      if (error && typeof error === 'object') {
        const rawCode = error.status ?? error.statusCode ?? error.code ?? error.error?.code;
        if (typeof rawCode === 'number' && rawCode >= 100 && rawCode < 600) {
          statusCode = rawCode;
        } else if (typeof rawCode === 'string') {
          const parsed = parseInt(rawCode, 10);
          if (!isNaN(parsed) && parsed >= 100 && parsed < 600) {
            statusCode = parsed;
          }
        }
      }

      let message = 'Internal server error during content generation';
      let errorStr = '';
      if (error && error.message) {
        errorStr = String(error.message);
      } else if (error && typeof error === 'string') {
        errorStr = error;
      } else {
        errorStr = String(error);
      }

      // If the message is structured JSON, extract the message details
      if (errorStr.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(errorStr);
          if (parsed?.error?.message) {
            message = parsed.error.message;
          } else if (parsed?.message) {
            message = parsed.message;
          } else {
            message = errorStr;
          }
        } catch (_) {
          message = errorStr;
        }
      } else {
        message = errorStr;
      }

      // Format rate limit & quota messages to be extremely actionable and helpful
      const isQuotaExceeded = 
        statusCode === 429 || 
        errorStr.toLowerCase().includes('quota') || 
        errorStr.toLowerCase().includes('rate') || 
        errorStr.toLowerCase().includes('exhausted') || 
        errorStr.toLowerCase().includes('429');

      if (isQuotaExceeded) {
        statusCode = 429;
        message = `Google AI Studio free tier quota limit exceeded. Since multiple built apps share the default API quota, limits can occasionally be reached during peak activities.\n\nTo resolve this:\n1. Please wait 30-60 seconds and click the "Retry" button.\n2. For higher limits, you can add your own free custom Gemini API key via the "Settings" (gear icon) menu in the AI Studio sidebar. Our backend will use your key automatically to give you independent, higher quota limit lanes.`;
      }
      
      return res.status(statusCode).json({ error: message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
