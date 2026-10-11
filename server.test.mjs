import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ListLanguagesCommand, TranslateDocumentCommand } from "@aws-sdk/client-translate";
import { createAppServer, createHandler, handler } from "./index.mjs";

const runningServers = new Set();

async function startServer(options) {
  const server = createAppServer(options);
  runningServers.add(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    server,
    url: `http://127.0.0.1:${port}`,
  };
}

afterEach(async () => {
  await Promise.all(
    [...runningServers].map(
      (server) =>
        new Promise((resolve, reject) => {
          server.close((error) => {
            runningServers.delete(server);
            if (error) reject(error);
            else resolve();
          });
        }),
    ),
  );
});

test("exports an API Gateway-compatible Lambda handler", async () => {
  const response = await handler({
    httpMethod: "GET",
    path: "/",
    headers: { host: "example.com" },
    requestContext: { stage: "test" },
    isBase64Encoded: false,
  }, {});

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/html/);
  assert.match(response.body, /Add care instructions/);
});

test("transcribes audio through ElevenLabs without returning provider data", async () => {
  let submittedForm;
  let submittedHeaders;
  const { url } = await startServer({
    apiKey: "test-api-key",
    modelId: "scribe_v2_medical",
    fetchImpl: async (requestUrl, options) => {
      assert.equal(requestUrl, "https://api.elevenlabs.io/v1/speech-to-text");
      submittedForm = options.body;
      submittedHeaders = options.headers;
      return Response.json({ text: "Take one tablet each morning.", transcription_id: "private-id" });
    },
  });

  const response = await fetch(`${url}/api/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "audio/webm;codecs=opus" },
    body: Buffer.from("fake audio"),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "Take one tablet each morning." });
  assert.equal(submittedHeaders["xi-api-key"], "test-api-key");
  assert.equal(submittedForm.get("model_id"), "scribe_v2_medical");
  assert.equal(submittedForm.get("file").type, "audio/webm");
  assert.equal(await submittedForm.get("file").text(), "fake audio");
});

test("rejects non-audio requests without contacting ElevenLabs", async () => {
  const { url } = await startServer({
    apiKey: "test-api-key",
    fetchImpl: async () => {
      assert.fail("Provider must not be called for a non-audio request.");
    },
  });

  const response = await fetch(`${url}/api/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "not audio",
  });

  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: "Send audio bytes with an audio/* Content-Type." });
});

test("returns a configuration error when the API key is missing", async () => {
  const { url } = await startServer({ apiKey: "" });
  const response = await fetch(`${url}/api/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "audio/webm" },
    body: Buffer.from("fake audio"),
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Speech transcription is not configured on the server.",
  });
});

test("rejects audio larger than the configured limit", async () => {
  const { url } = await startServer({
    apiKey: "test-api-key",
    maxAudioBytes: 4,
    fetchImpl: async () => {
      assert.fail("Provider must not be called for oversized audio.");
    },
  });

  const response = await fetch(`${url}/api/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "audio/webm" },
    body: Buffer.from("12345"),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: "Audio file exceeds the configured size limit.",
  });
});

test("serves the intake page from the root path", async () => {
  const { url } = await startServer();
  const response = await fetch(url);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const page = await response.text();
  assert.match(page, /Add care instructions/);
  assert.match(page, /id="start-recording"/);
  assert.match(page, /\/api\/transcribe/);
  assert.match(page, /id="submit-discharge"/);
  assert.match(page, /src="\/translate\.js\?v=html-document-v3"/);
});

test("serves the patient view page with read-aloud controls", async () => {
  const { url } = await startServer();
  const response = await fetch(`${url}/ptView.html`);

  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /class="patient-layout"/);
  assert.match(page, /Recovery checklist/);
  assert.match(page, /id="medications-tab"/);
  assert.match(page, /id="wounds-tab"/);
  assert.doesNotMatch(page, /id="avs-transcript"/);
  assert.doesNotMatch(page, /Select a sentence to hear it read aloud or view a simpler explanation\./);
  assert.doesNotMatch(page, /Approved text is sent to ElevenLabs to generate audio\./);
  assert.doesNotMatch(page, /id="speech-approval"/);
  assert.match(page, /id="patient-data"/);
  assert.match(page, /data-translate-value/);
  assert.match(page, /Play Out Loud/);
  assert.match(page, /Stop reading/);
  assert.match(page, /id="pdf-link"/);
  assert.match(page, /class="button avs-document-link"/);
  assert.match(page, /\/api\/discharge\//);
  assert.match(page, /\/api\/speak/);
  assert.match(page, /src="\/translate\.js\?v=html-document-v3"/);
});

