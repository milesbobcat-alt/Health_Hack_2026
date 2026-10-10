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

test("creates and updates a patient checklist through the API", async () => {
  const { url } = await startServer();
  const created = await fetch(`${url}/api/checklists`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: ["Walk with help"], email: "demo@example.com", consent: true }),
  });
  assert.equal(created.status, 201);
  const plan = await created.json();
  assert.equal(plan.items[0].text, "Walk with help");
  assert.equal(plan.delivery[0].status, "demo only");
  const patient = await fetch(`${url}/patient/${plan.id}`);
  assert.equal(patient.status, 200);
  assert.match(await patient.text(), /Care checklist/);
  const updated = await fetch(`${url}/api/checklists/${plan.id}/items`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ index: 0, done: true }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).items[0].done, true);
});

test("serves the PDF and paste intake workflow without transcription services", async () => {
  const { url } = await startServer();
  const response = await fetch(url);

  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /Upload a PDF/);
  assert.match(page, /Copy and paste/);
  assert.doesNotMatch(page, /Record audio|transcrib|ElevenLabs/i);
});

test("extracts PDF text through the local server", async () => {
  const { url } = await startServer();
  const stream = "BT /F1 12 Tf 72 720 Td (Discharge Instructions) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(source.length); source += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = source.length;
  source += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const pdf = Buffer.from(source);
  const response = await fetch(`${url}/api/extract-pdf`, {
    method: "POST", headers: { "Content-Type": "application/pdf" }, body: pdf,
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.pages, 1);
  assert.match(result.text, /Discharge Instructions/);
});
