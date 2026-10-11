import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  ListLanguagesCommand,
  TranslateDocumentCommand,
} from "@aws-sdk/client-translate";
import { createAppServer } from "./server.mjs";

const runningServers = new Set();

async function startServer(translateClient) {
  const server = createAppServer({ translateClient });
  runningServers.add(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

afterEach(async () => {
  await Promise.all([...runningServers].map((server) => new Promise((resolve, reject) => {
    server.close((error) => {
      runningServers.delete(server);
      if (error) reject(error);
      else resolve();
    });
  })));
});

test("returns paginated AWS Translate target languages, excluding English source", async () => {
  const commands = [];
  const { url } = await startServer({
    send: async (command) => {
      commands.push(command);
      if (commands.length === 1) {
        return {
          Languages: [
            { LanguageCode: "en", LanguageName: "English" },
            { LanguageCode: "fr", LanguageName: "French" },
          ],
          NextToken: "page-two",
        };
      }
      return {
        Languages: [
          { LanguageCode: "es", LanguageName: "Spanish" },
        ],
      };
    },
  });

  const response = await fetch(`${url}/api/translate/languages`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    sourceLanguageCode: "en",
    languages: [
      { code: "fr", name: "French" },
      { code: "es", name: "Spanish" },
    ],
  });
  assert.equal(commands.length, 2);
  assert.ok(commands.every((command) => command instanceof ListLanguagesCommand));
  assert.equal(commands[1].input.NextToken, "page-two");
});

test("patient page exposes language selection, approval, and translated text output", async () => {
  const { url } = await startServer({ send: async () => ({ Languages: [] }) });
  const response = await fetch(`${url}/ptView.html`);
  const page = await response.text();

  assert.equal(response.status, 200);
  assert.match(page, /id="target-language"/);
  assert.match(page, /id="translation-approval"/);
  assert.match(page, /id="translate-document"/);
  assert.match(page, /id="translated-text"/);
  assert.match(page, /\/api\/translate\/document/);
});

test("translates English text with TranslateDocument and returns decoded text", async () => {
  let translateCommand;
  const { url } = await startServer({
    send: async (command) => {
      if (command instanceof ListLanguagesCommand) {
        return { Languages: [{ LanguageCode: "es", LanguageName: "Spanish" }] };
      }
      translateCommand = command;
      return {
        TranslatedDocument: {
          Content: new TextEncoder().encode("Tome el medicamento con comida."),
        },
      };
    },
  });

  const response = await fetch(`${url}/api/translate/document`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "Take the medicine with food.",
      targetLanguageCode: "es",
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    sourceLanguageCode: "en",
    targetLanguageCode: "es",
    targetLanguageName: "Spanish",
    translatedText: "Tome el medicamento con comida.",
  });
  assert.ok(translateCommand instanceof TranslateDocumentCommand);
  assert.equal(translateCommand.input.SourceLanguageCode, "en");
  assert.equal(translateCommand.input.TargetLanguageCode, "es");
  assert.equal(translateCommand.input.Document.ContentType, "text/plain");
  assert.equal(
    Buffer.from(translateCommand.input.Document.Content).toString("utf8"),
    "Take the medicine with food.",
  );
});

test("rejects empty text and unsupported target languages", async () => {
  let translationCalled = false;
  const { url } = await startServer({
    send: async (command) => {
      if (command instanceof ListLanguagesCommand) {
        return { Languages: [{ LanguageCode: "es", LanguageName: "Spanish" }] };
      }
      translationCalled = true;
      return { TranslatedDocument: { Content: new Uint8Array() } };
    },
  });

  const emptyResponse = await fetch(`${url}/api/translate/document`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "  ", targetLanguageCode: "es" }),
  });
  assert.equal(emptyResponse.status, 400);

  const unsupportedResponse = await fetch(`${url}/api/translate/document`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Hello.", targetLanguageCode: "xx" }),
  });
  assert.equal(unsupportedResponse.status, 400);
  assert.equal(translationCalled, false);
});

test("rejects text over the TranslateDocument 100,000-byte limit", async () => {
  let awsCalled = false;
  const { url } = await startServer({
    send: async () => {
      awsCalled = true;
      return { Languages: [{ LanguageCode: "es", LanguageName: "Spanish" }] };
    },
  });

  const response = await fetch(`${url}/api/translate/document`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "x".repeat(100_001), targetLanguageCode: "es" }),
  });

  assert.equal(response.status, 413);
  assert.equal(awsCalled, false);
});
