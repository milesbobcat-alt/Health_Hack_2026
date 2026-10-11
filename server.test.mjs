import {ListLanguagesCommand, TranslateDocumentCommand} from "@aws-sdk/client-translate";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createAppServer, createHandler, handler } from "./index.mjs";

const runningServers = new Set();
const sampleChecklist = {
  medicine: ["Take medication with food."],
  woundCare: [],
  followUps: [],
  additional: ["Drink plenty of fluids."],
  contactPhysician: [],
};

function appendChecklist(form, checklist = sampleChecklist) {
  form.append("checklist", JSON.stringify(checklist));
}

async function startServer(options) {
  const server = createAppServer({
    logger: { info() {}, error() {} },
    ...options,
  });
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
  assert.match(response.body, /Add CarePack Instructions/);
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
  assert.match(page, /Add CarePack Instructions/);
  assert.match(page, /id="start-recording"/);
  assert.match(page, /\/api\/transcribe/);
  assert.match(page, /id="generate-checklist"/);
  assert.match(page, /id="checklist-review"/);
  assert.match(page, /Confirm &amp; Create Patient Link/);
});

test("serves the patient view page with read-aloud controls", async () => {
  const { url } = await startServer();
  const response = await fetch(`${url}/ptView.html`);

  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /class="patient-layout"/);
  assert.match(page, /Recovery checklist/);
  assert.match(page, /id="medicine-tab"/);
  assert.match(page, /id="woundCare-tab"/);
  assert.match(page, /id="followUps-tab"/);
  assert.match(page, /id="additional-tab"/);
  assert.doesNotMatch(page, /id="avs-transcript"/);
  assert.doesNotMatch(page, /Select a sentence to hear it read aloud or view a simpler explanation\./);
  assert.doesNotMatch(page, /Approved text is sent to ElevenLabs to generate audio\./);
  assert.doesNotMatch(page, /id="speech-approval"/);
  assert.match(page, /id="patient-data"/);
  assert.match(page, /Play Out Loud/);
  assert.match(page, /Stop reading/);
  assert.match(page, /id="pdf-link"/);
  assert.match(page, /class="button avs-document-link"/);
  assert.match(page, /\/api\/discharge\//);
  assert.match(page, /\/api\/speak/);
});

test("generates a flexible checklist from the transcript and extracted PDF text", async () => {
  let invokeCommand;
  const generatedChecklist = {
    medicine: ["Take the pill each morning."],
    woundCare: [],
    followUps: ["Call the clinic next week."],
    additional: [
      "Drink water.",
      "Walk each day.",
      "Keep the paper.",
      "Call if the clinic is closed.",
      "Bring the list to your visit.",
    ],
    contactPhysician: [],
  };
  const { url } = await startServer({
    bedrockModelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    pdfParser: async (buffer) => {
      assert.equal(buffer.toString(), "%PDF test document");
      return { text: "Call the clinic next week." };
    },
    bedrockClient: {
      messages: {
        create: async (params) => {
          invokeCommand = params;
          return {
            content: [{
              type: "tool_use",
              name: "return_discharge_checklist",
              input: generatedChecklist,
            }],
          };
        },
      },
    },
  });

  const form = new FormData();
  form.append("transcript", "Take the pill each morning.");
  form.append("pdfFile", new Blob(["%PDF test document"], { type: "application/pdf" }), "aftercare.pdf");
  const response = await fetch(`${url}/api/generate-checklist`, { method: "POST", body: form });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    checklist: {...generatedChecklist, medicine: [{name: null, strength: null, dose: null, frequency: null, instructions: "Take the pill each morning."}]},
    extractedDocText: "Call the clinic next week.",
  });
  assert.equal(invokeCommand.model, "anthropic.claude-3-5-sonnet-20241022-v2:0");
  assert.equal(invokeCommand.max_tokens, 8192);
  assert.deepEqual(invokeCommand.tool_choice, {
    type: "tool",
    name: "return_discharge_checklist",
  });
  assert.deepEqual(invokeCommand.tools[0].input_schema.required, [
    "medicine",
    "woundCare",
    "followUps",
    "additional",
    "contactPhysician",
    "medicationTransitions",
  ]);
  assert.match(invokeCommand.system, /ONLY use facts and directives explicitly stated/);
  assert.match(invokeCommand.messages[0].content, /Take the pill each morning/);
  assert.doesNotMatch(invokeCommand.messages[0].content, /Call the clinic next week/);
});