test("serves shared AWS Translate client-side controls", async () => {
  const { url } = await startServer();
  const response = await fetch(`${url}/translate.js`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/javascript/);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const script = await response.text();
  assert.match(script, /\/api\/translate\/languages/);
  assert.match(script, /"Content-Type": "text\/html; charset=utf-8"/);
  assert.match(script, /"X-Target-Language": targetLanguage/);
  assert.match(script, /translation-text-\$\{index\}/);
  assert.match(script, /getElementById\(item\.id\)/);
  assert.doesNotMatch(script, /AWS Translate returned HTML with an unexpected structure/);
});

test("returns JSON for unknown API routes", async () => {
  const { url } = await startServer();
  const response = await fetch(`${url}/api/translate/missing`);

  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await response.json(), {
    error: "The requested API endpoint was not found.",
  });
});

test("lists all AWS Translate languages, follows pagination, and caches the result", async () => {
  const commands = [];
  const { url } = await startServer({
    translateClient: {
      send: async (command) => {
        commands.push(command);
        assert.ok(command instanceof ListLanguagesCommand);
        if (command.input.NextToken) {
          return {
            Languages: [{ LanguageCode: "es", LanguageName: "Spanish" }],
          };
        }
        return {
          Languages: [{ LanguageCode: "en", LanguageName: "English" }],
          NextToken: "next-page",
        };
      },
    },
  });

  const firstResponse = await fetch(`${url}/api/translate/languages`);
  const secondResponse = await fetch(`${url}/api/translate/languages`);

  assert.equal(firstResponse.status, 200);
  assert.deepEqual(await firstResponse.json(), {
    languages: [
      { code: "en", name: "English" },
      { code: "es", name: "Spanish" },
    ],
  });
  assert.equal(secondResponse.status, 200);
  assert.equal(commands.length, 2);
  assert.equal(commands[0].input.DisplayLanguageCode, "en");
  assert.equal(commands[1].input.NextToken, "next-page");
});

