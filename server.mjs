import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const projectDirectory = import.meta.dirname;
const defaultMaxAudioBytes = 25 * 1024 * 1024;
const transcriptionUrl = "https://api.elevenlabs.io/v1/speech-to-text";

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

export function createAppServer({
  apiKey = process.env.ELEVENLABS_API_KEY,
  modelId = process.env.ELEVENLABS_MODEL_ID || "scribe_v2_medical",
  fetchImpl = fetch,
  maxAudioBytes = defaultMaxAudioBytes,
} = {}) {
  return createHttpServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/nurseIntake.html")) {
      try {
        const pagePath = resolve(projectDirectory, "nurseIntake.html");
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
