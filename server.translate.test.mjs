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

test("returns all paginated AWS Translate languages", async () => {
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

  const response = await fetch(`${url}/api/languages`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    sourceLanguageCode: "en",
    languages: [
      { code: "en", name: "English" },
      { code: "fr", name: "French" },
      { code: "es", name: "Spanish" },
    ],
  });
  assert.equal(commands.length, 2);
  assert.ok(commands.every((command) => command instanceof ListLanguagesCommand));
  assert.equal(commands[1].input.NextToken, "page-two");
});

test("both pages expose full-page translation controls and load the shared script", async () => {
  const { url } = await startServer({ send: async () => ({ Languages: [] }) });
  for (const pageName of ["ptView.html", "nurseIntake.html"]) {
    const response = await fetch(`${url}/${pageName}`);
    const page = await response.text();
    assert.equal(response.status, 200);
    assert.match(page, /id="page-language"/);
    assert.match(page, /id="page-translation-approval"/);
    assert.match(page, /id="translate-page"/);
    assert.match(page, /src="\/page-translation.js"/);
  }
  const scriptResponse = await fetch(`${url}/page-translation.js`);
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get("content-type"), /javascript/);
});

test("translates a rendered patient page as HTML and returns the translated document", async () => {
  let translateCommand;
  const { url } = await startServer({
    send: async (command) => {
      if (command instanceof ListLanguagesCommand) {
        return { Languages: [{ LanguageCode: "es", LanguageName: "Spanish" }] };
      }
      translateCommand = command;
      return {
        TranslatedDocument: {
          Content: new TextEncoder().encode("<html lang=\"es\"><body><h1>Instrucciones</h1></body></html>"),
        },
      };
    },
  });

  const response = await fetch(`${url}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pageName: "ptView.html",
      html: "<html lang=\"en\"><body><h1 id=\"page-translation-0\">Discharge instructions</h1></body></html>",
      targetLanguageCode: "es",
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    targetLanguageCode: "es",
    targetLanguageName: "Spanish",
    translatedHtml: "<html lang=\"es\"><body><h1>Instrucciones</h1></body></html>",
  });
  assert.ok(translateCommand instanceof TranslateDocumentCommand);
  assert.equal(translateCommand.input.SourceLanguageCode, "en");
  assert.equal(translateCommand.input.TargetLanguageCode, "es");
  assert.equal(translateCommand.input.Document.ContentType, "text/html");
  assert.equal(
    Buffer.from(translateCommand.input.Document.Content).toString("utf8"),
    "<html lang=\"en\"><body><h1 id=\"page-translation-0\">Discharge instructions</h1></body></html>",
  );
});

test("rejects unsupported pages and target languages", async () => {
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

  const unsupportedPage = await fetch(`${url}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pageName: "../server.mjs",
      html: "<html><body>Test</body></html>",
      targetLanguageCode: "es",
    }),
  });
  assert.equal(unsupportedPage.status, 400);

  const unsupportedLanguage = await fetch(`${url}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pageName: "nurseIntake.html",
      html: "<html><body>Hello.</body></html>",
      targetLanguageCode: "xx",
    }),
  });
  assert.equal(unsupportedLanguage.status, 400);
  assert.equal(translationCalled, false);
});

test("rejects page HTML over the TranslateDocument 100,000-byte limit", async () => {
  let awsCalled = false;
  const { url } = await startServer({
    send: async () => {
      awsCalled = true;
      return { Languages: [{ LanguageCode: "es", LanguageName: "Spanish" }] };
    },
  });

  const response = await fetch(`${url}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pageName: "ptView.html",
      html: `<html><body>${"x".repeat(100_001)}</body></html>`,
      targetLanguageCode: "es",
    }),
  });

  assert.equal(response.status, 413);
  assert.equal(awsCalled, false);
});