test("translates full HTML documents through AWS Translate Document", async () => {
  const commands = [];
  const { url } = await startServer({
    translateClient: {
      send: async (command) => {
        commands.push(command);
        if (command instanceof ListLanguagesCommand) {
          return { Languages: [{ LanguageCode: "es", LanguageName: "Spanish" }] };
        }
        assert.ok(command instanceof TranslateDocumentCommand);
        return {
          TranslatedDocument: {
            Content: Buffer.from("<html><body><h1>Instrucciones de cuidado</h1></body></html>"),
          },
        };
      },
    },
  });

  const response = await fetch(`${url}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetLanguage: "es",
      html: "<!DOCTYPE html><html><body><h1>Care instructions</h1></body></html>",
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    translatedHtml: "<html><body><h1>Instrucciones de cuidado</h1></body></html>",
  });
  const translationCommand = commands.find((command) => command instanceof TranslateDocumentCommand);
  assert.ok(translationCommand);
  assert.deepEqual(translationCommand.input, {
    Document: {
      Content: Buffer.from("<!DOCTYPE html><html><body><h1>Care instructions</h1></body></html>"),
      ContentType: "text/html",
    },
    SourceLanguageCode: "auto",
    TargetLanguageCode: "es",
  });
});

test("translates a raw HTML request body using its target-language header", async () => {
  let translateCommand;
  const { url } = await startServer({
    translateClient: {
      send: async (command) => {
        if (command instanceof ListLanguagesCommand) {
          return { Languages: [{ LanguageCode: "es", LanguageName: "Spanish" }] };
        }
        translateCommand = command;
        return {
          TranslatedDocument: { Content: Buffer.from("<html><body>Hola</body></html>") },
        };
      },
    },
  });
  const response = await fetch(`${url}/api/translate`, {
    method: "POST",
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Target-Language": "es",
    },
    body: "<html><body>Hello</body></html>",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    translatedHtml: "<html><body>Hola</body></html>",
  });
  assert.equal(translateCommand.input.TargetLanguageCode, "es");
  assert.equal(
    Buffer.from(translateCommand.input.Document.Content).toString("utf8"),
    "<html><body>Hello</body></html>",
  );
});

test("translates a raw HTML API Gateway Lambda request body", async () => {
  let translateCommand;
  const lambdaHandler = createHandler({
    translateClient: {
      send: async (command) => {
        if (command instanceof ListLanguagesCommand) {
          return { Languages: [{ LanguageCode: "es", LanguageName: "Spanish" }] };
        }
        translateCommand = command;
        return {
          TranslatedDocument: { Content: Buffer.from("<html><body>Hola</body></html>") },
        };
      },
    },
  });

  const response = await lambdaHandler({
    httpMethod: "POST",
    path: "/api/translate",
    headers: {
      host: "example.com",
      "content-type": "text/html; charset=utf-8",
      "x-target-language": "es",
    },
    body: "<html><body>Hello</body></html>",
    isBase64Encoded: false,
    requestContext: {
      stage: "test",
      identity: { sourceIp: "127.0.0.1" },
    },
  }, {});

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    translatedHtml: "<html><body>Hola</body></html>",
  });
  assert.equal(translateCommand.input.TargetLanguageCode, "es");
  assert.equal(
    Buffer.from(translateCommand.input.Document.Content).toString("utf8"),
    "<html><body>Hello</body></html>",
  );
});

test("rejects invalid HTML documents and unsupported AWS Translate languages", async () => {
  const { url } = await startServer({
    translateClient: {
      send: async (command) => {
        assert.ok(command instanceof ListLanguagesCommand);
        return { Languages: [{ LanguageCode: "es", LanguageName: "Spanish" }] };
      },
    },
  });

  const unsupportedLanguageResponse = await fetch(`${url}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetLanguage: "xx", html: "<p>Hello</p>" }),
  });
  assert.equal(unsupportedLanguageResponse.status, 400);
  assert.deepEqual(await unsupportedLanguageResponse.json(), {
    error: "Choose a supported target language.",
  });

  const emptyTextResponse = await fetch(`${url}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetLanguage: "es", html: "   " }),
  });
  assert.equal(emptyTextResponse.status, 400);
  assert.deepEqual(await emptyTextResponse.json(), {
    error: "The translation request did not include an HTML document. Refresh the page and try again.",
  });
});

test("rejects HTML documents larger than AWS Translate's synchronous document limit", async () => {
  const { url } = await startServer({
    translateClient: {
      send: async (command) => {
        assert.ok(command instanceof ListLanguagesCommand);
        return { Languages: [{ LanguageCode: "es", LanguageName: "Spanish" }] };
      },
    },
  });
  const response = await fetch(`${url}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetLanguage: "es", html: `<p>${"a".repeat(100 * 1024)}</p>` }),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: "HTML documents must be 100 KB or smaller for AWS Translate.",
  });
});

test("uploads discharge PDF and persists the matching 30-day DynamoDB record", async () => {
  const calls = [];
  const fixedNow = Date.parse("2026-10-10T12:00:00.000Z");
  const { url } = await startServer({
    tableName: "Discharges",
    bucketName: "discharge-pdfs",
    idGenerator: () => "test-discharge-id",
    now: () => fixedNow,
    s3Client: {
      send: async (command) => calls.push({ service: "s3", command }),
    },
    dynamoClient: {
      send: async (command) => calls.push({ service: "dynamodb", command }),
    },
  });

  const form = new FormData();
  form.append("transcript", "  Take medication with food.  ");
  form.append("pdfFile", new Blob(["%PDF test document"], { type: "application/pdf" }), "aftercare.pdf");
  const response = await fetch(`${url}/api/discharge`, { method: "POST", body: form });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    dischargeId: "test-discharge-id",
    patientLink: "/ptView.html?id=test-discharge-id",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].service, "s3");
  assert.equal(calls[0].command.input.Bucket, "discharge-pdfs");
  assert.equal(calls[0].command.input.Key, "discharges/test-discharge-id/aftercare.pdf");
  assert.equal(calls[0].command.input.ContentType, "application/pdf");
  assert.equal(calls[0].command.input.Body.toString(), "%PDF test document");
  assert.equal(calls[1].service, "dynamodb");
  assert.deepEqual(calls[1].command.input, {
    TableName: "Discharges",
    Item: {
      dischargeId: "test-discharge-id",
      createdAt: "2026-10-10T12:00:00.000Z",
      expiresAt: Math.floor(fixedNow / 1000) + 30 * 24 * 60 * 60,
      transcript: "Take medication with food.",
      pdfKey: "discharges/test-discharge-id/aftercare.pdf",
      pdfOriginalName: "aftercare.pdf",
    },
  });
});