test("accepts valid checklist JSON wrapped in Markdown and explanatory text", async () => {
  const wrappedChecklist = `Here is the care plan:
\`\`\`json
{"medicine":[],"woundCare":["Keep the dressing clean."],"followUps":[],"additional":[]}
\`\`\``;
  const { url } = await startServer({
    bedrockModelId: "anthropic.claude-haiku-4-5",
    bedrockClient: {
      messages: {
        create: async () => ({
          stop_reason: "end_turn",
          content: [{ type: "text", text: wrappedChecklist }],
        }),
      },
    },
  });
  const form = new FormData();
  form.append("transcript", "Keep the dressing clean.");

  const response = await fetch(`${url}/api/generate-checklist`, { method: "POST", body: form });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).checklist, {
    medicine: [],
    woundCare: [{instructions: "Keep the dressing clean.", frequency: null}],
    followUps: [],
    additional: [], contactPhysician: [],
  });
});

test("rejects malformed Bedrock checklist output", async () => {
  const { url } = await startServer({
    awsRegion: "us-east-1",
    bedrockModelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    bedrockClient: {
      messages: {
        create: async () => ({
          stop_reason: "end_turn",
          content: [{ type: "text", text: '{"medicine":[],"woundCare":[]}' }],
        }),
      },
    },
  });
  const form = new FormData();
  form.append("transcript", "Rest today.");

  const response = await fetch(`${url}/api/generate-checklist`, { method: "POST", body: form });
  assert.equal(response.status, 502);
  const requestId = response.headers.get("x-request-id");
  const result = await response.json();
  assert.equal(result.error, "The care plan could not be generated. Please try again.");
  assert.deepEqual(result.diagnostic, {
    requestId,
    stage: "checklist validation",
    code: "InvalidChecklistResponse",
    message: "Model response omitted checklist arrays: followUps, additional.",
    contentBlockTypes: ["text"],
    stopReason: "end_turn",
    responseTextLength: '{"medicine":[],"woundCare":[]}'.length,
    region: "us-east-1",
    modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  });
});

test("reports malformed checklist structure without exposing model output", async () => {
  const privateOutput = "Patient-specific generated text must never be returned.";
  const { url } = await startServer({
    bedrockModelId: "anthropic.claude-haiku-4-5",
    bedrockClient: {
      messages: {
        create: async () => ({
          stop_reason: "max_tokens",
          content: [{ type: "text", text: privateOutput }],
        }),
      },
    },
  });
  const form = new FormData();
  form.append("transcript", "Source instructions.");

  const response = await fetch(`${url}/api/generate-checklist`, { method: "POST", body: form });
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.equal(result.diagnostic.code, "InvalidChecklistResponse");
  assert.match(result.diagnostic.message, /did not contain a JSON object/);
  assert.equal(result.diagnostic.stopReason, "max_tokens");
  assert.equal(result.diagnostic.responseTextLength, privateOutput.length);
  assert.doesNotMatch(JSON.stringify(result), /Patient-specific generated text/);
});

