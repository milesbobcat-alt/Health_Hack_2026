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
