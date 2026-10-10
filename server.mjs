import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createChecklistStore, createReminderSender } from "./checklists.mjs";

const projectDirectory = import.meta.dirname;
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

export function createAppServer({
  fetchImpl = fetch,
  checklistStore = createChecklistStore({ send: createReminderSender({ fetchImpl }) }),
} = {}) {
  const baseUrl = process.env.PUBLIC_BASE_URL || `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3000}`;
  const reminderTimer = setInterval(() => { void checklistStore.dispatchDue(baseUrl); }, 60_000);
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


    async function readJson() {
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 30000) throw new Error("Request is too large.");
      }
      try { return JSON.parse(raw); } catch { throw new Error("Invalid JSON."); }
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
        const plan = checklistStore.create(await readJson());
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
          const { index, done } = await readJson();
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

    sendJson(response, 404, { error: "Not found." });
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