test("returns safe Bedrock error details and supports configuring an inference profile", async () => {
  let requestedModelId;
  const logEntries = [];
  const { url } = await startServer({
    awsRegion: "us-west-2",
    bedrockModelId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    logger: {
      info: (message) => logEntries.push(JSON.parse(message)),
      error: (...details) => logEntries.push({ event: "error", details }),
    },
    bedrockClient: {
      messages: {
        create: async (params) => {
          requestedModelId = params.model;
          const error = new Error("Model access is denied for this account.");
          error.name = "AccessDeniedException";
          error.requestID = "bedrock-request-123";
          error.status = 403;
          error.type = "permission_error";
          throw error;
        },
      },
    },
  });
  const form = new FormData();
  form.append("transcript", "Private transcript must not be in diagnostics.");

  const response = await fetch(`${url}/api/generate-checklist`, { method: "POST", body: form });
  assert.equal(response.status, 502);
  const requestId = response.headers.get("x-request-id");
  const result = await response.json();
  assert.deepEqual(result, {
    error: "The care plan could not be generated. Please try again.",
    diagnostic: {
      requestId,
      stage: "Bedrock invocation",
      code: "AccessDeniedException",
      message: "Model access is denied for this account.",
      region: "us-west-2",
      modelId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      providerRequestId: "bedrock-request-123",
      providerStatus: 403,
      providerErrorType: "permission_error",
    },
  });
  assert.equal(requestedModelId, "us.anthropic.claude-3-5-sonnet-20241022-v2:0");
  assert.doesNotMatch(JSON.stringify(result), /Private transcript/);
  assert.deepEqual(logEntries.map(({ event }) => event), [
    "http_request_started",
    "error",
    "http_request_completed",
  ]);
  assert.ok(logEntries.every((entry) => !JSON.stringify(entry).includes("Private transcript")));
});

test("keeps the fixed-prompt Bedrock diagnostic disabled unless explicitly enabled", async () => {
  const { url } = await startServer({
    bedrockClient: {
      messages: {
        create: async () => assert.fail("Disabled diagnostic must not call Bedrock."),
      },
    },
  });

  const response = await fetch(`${url}/api/bedrock-diagnostic`, { method: "POST" });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found." });
});

test("reports missing Mantle model configuration without calling the model", async () => {
  const { url } = await startServer({
    bedrockModelId: "",
    bedrockDiagnosticsEnabled: true,
    bedrockClient: {
      messages: {
        create: async () => assert.fail("Missing model ID must not call Bedrock Mantle."),
      },
    },
  });

  const response = await fetch(`${url}/api/bedrock-diagnostic`, { method: "POST" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Bedrock is not configured: set BEDROCK_MODEL_ID on the server.",
  });
});

test("smoke-tests the configured Bedrock model without patient data", async () => {
  let commandInput;
  const { url } = await startServer({
    awsRegion: "us-west-2",
    bedrockModelId: "us.anthropic.claude-sonnet-4-6",
    bedrockDiagnosticsEnabled: true,
    bedrockClient: {
      messages: {
        create: async (params) => {
          commandInput = params;
          return {
            _request_id: "bedrock-smoke-test-id",
            content: [{ type: "text", text: "OK" }],
          };
        },
      },
    },
  });

  const response = await fetch(`${url}/api/bedrock-diagnostic`, { method: "POST" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, {
    ok: true,
    requestId: response.headers.get("x-request-id"),
    region: "us-west-2",
    modelId: "us.anthropic.claude-sonnet-4-6",
    providerRequestId: "bedrock-smoke-test-id",
  });
  assert.equal(commandInput.model, "us.anthropic.claude-sonnet-4-6");
  assert.equal(commandInput.max_tokens, 16);
  assert.deepEqual(commandInput.messages, [{
    role: "user",
    content: "Reply with exactly the word OK.",
  }]);
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
  appendChecklist(form);
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
      checklist: sampleChecklist,
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
  appendChecklist(form);

  const response = await fetch(`${url}/api/discharge`, { method: "POST", body: form });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    dischargeId: "transcript-only-id",
    patientLink: "/ptView.html?id=transcript-only-id",
  });
  assert.equal(saveCommand.input.TableName, "Discharges");
  assert.equal(saveCommand.input.Item.transcript, "Drink plenty of fluids.");
  assert.deepEqual(saveCommand.input.Item.checklist, sampleChecklist);
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
    checklist: { medicine: [], woundCare: [], followUps: [], additional: [], contactPhysician: [] },
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
    checklist: { medicine: [], woundCare: [], followUps: [], additional: [], contactPhysician: [] },
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
  appendChecklist(form);


  const response = await fetch(`${url}/api/discharge`, { method: "POST", body: form });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Provide a discharge transcript or a text-based PDF." });

});

