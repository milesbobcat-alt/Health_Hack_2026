import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createAppServer } from "./server.mjs";

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
});

test("serves the patient view page with read-aloud controls", async () => {
  const { url } = await startServer();
  const response = await fetch(`${url}/ptView.html`);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /id="patient-data"/);
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

test("serves the recovery plan page", async () => {
  const { url } = await startServer({ apiKey: "test-api-key" });
  const response = await fetch(`${url}/recoveryPlan.html`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.match(await response.text(), /Your recovery plan/);
});

test("returns the example recovery plan as JSON", async () => {
  const { url } = await startServer();
  const response = await fetch(`${url}/api/recovery-plan`);

  assert.equal(response.status, 200);
  const plan = await response.json();
  assert.equal(plan.checkIn.medications[0].label, "Furosemide 40 mg");
  assert.ok(plan.followUp.tasks.length > 0);
  assert.ok(plan.medications.list.length > 0);
  for (const medication of plan.medications.list) {
    assert.equal(typeof medication.schedule.dose, "string", `${medication.name} needs a dose`);
    assert.equal(typeof medication.schedule.frequency, "string", `${medication.name} needs a frequency`);
  }
});

test("reports an error when the recovery plan cannot be read", async () => {
  const { url } = await startServer({ recoveryPlanPath: "/nonexistent/plan.json" });
  const response = await fetch(`${url}/api/recovery-plan`);

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "The recovery plan could not be loaded." });
});

test("rejects non-GET recovery plan requests", async () => {
  const { url } = await startServer();
  const response = await fetch(`${url}/api/recovery-plan`, { method: "POST" });

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});