test("saves a transcript and generates a patient link without requiring a PDF or S3", async () => {
  let saveCommand;
  const { url } = await startServer({
    tableName: "Discharges",
    idGenerator: () => "transcript-only-id",
    dynamoClient: {
      send: async (command) => {
        saveCommand = command;
      },
    },
    s3Client: { send: async () => assert.fail("Transcript-only submissions must not access S3.") },
  });
  const form = new FormData();
  form.append("transcript", "Drink plenty of fluids.");

  const response = await fetch(`${url}/api/discharge`, { method: "POST", body: form });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    dischargeId: "transcript-only-id",
    patientLink: "/ptView.html?id=transcript-only-id",
  });
  assert.equal(saveCommand.input.TableName, "Discharges");
  assert.equal(saveCommand.input.Item.transcript, "Drink plenty of fluids.");
  assert.equal("pdfKey" in saveCommand.input.Item, false);
});

test("fetches a discharge record and signs its PDF download URL", async () => {
  let readCommand;
  let signingCommand;
  let signingOptions;
  const { url } = await startServer({
    tableName: "Discharges",
    bucketName: "discharge-pdfs",
    now: () => Date.parse("2026-10-10T12:00:00.000Z"),
    dynamoClient: {
      send: async (command) => {
        readCommand = command;
        return {
          Item: {
            dischargeId: "patient-123",
            expiresAt: Math.floor(Date.parse("2026-10-10T12:00:00.000Z") / 1000) + 10,
            transcript: "Rest and drink water.",
            pdfKey: "discharges/patient-123/aftercare.pdf",
            pdfOriginalName: "aftercare.pdf",
          },
        };
      },
    },
    s3Client: { send: async () => assert.fail("GET should use a signed URL, not fetch the PDF.") },
    getSignedUrlImpl: async (client, command, options) => {
      assert.ok(client);
      signingCommand = command;
      signingOptions = options;
      return "https://signed.example/download";
    },
  });

  const response = await fetch(`${url}/api/discharge/patient-123`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    dischargeId: "patient-123",
    transcript: "Rest and drink water.",
    pdfUrl: "https://signed.example/download",
    pdfOriginalName: "aftercare.pdf",
  });
  assert.deepEqual(readCommand.input, {
    TableName: "Discharges",
    Key: { dischargeId: "patient-123" },
  });
  assert.deepEqual(signingCommand.input, {
    Bucket: "discharge-pdfs",
    Key: "discharges/patient-123/aftercare.pdf",
  });
  assert.deepEqual(signingOptions, { expiresIn: 3600 });
});

test("loads a transcript-only discharge without requiring S3", async () => {
  const { url } = await startServer({
    tableName: "Discharges",
    dynamoClient: {
      send: async () => ({
        Item: {
          dischargeId: "transcript-only-id",
          expiresAt: Math.floor(Date.now() / 1000) + 60,
          transcript: "Drink plenty of fluids.",
        },
      }),
    },
    s3Client: { send: async () => assert.fail("Transcript-only records must not access S3.") },
    getSignedUrlImpl: async () => assert.fail("Transcript-only records must not be signed."),
  });

  const response = await fetch(`${url}/api/discharge/transcript-only-id`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    dischargeId: "transcript-only-id",
    transcript: "Drink plenty of fluids.",
  });
});

test("does not serve missing or expired discharge records", async () => {
  const fixedNow = Date.parse("2026-10-10T12:00:00.000Z");
  let item;
  const { url } = await startServer({
    tableName: "Discharges",
    bucketName: "discharge-pdfs",
    now: () => fixedNow,
    dynamoClient: { send: async () => ({ Item: item }) },
    s3Client: { send: async () => assert.fail("Expired or missing record must not access S3.") },
    getSignedUrlImpl: async () => assert.fail("Expired or missing record must not be signed."),
  });

  const missing = await fetch(`${url}/api/discharge/missing`);
  assert.equal(missing.status, 404);
  item = { dischargeId: "expired", expiresAt: Math.floor(fixedNow / 1000) - 1 };
  const expired = await fetch(`${url}/api/discharge/expired`);
  assert.equal(expired.status, 404);
});

