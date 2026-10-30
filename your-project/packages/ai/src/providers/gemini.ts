import { GoogleGenAI } from "@google/genai";
import type { ModelProvider, ProviderRequest } from "./types";

type GenerateContent = GoogleGenAI["models"]["generateContent"];

export class GeminiProvider implements ModelProvider {
  readonly name = "gemini";
  private readonly generateContent: GenerateContent;

  constructor(
    readonly model: string,
    apiKey: string,
    // Injected in tests so no request leaves the machine
    generateContent?: GenerateContent
  ) {
    if (generateContent) {
      this.generateContent = generateContent;
    } else {
      // No SDK retries: callModel decides when to retry, inside its timeout
      const ai = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
      this.generateContent = (params) => ai.models.generateContent(params);
    }
  }

  async generate(req: ProviderRequest): Promise<string> {
    const response = await this.generateContent({
      model: this.model,
      contents: [
        {
          role: "user",
          parts: [
            ...req.images.map((img) => ({
              inlineData: { mimeType: img.mediaType, data: Buffer.from(img.data).toString("base64") },
            })),
            { text: req.prompt },
          ],
        },
      ],
      config: {
        systemInstruction: req.system,
        responseMimeType: "application/json",
        responseJsonSchema: req.jsonSchema,
        temperature: 0,
        abortSignal: req.signal,
      },
    });
    const text = response.text;
    if (!text) throw new Error("Gemini returned no text");
    return text;
  }
}
