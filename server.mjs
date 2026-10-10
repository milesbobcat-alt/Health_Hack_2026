import { createFhirClient, DEFAULT_FHIR_BASE_URL } from "./fhir.mjs";
import { spawn } from "node:child_process";
import { createChecklistStore, createReminderSender } from "./checklists.mjs";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const projectDirectory = import.meta.dirname;
const defaultMaxAudioBytes = 25 * 1024 * 1024;
const maxSpeechTextCharacters = 5000;
const transcriptionUrl = "https://api.elevenlabs.io/v1/speech-to-text";
const speechUrl = "https://api.elevenlabs.io/v1/text-to-speech";

const maxPdfBytes = 15 * 1024 * 1024;

async function extractPdf(bytes) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.env.PDF_PYTHON || "python3", [resolve(projectDirectory, "pdf_extract.py")], {
      env: { ...process.env, PYTHONPATH: resolve(projectDirectory, "vendor/python") },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    const timeout = setTimeout(() => child.kill(), 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 500_000) child.kill(); });
    child.on("error", rejectResult);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) { rejectResult(new Error("PDF extraction failed.")); return; }
      try { resolveResult(JSON.parse(output)); } catch { rejectResult(new Error("PDF extraction failed.")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(bytes);
  });
}

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
  checklistStore = createChecklistStore({ send: createReminderSender({ fetchImpl }) }),
  maxAudioBytes = defaultMaxAudioBytes,
  fhirBaseUrl = process.env.FHIR_BASE_URL || DEFAULT_FHIR_BASE_URL,
  fhirFetchImpl = fetch,
  fhirTimeoutMs = 15000,
} = {}) {
  const fhir = createFhirClient({ baseUrl: fhirBaseUrl, fetchImpl: fhirFetchImpl, timeoutMs: fhirTimeoutMs });
  const baseUrl = process.env.PUBLIC_BASE_URL || `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3000}`;
  const reminderTimer = setInterval(() => { void checklistStore.dispatchDue(baseUrl).catch(() => {}); }, 60_000);
  reminderTimer.unref();
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");

    if (url.pathname === "/api/extract-pdf" && request.method === "POST") {
      if (request.headers["content-type"]?.split(";")[0].trim() !== "application/pdf") {
        sendJson(response, 415, { error: "Choose a PDF file." });
        return;
      }
      if (Number(request.headers["content-length"]) > maxPdfBytes) {
        sendJson(response, 413, { error: "Choose a PDF under 15 MB." });
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxPdfBytes) { sendJson(response, 413, { error: "Choose a PDF under 15 MB." }); return; }
        chunks.push(chunk);
      }
      try {
        const result = await extractPdf(Buffer.concat(chunks));
        sendJson(response, result.error ? 422 : 200, result);
      } catch {
        sendJson(response, 500, { error: "The server could not extract PDF text." });
      }
      return;
    }


    async function readChecklistJson() {
      const body = await readJson(request, 30000);
      if (body.error) throw new Error(body.error);
      return body.value;
    }

    if (request.method === "GET" && (url.pathname === "/patient" || url.pathname.startsWith("/patient/"))) {
      const pagePath = resolve(projectDirectory, "ptView.html");
      response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff" });
      createReadStream(pagePath).pipe(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/care-plan.mjs") {
      response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/javascript; charset=utf-8", "X-Content-Type-Options": "nosniff" });
      createReadStream(resolve(projectDirectory, "care-plan.mjs")).pipe(response);
      return;
    }

    if (url.pathname === "/api/checklists" && request.method === "POST") {
      try {
        const plan = checklistStore.create(await readChecklistJson());
        await checklistStore.dispatchDue(baseUrl);
        sendJson(response, 201, { ...plan, link: `${baseUrl}/patient/${plan.id}`, delivery: checklistStore.delivery(plan.id) });
      } catch (error) { sendJson(response, 400, { error: error.message }); }
      return;
    }

    const checklistMatch = url.pathname.match(/^\/api\/checklists\/([A-Za-z0-9_-]+)(?:\/(items|delivery))?$/);
    if (checklistMatch) {
      const [, id, action] = checklistMatch;
      if (request.method === "GET" && !action) {
        const plan = checklistStore.get(id);
        sendJson(response, plan ? 200 : 404, plan || { error: "Checklist not found or expired." });
        return;
      }
      if (request.method === "PATCH" && action === "items") {
        try {
          const { index, done } = await readChecklistJson();
          const plan = checklistStore.update(id, index, done);
          sendJson(response, plan ? 200 : 404, plan || { error: "Checklist not found or expired." });
        } catch (error) { sendJson(response, 400, { error: error.message }); }
        return;
      }
      if (request.method === "GET" && action === "delivery") {
        const delivery = checklistStore.delivery(id);
        sendJson(response, delivery ? 200 : 404, delivery ? { delivery } : { error: "Checklist not found or expired." });
        return;
      }
    }

    const pageFiles = {
      "/": "nurseIntake.html",
      "/nurseIntake.html": "nurseIntake.html",
      "/ptView.html": "ptView.html",
      "/ptReadAloud.html": "ptReadAloud.html",
      "/patient-state.mjs": "patient-state.mjs",
    };
    if (request.method === "GET" && pageFiles[url.pathname]) {
      try {
        const pagePath = resolve(projectDirectory, pageFiles[url.pathname]);
        const pageInfo = await stat(pagePath);
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Length": pageInfo.size,
          "Content-Type": url.pathname.endsWith(".mjs") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        });
        createReadStream(pagePath).pipe(response);
      } catch {
        sendJson(response, 500, { error: "The nurse intake page could not be loaded." });
      }
      return;
    }

    if (url.pathname === "/api/patients" || url.pathname.startsWith("/api/patients/")) {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendJson(response, 405, { error: "Use GET to search or select patients." });
        return;
      }
      try {
        let result;
        if (url.pathname === "/api/patients") {
          if ([...url.searchParams.keys()].some(key => !["name", "cursor"].includes(key)) ||
              url.searchParams.getAll("name").length > 1 || url.searchParams.getAll("cursor").length > 1) {
            sendJson(response, 400, { error: "Provide only a name or a results-page cursor." });
            return;
          }
          result = await fhir.searchPatients({
            name: url.searchParams.get("name") ?? undefined,
            cursor: url.searchParams.get("cursor") ?? undefined,
          });
        } else {
          if (url.search) {
            sendJson(response, 400, { error: "Patient retrieval does not accept query parameters." });
            return;
          }
          const medicationPath = url.pathname.match(/^\/api\/patients\/([^/]+)\/medication-(statements|requests)$/);
          result = medicationPath
            ? await (medicationPath[2] === 'requests' ? fhir.getMedicationRequests(medicationPath[1]) : fhir.getMedicationStatements(medicationPath[1]))
            : await fhir.getPatient(url.pathname.slice("/api/patients/".length));
        }
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, error.status || 502, { error: error.status ? error.message : "The FHIR sandbox request failed. Please try again." });
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
  server.on("close", () => clearInterval(reminderTimer));
  return server;
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
