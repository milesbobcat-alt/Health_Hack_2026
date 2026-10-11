import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ListLanguagesCommand,
  TranslateClient,
  TranslateDocumentCommand,
} from "@aws-sdk/client-translate";

const projectDirectory = import.meta.dirname;
const defaultMaxAudioBytes = 25 * 1024 * 1024;
const maxSpeechTextCharacters = 5000;
const maxTranslationDocumentBytes = 100_000;
const maxTranslationRequestBytes = 600_000;
const transcriptionUrl = "https://api.elevenlabs.io/v1/speech-to-text";
const speechUrl = "https://api.elevenlabs.io/v1/text-to-speech";
const awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const patientPageOrigins = new Set([
  "http://127.0.0.1:5500",
  "http://localhost:5500",
]);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readAudio(request, maxAudioBytes) {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxAudioBytes) {
    return { error: "Audio file exceeds the configured size limit.", statusCode: 413 };
  }

  const chunks = [];
  let totalBytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxAudioBytes && !tooLarge) {
      tooLarge = true;
      chunks.length = 0;
    }
    if (!tooLarge) chunks.push(chunk);
  }

  if (tooLarge) {
    return { error: "Audio file exceeds the configured size limit.", statusCode: 413 };
  }

  if (totalBytes === 0) {
    return { error: "The audio request body is empty.", statusCode: 400 };
  }

  return { audio: Buffer.concat(chunks, totalBytes) };
}

async function readJson(request, maxBytes) {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { error: "Request body exceeds the configured size limit.", statusCode: 413 };
  }

  const chunks = [];
  let totalBytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes && !tooLarge) {
      tooLarge = true;
      chunks.length = 0;
    }
    if (!tooLarge) chunks.push(chunk);
  }

  if (tooLarge) {
    return { error: "Request body exceeds the configured size limit.", statusCode: 413 };
  }
  if (totalBytes === 0) {
    return { error: "Request body must contain JSON.", statusCode: 400 };
  }

  try {
    return { value: JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8")) };
  } catch {
    return { error: "Request body must contain valid JSON.", statusCode: 400 };
  }
}

