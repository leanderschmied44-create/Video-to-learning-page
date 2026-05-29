/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/* tslint:disable */

interface GenerateTextOptions {
  modelName: string;
  prompt: string;
  videoUrl?: string;
  temperature?: number;
  safetySettings?: any[];
}

/**
 * Generate text content using the server-side API proxy.
 *
 * @param options - Configuration options for the generation request.
 * @returns The response from the Gemini API proxy.
 */
export async function generateText(
  options: GenerateTextOptions,
): Promise<string> {
  let attempts = 3;
  let lastError: any = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(options),
      });

      if (!response.ok) {
        // If it's a 502 or 503 error, the server might be restarting. Let's retry!
        if ((response.status === 502 || response.status === 503) && i < attempts - 1) {
          const delay = (i + 1) * 1500;
          console.warn(`Server responded with ${response.status} (attempt ${i + 1}/${attempts}). Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        let errorMessage = 'Failed to generate content from backend model server.';
        try {
          const contentType = response.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            const errorJson = await response.json();
            if (errorJson?.error) {
              errorMessage = errorJson.error;
            }
          } else {
            const text = await response.text();
            if (text && text.length < 200 && !text.trim().startsWith('<')) {
              errorMessage = text;
            } else if (text && text.trim().startsWith('<')) {
              errorMessage = `Server Error (${response.status}): The server returned an HTML error response.`;
            }
          }
        } catch (_) {
          // Use fallback error message
        }
        throw new Error(errorMessage);
      }

      let data;
      try {
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          data = await response.json();
        } else {
          const text = await response.text();
          if (text.trim().startsWith('{')) {
            data = JSON.parse(text);
          } else {
            data = { text };
          }
        }
      } catch (err) {
        throw new Error('Failed to parse response from model server as JSON.');
      }

      if (typeof data?.text !== 'string') {
        throw new Error('Invalid format returned by the model server.');
      }

      return data.text;
    } catch (err: any) {
      lastError = err;
      // Network 'Failed to fetch' error: retry with backoff.
      if (i < attempts - 1) {
        const delay = (i + 1) * 1500;
        console.warn(`Network error during fetch (attempt ${i + 1}/${attempts}): ${err.message || err}. Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        break;
      }
    }
  }

  throw lastError || new Error('Failed to fetch after multiple attempts.');
}