test("reports missing DynamoDB configuration when creating or loading patient links", async () => {
  const { url } = await startServer({ tableName: "" });
  const form = new FormData();
  form.append("transcript", "Take medication with food.");
  appendChecklist(form);
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
  appendChecklist(form);
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

const structuredMedicine = {name: "Aspirin", strength: "81 mg per tablet", dose: "1 tablet", frequency: "once daily", instructions: "As needed for pain"};
const structuredPlan = {medicine: [structuredMedicine], woundCare: [], followUps: [], additional: [], contactPhysician: []};
test("PDF-only generation sends extracted text and structured medication schema to Bedrock", async () => {
  const {url} = await startServer({bedrockModelId: "mock", pdfParser: async () => ({text: "Aspirin 81 mg, one tablet daily as needed for pain."}),
    bedrockClient: {messages: {create: async params => {
      assert.match(params.messages[0].content, /Aspirin 81 mg/);
      assert.equal(params.tools[0].input_schema.properties.medicine.items.type, "object");
      assert.match(params.system, /REVIEW REQUIRED/);
      assert.match(params.system, /Never derive strength from dose/);
      return {content: [{type: "tool_use", name: "return_discharge_checklist", input: structuredPlan}]};
    }}}});
  const form = new FormData(); form.append("pdfFile", new Blob(["pdf"], {type: "application/pdf"}), "discharge.pdf");
  const response = await fetch(`${url}/api/generate-checklist`, {method: "POST", body: form});
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).checklist, structuredPlan);
});
test("empty and unreadable PDFs never invoke Bedrock, even with a transcript", async () => {
  for (const pdfParser of [async () => ({text: "  "}), async () => {throw new Error("invalid PDF");}]) {
    const {url} = await startServer({bedrockModelId: "mock", pdfParser, bedrockClient: {messages: {create: async () => assert.fail("Must not call AI")}}});
    const form = new FormData(); form.append("transcript", "Nurse notes"); form.append("pdfFile", new Blob(["bad"], {type: "application/pdf"}), "discharge.pdf");
    const response = await fetch(`${url}/api/generate-checklist`, {method: "POST", body: form});
    assert.equal(response.status, 400); assert.match((await response.json()).error, /no readable text|could not be read/);
  }
});
test("structured medicine nulls and conflict wording survive save and retrieval", async () => {
  const medicine = {...structuredMedicine, dose: null, frequency: null, instructions: "REVIEW REQUIRED: conflicting instructions: PDF says once daily; nurse says twice daily"};
  const plan = {...structuredPlan, medicine: [medicine]}; let record;
  const {url} = await startServer({tableName: "mock", dynamoClient: {send: async command => {
    if (command.input.Item) {record = command.input.Item; return {};}
    return {Item: record};
  }}});
  const form = new FormData(); form.append("transcript", "Nurse notes"); form.append("checklist", JSON.stringify(plan));
  const saved = await fetch(`${url}/api/discharge`, {method: "POST", body: form}); assert.equal(saved.status, 201);
  const {dischargeId} = await saved.json();
  const response = await fetch(`${url}/api/discharge/${dischargeId}`); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).checklist, plan);
});
test("invalid medication field types are rejected before persistence", async () => {
  const {url} = await startServer({tableName: "mock", dynamoClient: {send: async () => assert.fail("Must not save")}});
  const form = new FormData(); form.append("transcript", "Notes");
  form.append("checklist", JSON.stringify({...structuredPlan, medicine: [{...structuredMedicine, dose: 2}]}));
  assert.equal((await fetch(`${url}/api/discharge`, {method: "POST", body: form})).status, 400);
});
test("old saved medicine strings remain readable without inventing structured values", async () => {
  const {url} = await startServer({tableName: "mock", dynamoClient: {send: async () => ({Item: {dischargeId: "legacy", expiresAt: Math.floor(Date.now()/1000)+3600, transcript: "Notes", checklist: sampleChecklist}})}});
  const response = await fetch(`${url}/api/discharge/legacy`); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).checklist, sampleChecklist);
});