export function createAppServer({
  apiKey = process.env.ELEVENLABS_API_KEY,
  modelId = process.env.ELEVENLABS_MODEL_ID || "scribe_v2_medical",
  speechModelId = process.env.ELEVENLABS_TTS_MODEL_ID || "eleven_multilingual_v2",
  voiceId = process.env.ELEVENLABS_VOICE_ID,
  fetchImpl = fetch,
  maxAudioBytes = defaultMaxAudioBytes,
  translateClient = new TranslateClient({ region: awsRegion }),
} = {}) {
  let supportedLanguagesPromise;

  async function getSupportedLanguages() {
    if (!supportedLanguagesPromise) {
      supportedLanguagesPromise = (async () => {
        const languages = [];
        let nextToken;
        do {
          const input = { DisplayLanguageCode: "en", MaxResults: 500 };
          if (nextToken) input.NextToken = nextToken;
          const result = await translateClient.send(new ListLanguagesCommand(input));
          languages.push(...(result.Languages || []));
          nextToken = result.NextToken;
        } while (nextToken);
        return languages;
      })();
    }

    try {
      return await supportedLanguagesPromise;
    } catch (error) {
      supportedLanguagesPromise = undefined;
      throw error;
    }
  }

  return createHttpServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");

    if (url.pathname === "/api/translate/languages") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendJson(response, 405, { error: "Use GET to load supported translation languages." });
        return;
      }

      try {
        const languages = await getSupportedLanguages();
        sendJson(response, 200, {
          sourceLanguageCode: "en",
          languages: languages
            .filter(({ LanguageCode }) => LanguageCode !== "en")
            .sort((left, right) => left.LanguageName.localeCompare(right.LanguageName))
            .map(({ LanguageCode, LanguageName }) => ({
              code: LanguageCode,
              name: LanguageName,
            })),
        });
      } catch {
        sendJson(response, 502, {
          error: "Could not load languages from AWS Translate. Check AWS credentials, region, and translate:ListLanguages permission.",
        });
      }
      return;
    }

    if (url.pathname === "/api/translate/document") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendJson(response, 405, { error: "Use POST to translate a document." });
        return;
      }

      const contentType = request.headers["content-type"] || "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        sendJson(response, 415, { error: "Send the text and target language as application/json." });
        return;
      }

      const bodyResult = await readJson(request, maxTranslationRequestBytes);
      if (bodyResult.error) {
        sendJson(response, bodyResult.statusCode, { error: bodyResult.error });
        return;
      }

      const text = bodyResult.value?.text;
      const targetLanguageCode = bodyResult.value?.targetLanguageCode;
      if (typeof text !== "string" || !text.trim()) {
        sendJson(response, 400, { error: "Provide non-empty English discharge text to translate." });
        return;
      }
      if (Buffer.byteLength(text, "utf8") > maxTranslationDocumentBytes) {
        sendJson(response, 413, { error: "Text must be 100,000 bytes or fewer for AWS TranslateDocument." });
        return;
      }

      let targetLanguage;
      try {
        const languages = await getSupportedLanguages();
        targetLanguage = languages.find(({ LanguageCode }) => LanguageCode === targetLanguageCode);
      } catch {
        sendJson(response, 502, {
          error: "Could not load languages from AWS Translate. Check AWS credentials, region, and translate:ListLanguages permission.",
        });
        return;
      }

      if (!targetLanguage || targetLanguageCode === "en") {
        sendJson(response, 400, { error: "Choose a supported target language other than English." });
        return;
      }

      let result;
      try {
        result = await translateClient.send(new TranslateDocumentCommand({
          Document: {
            Content: Buffer.from(text, "utf8"),
            ContentType: "text/plain",
          },
          SourceLanguageCode: "en",
          TargetLanguageCode: targetLanguageCode,
        }));
      } catch {
        sendJson(response, 502, {
          error: "AWS Translate could not translate this text. Check AWS credentials, region, permissions, and the language pair.",
        });
        return;
      }

      const translatedContent = result.TranslatedDocument?.Content;
      if (!translatedContent || translatedContent.length === 0) {
        sendJson(response, 502, { error: "AWS Translate returned an empty translation." });
        return;
      }

      sendJson(response, 200, {
        sourceLanguageCode: "en",
        targetLanguageCode,
        targetLanguageName: targetLanguage.LanguageName,
        translatedText: Buffer.from(translatedContent).toString("utf8"),
      });
      return;
    }

    if (url.pathname === "/api/speak") {
      const origin = request.headers.origin;
      if (patientPageOrigins.has(origin)) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
      }

      if (request.method === "OPTIONS") {
        if (!patientPageOrigins.has(origin)) {
          sendJson(response, 403, { error: "This origin is not allowed." });
          return;
        }
        response.writeHead(204, {
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Max-Age": "600",
        });
        response.end();
        return;
      }
    }

    const pageFiles = {
      "/": "nurseIntake.html",
      "/nurseIntake.html": "nurseIntake.html",
      "/ptView.html": "ptView.html",
    };
    if (request.method === "GET" && pageFiles[url.pathname]) {
      try {
        const pagePath = resolve(projectDirectory, pageFiles[url.pathname]);
        const pageInfo = await stat(pagePath);
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Length": pageInfo.size,
          "Content-Type": "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        });
        createReadStream(pagePath).pipe(response);
      } catch {
        sendJson(response, 500, { error: "The nurse intake page could not be loaded." });
      }
      return;
    }

    if (url.pathname === "/api/speak") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendJson(response, 405, { error: "Use POST to generate speech." });
        return;
      }

      if (!apiKey || !voiceId) {
        sendJson(response, 503, {
          error: "Speech generation is not configured on the server.",
        });
        return;
      }

      const contentType = request.headers["content-type"] || "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        sendJson(response, 415, { error: "Send the text as application/json." });
        return;
      }

      const bodyResult = await readJson(request, maxSpeechTextCharacters * 4);
      if (bodyResult.error) {
        sendJson(response, bodyResult.statusCode, { error: bodyResult.error });
        return;
      }

      const text = bodyResult.value?.text;
      if (typeof text !== "string" || !text.trim()) {
        sendJson(response, 400, { error: "Provide non-empty patient text to read aloud." });
        return;
      }
      if (text.length > maxSpeechTextCharacters) {
        sendJson(response, 413, {
          error: `Text must be ${maxSpeechTextCharacters} characters or fewer.`,
        });
        return;
      }

      let providerResponse;
      try {
        providerResponse = await fetchImpl(
          `${speechUrl}/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "xi-api-key": apiKey,
            },
            body: JSON.stringify({ text: text.trim(), model_id: speechModelId }),
            signal: AbortSignal.timeout(60_000),
          },
        );
      } catch {
        sendJson(response, 502, { error: "The speech generation service could not be reached." });
        return;
      }

      if (!providerResponse.ok) {
        sendJson(response, 502, {
          error: "The speech generation service rejected the text.",
          providerStatus: providerResponse.status,
        });
        return;
      }

      try {
        const audio = Buffer.from(await providerResponse.arrayBuffer());
        if (audio.length === 0) {
          sendJson(response, 502, { error: "The speech generation service returned empty audio." });
          return;
        }
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Length": audio.length,
          "Content-Type": "audio/mpeg",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(audio);
      } catch {
        sendJson(response, 502, { error: "The speech generation service returned invalid audio." });
      }
      return;
    }

    if (url.pathname !== "/api/transcribe") {
      sendJson(response, 404, { error: "Not found." });
      return;
    }

    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "Use POST to submit an audio recording." });
      return;
    }

    if (!apiKey) {
      sendJson(response, 503, { error: "Speech transcription is not configured on the server." });
      return;
    }

    const contentType = request.headers["content-type"] || "";
    const mediaType = contentType.split(";")[0].trim().toLowerCase();
    if (!mediaType.startsWith("audio/")) {
      sendJson(response, 415, { error: "Send audio bytes with an audio/* Content-Type." });
      return;
    }

    const audioResult = await readAudio(request, maxAudioBytes);
    if (audioResult.error) {
      if (!response.destroyed) {
        sendJson(response, audioResult.statusCode, { error: audioResult.error });
      }
      return;
    }

    const form = new FormData();
    form.set("model_id", modelId);
    const extensionByMediaType = {
      "audio/aac": ".aac",
      "audio/flac": ".flac",
      "audio/mp4": ".mp4",
      "audio/mpeg": ".mp3",
      "audio/ogg": ".ogg",
      "audio/wav": ".wav",
      "audio/webm": ".webm",
      "audio/x-wav": ".wav",
    };
    form.set(
      "file",
      new Blob([audioResult.audio], { type: mediaType }),
      `recording${extensionByMediaType[mediaType] || ".audio"}`,
    );

    let providerResponse;
    try {
      providerResponse = await fetchImpl(transcriptionUrl, {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      sendJson(response, 502, { error: "The speech transcription service could not be reached." });
      return;
    }

    if (!providerResponse.ok) {
      sendJson(response, 502, {
        error: "The speech transcription service rejected the audio.",
        providerStatus: providerResponse.status,
      });
      return;
    }

    let result;
    try {
      result = await providerResponse.json();
    } catch {
      sendJson(response, 502, { error: "The speech transcription service returned an invalid response." });
      return;
    }

    if (typeof result.text !== "string") {
      sendJson(response, 502, { error: "The speech transcription service returned no transcript." });
      return;
    }

    sendJson(response, 200, { text: result.text });
  });
}

const entryPoint = process.argv[1];
if (entryPoint && pathToFileURL(resolve(entryPoint)).href === import.meta.url) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3000);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("PORT must be an integer between 1 and 65535.");
    process.exitCode = 1;
  } else {
    createAppServer().listen(port, host, () => {
      console.log(`Nurse intake server listening at http://${host}:${port}`);
    });
  }
}