test("rejects discharge submissions with an empty transcript", async () => {
  const { url } = await startServer({
    tableName: "Discharges",
    bucketName: "discharge-pdfs",
    s3Client: { send: async () => assert.fail("Invalid submission must not upload.") },
    dynamoClient: { send: async () => assert.fail("Invalid submission must not persist.") },
  });
  const form = new FormData();
  form.append("transcript", " ");
  form.append("pdfFile", new Blob(["%PDF"], { type: "application/pdf" }), "missing.pdf");

  const response = await fetch(`${url}/api/discharge`, { method: "POST", body: form });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Provide a non-empty discharge transcript." });

});

test("reports missing DynamoDB configuration when creating or loading patient links", async () => {
  const { url } = await startServer({ tableName: "" });
  const form = new FormData();
  form.append("transcript", "Take medication with food.");
  const submitResponse = await fetch(`${url}/api/discharge`, { method: "POST", body: form });
  assert.equal(submitResponse.status, 503);
  assert.deepEqual(await submitResponse.json(), {
    error: "Discharge storage is not configured: set DYNAMODB_TABLE_NAME on the server.",
  });

  const response = await fetch(`${url}/api/discharge/unknown`);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Discharge storage is not configured: set DYNAMODB_TABLE_NAME on the server.",
  });
});

test("reports missing S3 configuration only when a PDF is attached", async () => {
  const { url } = await startServer({
    tableName: "Discharges",
    bucketName: "",
  });
  const form = new FormData();
  form.append("transcript", "Take medication with food.");
  form.append("pdfFile", new Blob(["%PDF"], { type: "application/pdf" }), "instructions.pdf");

  const response = await fetch(`${url}/api/discharge`, { method: "POST", body: form });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "PDF storage is not configured: set S3_BUCKET_NAME on the server.",
  });
});

test("generates speech through ElevenLabs and returns audio", async () => {
  let submittedUrl;
  let submittedOptions;
  const { url } = await startServer({
    apiKey: "test-api-key",
    voiceId: "test-voice",
    speechModelId: "eleven_multilingual_v2",
    fetchImpl: async (requestUrl, options) => {
      submittedUrl = requestUrl;
      submittedOptions = options;
      return new Response(Buffer.from("fake mp3"), {
        headers: { "Content-Type": "audio/mpeg" },
      });
    },
  });

  const response = await fetch(`${url}/api/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Please take your medicine with food." }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(await response.text(), "fake mp3");
  assert.equal(
    submittedUrl,
    "https://api.elevenlabs.io/v1/text-to-speech/test-voice?output_format=mp3_44100_128",
  );
  assert.equal(submittedOptions.headers["xi-api-key"], "test-api-key");
  assert.deepEqual(JSON.parse(submittedOptions.body), {
    text: "Please take your medicine with food.",
    model_id: "eleven_multilingual_v2",
  });
});

test("requires a configured ElevenLabs voice for speech generation", async () => {
  const { url } = await startServer({ apiKey: "test-api-key", voiceId: "" });
  const response = await fetch(`${url}/api/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Patient instructions." }),
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Speech generation is not configured on the server.",
  });
});

test("rejects empty or oversized speech text without contacting ElevenLabs", async () => {
  const { url } = await startServer({
    apiKey: "test-api-key",
    voiceId: "test-voice",
    fetchImpl: async () => {
      assert.fail("Provider must not be called for invalid text.");
    },
  });

  const emptyResponse = await fetch(`${url}/api/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "   " }),
  });
  assert.equal(emptyResponse.status, 400);

  const longResponse = await fetch(`${url}/api/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "a".repeat(5001) }),
  });
  assert.equal(longResponse.status, 413);
});

test("does not return provider error details to the caller", async () => {
  const { url } = await startServer({
    apiKey: "test-api-key",
    fetchImpl: async () => new Response("sensitive provider detail", { status: 401 }),
  });

  const response = await fetch(`${url}/api/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "audio/webm" },
    body: Buffer.from("fake audio"),
  });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "The speech transcription service rejected the audio.",
    providerStatus: 401,
  });
});