test("structured wound care and warning urgency survive generation, saving, and retrieval", async () => {
 const plan = {...structuredPlan, woundCare: [{instructions: "Change the dressing", frequency: "once daily"}, {instructions: "Keep wound dry", frequency: null}], contactPhysician: ["Call your physician immediately if your legs swell.", "Call 911 for severe trouble breathing."]};
 let record;
 const {url} = await startServer({tableName: "mock", bedrockModelId: "mock", bedrockClient: {messages: {create: async params => {
   assert.match(params.system, /Never downgrade an emergency/); assert.match(params.system, /Never invent warning signs/);
   assert.equal(params.tools[0].input_schema.properties.woundCare.items.type, "object");
   assert.ok(params.tools[0].input_schema.required.includes("contactPhysician"));
   return {content: [{type: "tool_use", name: "return_discharge_checklist", input: plan}]};
 }}}, dynamoClient: {send: async command => {if (command.input.Item) {record=command.input.Item;return {};}return {Item: record};}}});
 const source = new FormData();source.append("transcript", "Documented warnings and wound instructions");
 const generated=await fetch(`${url}/api/generate-checklist`,{method:"POST",body:source});assert.equal(generated.status,200);assert.deepEqual((await generated.json()).checklist,plan);
 const form = new FormData();form.append("transcript","Notes");form.append("checklist",JSON.stringify(plan));
 const saved=await fetch(`${url}/api/discharge`,{method:"POST",body:form});assert.equal(saved.status,201);
 const {dischargeId}=await saved.json();const loaded=await fetch(`${url}/api/discharge/${dischargeId}`);assert.deepEqual((await loaded.json()).checklist,plan);
});
test("legacy plans gain an empty warning category without reclassifying old instructions", async () => {
 const legacy={medicine:[],woundCare:["Change bandage daily"],followUps:[],additional:["Call clinic for swelling"]};
 const {url}=await startServer({tableName:"mock",dynamoClient:{send:async()=>({Item:{expiresAt:Math.floor(Date.now()/1000)+3600,checklist:legacy}})}});
 const response=await fetch(`${url}/api/discharge/legacy-wound`);assert.equal(response.status,200);
 assert.deepEqual((await response.json()).checklist,{...legacy,contactPhysician:[]});
});
test("invalid wound frequency and warning values cannot be saved", async () => {
 const {url}=await startServer({tableName:"mock",dynamoClient:{send:async()=>assert.fail("Must not save")}});
 for (const plan of [{...structuredPlan,woundCare:[{instructions:"Change dressing",frequency:3}]},{...structuredPlan,contactPhysician:[{instructions:"Warning"}]}]) {
 const form=new FormData();form.append("transcript","Notes");form.append("checklist",JSON.stringify(plan));
 assert.equal((await fetch(`${url}/api/discharge`,{method:"POST",body:form})).status,400);
 }
});

test("combined transcript/PDF instructions reach Bedrock and survive response validation", async () => {
 const {renderPatientCategory} = await import("./patient-render-test-helper.mjs");
 const plan={medicine:[],woundCare:[{instructions:"Clean the incision",frequency:"daily"}],followUps:["Call the clinic Monday"],additional:[],contactPhysician:[]};
 let calls=0;
 const {url}=await startServer({bedrockModelId:"mock", pdfParser:async buffer=>{assert.equal(buffer.toString(),"synthetic PDF");return {text:"Clean the incision daily"};},
 bedrockClient:{messages:{create:async params=>{
 calls++;
 const isPdf = params.messages[0].content.includes("Clean the incision daily");
 assert.equal(params.messages[0].content.includes("Call the clinic Monday"), !isPdf);
 assert.match(params.system,/A transcript is supplemental; it does not replace the PDF/);assert.match(params.system,/Neither source automatically overrides/);
 return {content:[{type:"tool_use",name:"return_discharge_checklist",input:{...plan,woundCare:isPdf ? plan.woundCare : [],followUps:isPdf ? [] : plan.followUps}}]};
 }}}});
 const form=new FormData();form.append("transcript","Call the clinic Monday");form.append("pdfFile",new Blob(["synthetic PDF"],{type:"application/pdf"}),"instructions.pdf");
 const response=await fetch(`${url}/api/generate-checklist`,{method:"POST",body:form});assert.equal(response.status,200);
 const result=await response.json();assert.deepEqual(result.checklist,plan);assert.equal(calls,2);
 assert.match(renderPatientCategory(result.checklist,"woundCare"),/Clean the incision.*daily/);
 assert.match(renderPatientCategory(result.checklist,"followUps"),/Call the clinic Monday/);
});
test("source parser exceptions are logged without source content", async () => {
 const logs=[];const {url}=await startServer({logger:{info(){},error:(...args)=>logs.push(args)},bedrockModelId:"mock",pdfParser:async()=>{throw new Error("PRIVATE SOURCE CONTENT");},bedrockClient:{messages:{create:async()=>assert.fail("Must not call AI")}}});
 const form=new FormData();form.append("transcript","PRIVATE TRANSCRIPT");form.append("pdfFile",new Blob(["bad"],{type:"application/pdf"}),"instructions.pdf");
 assert.equal((await fetch(`${url}/api/generate-checklist`,{method:"POST",body:form})).status,400);
 assert.doesNotMatch(JSON.stringify(logs),/PRIVATE SOURCE|PRIVATE TRANSCRIPT/);
});

test("numbered example headings do not reject an uploaded PDF", async () => {
 let calls=0;
 const {url}=await startServer({bedrockModelId:"mock",pdfParser:async()=>({text:"Example 1 — First case\nExample 2 — Next heading"}),bedrockClient:{messages:{create:async()=>{calls++;return {content:[{type:"tool_use",name:"return_discharge_checklist",input:structuredPlan}]};}}}});
 const form=new FormData();form.append("pdfFile",new Blob(["pdf"],{type:"application/pdf"}),"cases.pdf");
 const response=await fetch(`${url}/api/generate-checklist`,{method:"POST",body:form});assert.equal(response.status,200);assert.equal(calls,1);
});
test("an empty PDF model result cannot silently produce a transcript-only plan", async () => {
 const {url}=await startServer({bedrockModelId:"mock",pdfParser:async()=>({text:"Clean incision daily"}),bedrockClient:{messages:{create:async()=>({content:[{type:"tool_use",name:"return_discharge_checklist",input:{medicine:[],woundCare:[],followUps:[],additional:[],contactPhysician:[]}}]})}}});
 const form=new FormData();form.append("transcript","take aspirin as needed");form.append("pdfFile",new Blob(["pdf"],{type:"application/pdf"}),"case.pdf");
 const response=await fetch(`${url}/api/generate-checklist`,{method:"POST",body:form});assert.equal(response.status,422);const result=await response.json();assert.equal("checklist" in result,false);assert.match(result.error,/PDF.*no partial plan/);
});

test("selected-patient FHIR baseline and AI transitions survive generation/save/retrieval", async () => {
 const transitions={before:[],continue:[],begin:[{name:"Atorvastatin",formulation:null,strength:"40 mg",dose:"1 tablet",frequency:"daily",instructions:null}],stop:[]};
 const plan={...structuredPlan,medicationTransitions:transitions};let stored;let fhirCalls=0;
 const {url}=await startServer({fhirBaseUrl:"https://fhir.example/r4",tableName:"mock",bedrockModelId:"mock",
 fhirFetchImpl:async request=>{fhirCalls++;const type=String(request).includes('MedicationStatement') ? 'MedicationStatement' : 'MedicationRequest';return Response.json({resourceType:"Bundle",type:"searchset",entry:type==='MedicationStatement' ? [{resource:{resourceType:type,id:"m1",subject:{reference:"Patient/omar"},medicationCodeableConcept:{text:"Atorvastatin"},dosage:[{text:"one tablet twice weekly",doseAndRate:[{doseQuantity:{value:1,unit:"tablet"}}]}]}}] : []});},
 bedrockClient:{messages:{create:async params=>{assert.doesNotMatch(params.messages[0].content,/one tablet twice weekly/);assert.match(params.system,/Never copy the same milligram amount/);return {content:[{type:"tool_use",name:"return_discharge_checklist",input:plan}]};}}},
 dynamoClient:{send:async command=>{if(command.input.Item){stored=command.input.Item;return {};}return {Item:stored};}}});
 const form=new FormData();form.append("transcript","Begin atorvastatin 40 mg tablets, one daily");form.append("patientContext",JSON.stringify({id:"omar",server:"https://fhir.example/r4"}));
 const response=await fetch(`${url}/api/generate-checklist`,{method:"POST",body:form});assert.equal(response.status,200);const result=await response.json();
 assert.equal(fhirCalls,2);assert.equal(result.medicationComparison.patient.id,"omar");assert.equal(result.medicationComparison.baseline.length,1);assert.equal(result.medicationComparison.baseline[0].dose,"1 tablet");assert.deepEqual(result.medicationComparison.groups.begin[0].sources,["Transcript"]);
 const save=new FormData();save.append("transcript","Notes");save.append("checklist",JSON.stringify(result.checklist));save.append("medicationComparison",JSON.stringify(result.medicationComparison));
 const saved=await fetch(`${url}/api/discharge`,{method:"POST",body:save});assert.equal(saved.status,201);const {dischargeId}=await saved.json();
 const loaded=await fetch(`${url}/api/discharge/${dischargeId}`);assert.equal(loaded.status,200);assert.deepEqual((await loaded.json()).medicationComparison,result.medicationComparison);
});
test("comparison rejects arbitrary FHIR identity before AI or upstream requests", async () => {
 const {url}=await startServer({bedrockModelId:"mock",fhirFetchImpl:async()=>assert.fail("No upstream"),bedrockClient:{messages:{create:async()=>assert.fail("No AI")}}});
 const form=new FormData();form.append("transcript","Notes");form.append("patientContext",JSON.stringify({id:"omar",server:"https://arbitrary.example"}));
 assert.equal((await fetch(`${url}/api/generate-checklist`,{method:"POST",body:form})).status,400);
});
test("same mass amount cannot appear as both strength and unit-count dose in model result", async () => {
 const plan={...structuredPlan,medicine:[{...structuredMedicine,strength:"40 mg",dose:"40 mg"}]};
 const {url}=await startServer({bedrockModelId:"mock",bedrockClient:{messages:{create:async()=>({content:[{type:"tool_use",name:"return_discharge_checklist",input:plan}]})}}});
 const form=new FormData();form.append("transcript","Example medication 40 mg");const response=await fetch(`${url}/api/generate-checklist`,{method:"POST",body:form});assert.equal(response.status,200);
 const result=await response.json();assert.equal(result.checklist.medicine[0].dose,null);assert.match(result.checklist.medicine[0].instructions,/Documented total amount: 40 mg/);
});
test("FHIR failure remains visible as incomplete history, without inventing before medicines", async () => {
 const transitions={before:[],continue:[],begin:[{name:"Aspirin",formulation:null,strength:null,dose:null,frequency:null,instructions:"As needed"}],stop:[]};
 const {url}=await startServer({fhirBaseUrl:"https://fhir.example/r4",bedrockModelId:"mock",fhirFetchImpl:async()=>{throw new Error("unavailable");},bedrockClient:{messages:{create:async()=>({content:[{type:"tool_use",name:"return_discharge_checklist",input:{...structuredPlan,medicationTransitions:transitions}}]})}}});
 const form=new FormData();form.append("transcript","Begin aspirin as needed");form.append("patientContext",JSON.stringify({id:"omar",server:"https://fhir.example/r4"}));const response=await fetch(`${url}/api/generate-checklist`,{method:"POST",body:form});assert.equal(response.status,200);
 const result=await response.json();assert.deepEqual(result.medicationComparison.baseline,[]);assert.equal(result.medicationComparison.warnings.length,2);
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
    SourceLanguageCode: "en",
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

test("returns a safe AWS Translate diagnostic and logs no document content on failure", async () => {
  const errors = [];
  const { url } = await startServer({
    awsRegion: "us-west-2",
    logger: { info() {}, error: (entry) => errors.push(entry) },
    translateClient: {
      send: async (command) => {
        if (command instanceof ListLanguagesCommand) {
          return { Languages: [{ LanguageCode: "es", LanguageName: "Spanish" }] };
        }
        const error = new Error("Source document text must not be logged.");
        error.name = "AccessDeniedException";
        error.$metadata = { requestId: "aws-request-123", httpStatusCode: 403 };
        throw error;
      },
    },
  });
  const privateDocumentText = "Private patient discharge instruction";
  const response = await fetch(`${url}/api/translate`, {
    method: "POST",
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Target-Language": "es",
    },
    body: `<html><body>${privateDocumentText}</body></html>`,
  });

  assert.equal(response.status, 502);
  const result = await response.json();
  assert.deepEqual(result.diagnostic, {
    requestId: response.headers.get("x-request-id"),
    code: "AccessDeniedException",
    region: "us-west-2",
  });
  assert.match(result.error, /AWS Translate could not translate/);
  assert.doesNotMatch(JSON.stringify(result), /Private patient discharge instruction/);
  assert.doesNotMatch(errors.join("\n"), /Private patient discharge instruction|Source document text/);
  assert.match(errors.join("\n"), /aws_translate_document_failed/);
  assert.match(errors.join("\n"), /AccessDeniedException/);
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


test("translation is patient-only and preserves structured patient modules", async () => {
  const {url} = await startServer();
  const nurse = await (await fetch(url)).text();
  const patient = await (await fetch(`${url}/ptView.html`)).text();
  const script = await (await fetch(`${url}/translate.js`)).text();
  assert.doesNotMatch(nurse, /src="\/translate.js/);
  assert.match(patient, /src="\/translate.js/);
  assert.match(patient, /data-translate-value/);
  assert.match(patient, /patient-content-updated/);
  assert.match(patient, />CarePack<\/a>/);
  assert.doesNotMatch(patient, /<nav class="patient-nav"|renderComparison|comparisonReadAloud|id="medication-comparison"/);
  assert.match(script, /createHTMLDocument/);
  assert.doesNotMatch(script, /innerHTML\s*=/);
});

test("translation language-list failures retry without retaining failed cache", async () => {
  let calls=0;
  const {url} = await startServer({logger:{info(){},error(){}},translateClient:{send:async()=>{
    if (++calls===1) throw Object.assign(new Error('private'),{name:'AccessDeniedException'});
    return {Languages:[{LanguageCode:'es',LanguageName:'Spanish'}]};
  }}});
  assert.equal((await fetch(`${url}/api/translate/languages`)).status,502);
  assert.equal((await fetch(`${url}/api/translate/languages`)).status,200);
  assert.equal(calls,2);
});

test("translation timeout aborts upstream and returns an understandable error", async () => {
  const {url} = await startServer({translationTimeoutMs:10,logger:{info(){},error(){}},translateClient:{send:async(command,{abortSignal})=>{
    if(command instanceof ListLanguagesCommand)return {Languages:[{LanguageCode:'es',LanguageName:'Spanish'}]};
    return new Promise((resolve,reject)=>abortSignal.addEventListener('abort',()=>reject(abortSignal.reason),{once:true}));
  }}});
  const response=await fetch(`${url}/api/translate`,{method:'POST',headers:{'Content-Type':'text/html','X-Target-Language':'es'},body:'<p>Hello</p>'});
  assert.equal(response.status,502);
  assert.match((await response.json()).error,/AWS Translate could not translate/);
});
