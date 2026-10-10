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

const sandbox = 'https://sandbox.example/fhir';
const patient = { resourceType: 'Patient', id: 'patient-1', name: [{ given: ['Andy'], family: 'Gusikowski' }], birthDate: '2018-06-07' };
const bundle = (patients = [], link = []) => ({ resourceType: 'Bundle', type: 'searchset', entry: patients.map(resource => ({ resource })), link });

test('FHIR name search returns patient summaries and server identity', async () => {
  const { url } = await startServer({ fhirBaseUrl: sandbox, fhirFetchImpl: async (target, options) => {
    const upstream = new URL(target);
    assert.equal(upstream.pathname, '/fhir/Patient');
    assert.equal(upstream.searchParams.get('name'), 'Andy');
    assert.equal(options.headers.Accept, 'application/fhir+json');
    assert.equal(options.redirect, 'error');
    return Response.json(bundle([patient]));
  }});
  const response = await fetch(`${url}/api/patients?name=Andy`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { server: sandbox, patients: [{ id: 'patient-1', name: 'Andy Gusikowski', birthDate: '2018-06-07' }], nextCursor: null });
});

test('FHIR full-name search uses given and family; missing demographics are handled', async () => {
  const { url } = await startServer({ fhirBaseUrl: sandbox, fhirFetchImpl: async target => {
    const params = new URL(target).searchParams;
    assert.deepEqual(params.getAll('given'), ['Andy', 'James']);
    assert.equal(params.get('family'), 'Gusikowski');
    return Response.json(bundle([{ resourceType: 'Patient', id: 'minimal' }]));
  }});
  const result = await (await fetch(`${url}/api/patients?name=Andy%20James%20Gusikowski`)).json();
  assert.deepEqual(result.patients, [{ id: 'minimal', name: 'Name unavailable', birthDate: null }]);
});

test('FHIR empty results are successful', async () => {
  const { url } = await startServer({ fhirFetchImpl: async () => Response.json(bundle()) });
  const response = await fetch(`${url}/api/patients?name=Nobody`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).patients, []);
});

test('FHIR upstream failures and invalid JSON produce readable errors without leaking details', async () => {
  for (const provider of [async () => new Response('secret', { status: 500 }), async () => new Response('invalid json'), async () => { throw new Error('secret'); }]) {
    const { url } = await startServer({ fhirFetchImpl: provider });
    const response = await fetch(`${url}/api/patients?name=Andy`);
    assert.equal(response.status, 502);
    assert.doesNotMatch(JSON.stringify(await response.json()), /secret/);
  }
});

test('FHIR patient retrieval supports selection and validates returned identity', async () => {
  const { url } = await startServer({ fhirBaseUrl: sandbox, fhirFetchImpl: async target => {
    assert.equal(target, `${sandbox}/Patient/patient-1`);
    return Response.json(patient);
  }});
  const response = await fetch(`${url}/api/patients/patient-1`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { server: sandbox, patient: { id: 'patient-1', name: 'Andy Gusikowski', birthDate: '2018-06-07' } });
  const other = await startServer({ fhirFetchImpl: async () => Response.json({ ...patient, id: 'wrong' }) });
  assert.equal((await fetch(`${other.url}/api/patients/patient-1`)).status, 502);
});

test('FHIR validates search, ID, cursor, and arbitrary upstream parameters before contacting sandbox', async () => {
  const { url } = await startServer({ fhirFetchImpl: async () => assert.fail('Must not call upstream') });
  for (const path of ['/api/patients', '/api/patients?name=%20', `/api/patients?name=${'x'.repeat(101)}`, '/api/patients?name=a%00', '/api/patients?cursor=https://evil.example', '/api/patients?name=a&cursor=x', '/api/patients?name=a&baseUrl=https://evil.example', '/api/patients?name=a&name=b', '/api/patients/bad%2Fid', '/api/patients/id?url=https://evil.example']) {
    assert.equal((await fetch(`${url}${path}`)).status, 400, path);
  }
  assert.equal((await fetch(`${url}/api/patients?name=Andy`, { method: 'POST' })).status, 405);
});

test('FHIR pagination uses opaque cursors bound to the configured server', async () => {
  let calls = 0;
  const { url } = await startServer({ fhirBaseUrl: sandbox, fhirFetchImpl: async target => {
    calls++;
    if (calls === 1) return Response.json(bundle([patient], [{ relation: 'next', url: `${sandbox}?_getpages=abc&_getpagesoffset=10` }]));
    assert.equal(target, `${sandbox}?_getpages=abc&_getpagesoffset=10`);
    return Response.json(bundle([{ ...patient, id: 'patient-2' }]));
  }});
  const first = await (await fetch(`${url}/api/patients?name=Andy`)).json();
  assert.ok(first.nextCursor);
  assert.doesNotMatch(first.nextCursor, /https/);
  const second = await (await fetch(`${url}/api/patients?cursor=${first.nextCursor}`)).json();
  assert.equal(second.patients[0].id, 'patient-2');
  assert.equal(second.nextCursor, null);
});

test('FHIR rejects foreign-origin and outside-base pagination links', async () => {
  for (const next of ['https://evil.example/fhir/Patient', 'https://sandbox.example/other', 'https://sandbox.example/fhir-evil']) {
    const { url } = await startServer({ fhirBaseUrl: sandbox, fhirFetchImpl: async () => Response.json(bundle([patient], [{ relation: 'next', url: next }])) });
    assert.equal((await fetch(`${url}/api/patients?name=Andy`)).status, 502);
  }
});

test('FHIR request timeouts are reported', async () => {
  const { url } = await startServer({ fhirTimeoutMs: 10, fhirFetchImpl: async (_target, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  const response = await fetch(`${url}/api/patients?name=Andy`);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /timed out/);
});

import { createPatientContext } from './patient-state.mjs';
test('patient selection stores server and ID and requires confirmation before discarding an unassigned draft', () => {
  const context = createPatientContext();
  let cleared = 0;
  const selection = { server: sandbox, patient: { id: 'patient-1', name: 'Andy' } };
  assert.equal(context.selected, null);
  assert.equal(context.select(selection, { hasDraft: true, confirmDiscard: () => false, clearDraft: () => cleared++ }), false);
  assert.equal(context.selected, null);
  assert.equal(cleared, 0);
  assert.equal(context.select(selection, { hasDraft: true, confirmDiscard: () => true, clearDraft: () => cleared++ }), true);
  assert.equal(context.selected.patient.id, 'patient-1');
  assert.equal(context.selected.server, sandbox);
  assert.equal(cleared, 1);
});

test('changing patients or FHIR server cannot silently transfer instructions or PDFs', () => {
  const context = createPatientContext();
  const first = { server: sandbox, patient: { id: 'patient-1' } };
  context.select(first);
  let cleared = 0;
  const refuse = { hasDraft: true, confirmDiscard: () => false, clearDraft: () => cleared++ };
  assert.equal(context.select({ server: sandbox, patient: { id: 'patient-2' } }, refuse), false);
  assert.equal(context.clear(refuse), false);
  assert.equal(context.selected.patient.id, 'patient-1');
  assert.equal(context.select({ ...first, server: 'https://other.example' }, refuse), false);
  assert.equal(cleared, 0);
  assert.equal(context.select(first, refuse), true); // Same patient keeps its draft.
  assert.equal(context.clear({ ...refuse, confirmDiscard: () => true }), true);
  assert.equal(cleared, 1);
  assert.equal(context.selected, null);
});

const medStatement = overrides => ({ resourceType: 'MedicationStatement', id: 'statement-1', subject: { reference: 'Patient/patient-1' }, status: 'stopped', medicationReference: { reference: 'Medication/med-1' }, effectivePeriod: { start: '2020-01-01', end: '2021-01-01' }, dosage: [{ text: 'Take two tablets twice daily as needed.', doseAndRate: [{ doseQuantity: { value: 2, unit: 'tablets' } }], timing: { repeat: { frequency: 2, period: 1, periodUnit: 'd' } }, asNeededBoolean: true }, { text: 'Then reduce to one tablet.', doseAndRate: [{ doseQuantity: { value: 1, unit: 'tablet' } }] }], ...overrides });
const medResource = { resourceType: 'Medication', id: 'med-1', code: { text: 'Example medicine' }, ingredient: [{ strength: { numerator: { value: 5, unit: 'mg' }, denominator: { value: 1, unit: 'tablet' } } }] };

test('MedicationStatement retrieval follows all pages, resolves and caches medication references, and preserves multiple dosages', async () => {
  let medCalls = 0;
  const { url } = await startServer({ fhirBaseUrl: sandbox, fhirFetchImpl: async target => {
    const upstream = new URL(target);
    if (upstream.pathname === '/fhir/Medication/med-1') { medCalls++; return Response.json(medResource); }
    if (upstream.searchParams.has('_getpages')) return Response.json(bundle([medStatement({ id: 'statement-2', status: 'active' })]));
    assert.equal(upstream.pathname, '/fhir/MedicationStatement');
    assert.equal(upstream.searchParams.get('patient'), 'patient-1');
    assert.equal(upstream.searchParams.has('status'), false);
    return Response.json(bundle([medStatement()], [{ relation: 'next', url: `${sandbox}?_getpages=medications` }]));
  }});
  const response = await fetch(`${url}/api/patients/patient-1/medication-statements`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.patientId, 'patient-1');
  assert.equal(result.server, sandbox);
  assert.equal(result.statements.length, 2);
  const first = result.statements[0];
  assert.equal(first.name, 'Example medicine');
  assert.equal(first.strength, '5 mg / 1 tablet');
  assert.equal(first.status, 'stopped');
  assert.equal(first.effective, '2020-01-01 — 2021-01-01');
  assert.equal(first.dosages.length, 2);
  assert.equal(first.dosages[0].dose, '2 tablets');
  assert.equal(first.dosages[0].asNeeded, 'Yes');
  assert.match(first.dosages[0].timing, /2 times every 1 day/);
  assert.equal(first.dosages[1].text, 'Then reduce to one tablet.');
  assert.deepEqual(first.dosages[0].raw, medStatement().dosage[0]);
  assert.equal(medCalls, 1);
});

test('contained and bundle-included Medication resources resolve without extra requests; missing fields remain undocumented', async () => {
  let calls = 0;
  const { url } = await startServer({ fhirBaseUrl: sandbox, fhirFetchImpl: async () => {
    calls++;
    return Response.json(bundle([
      medStatement({ id: 'contained', medicationReference: { reference: '#local' }, contained: [{ ...medResource, id: 'local' }] }),
      medStatement({ id: 'included' }), medResource,
      medStatement({ id: 'minimal', medicationReference: undefined, medicationCodeableConcept: { text: 'Drug name with 20 mg in display' }, dosage: undefined, effectivePeriod: undefined }),
    ]));
  }});
  const { statements } = await (await fetch(`${url}/api/patients/patient-1/medication-statements`)).json();
  assert.equal(calls, 1);
  assert.equal(statements.length, 3);
  assert.equal(statements[0].strength, '5 mg / 1 tablet');
  assert.equal(statements[1].name, 'Example medicine');
  assert.equal(statements[2].strength, 'Not documented'); // Don't infer from dose or display text.
  assert.equal(statements[2].dosages[0].dose, 'Not documented');
  assert.equal(statements[2].dosages[0].timing, 'Not documented');
  assert.equal(statements[2].effective, 'Not documented');
});

test('missing medication references retain available statement details with a warning', async () => {
  const { url } = await startServer({ fhirBaseUrl: sandbox, fhirFetchImpl: async target => target.includes('/Medication/') ? new Response('', { status: 404 }) : Response.json(bundle([medStatement({ medicationReference: { reference: 'Medication/med-1', display: 'Known name' } })])) });
  const response = await fetch(`${url}/api/patients/patient-1/medication-statements`);
  assert.equal(response.status, 200);
  const statement = (await response.json()).statements[0];
  assert.equal(statement.name, 'Known name');
  assert.equal(statement.strength, 'Not documented');
  assert.match(statement.warning, /not found/);
});

test('medication queries handle empty results, upstream failures, and invalid IDs', async () => {
  const empty = await startServer({ fhirFetchImpl: async () => Response.json(bundle()) });
  assert.deepEqual((await (await fetch(`${empty.url}/api/patients/patient-1/medication-statements`)).json()).statements, []);
  const failure = await startServer({ fhirFetchImpl: async () => new Response('private upstream error', { status: 500 }) });
  const response = await fetch(`${failure.url}/api/patients/patient-1/medication-statements`);
  assert.equal(response.status, 502);
  assert.doesNotMatch(JSON.stringify(await response.json()), /private/);
  const invalid = await startServer({ fhirFetchImpl: async () => assert.fail('No upstream request') });
  assert.equal((await fetch(`${invalid.url}/api/patients/bad%2Fid/medication-statements`)).status, 400);
});

test('medication resolution rejects foreign references and records from another patient', async () => {
  for (const override of [{ medicationReference: { reference: 'https://evil.example/Medication/med-1' } }, { medicationReference: { reference: `${sandbox}/Patient/med-1` } }, { subject: { reference: 'Patient/other' } }]) {
    let calls = 0;
    const { url } = await startServer({ fhirBaseUrl: sandbox, fhirFetchImpl: async () => { calls++; return Response.json(bundle([medStatement(override)])); } });
    assert.equal((await fetch(`${url}/api/patients/patient-1/medication-statements`)).status, 502);
    assert.equal(calls, 1);
  }
});

test('medication pagination rejects unsafe or repeating links rather than returning an incomplete list', async () => {
  for (const next of ['https://evil.example/fhir', `${sandbox}/MedicationStatement?patient=patient-1&_count=50`]) {
    const { url } = await startServer({ fhirBaseUrl: sandbox, fhirFetchImpl: async () => Response.json(bundle([medStatement()], [{ relation: 'next', url: next }])) });
    assert.equal((await fetch(`${url}/api/patients/patient-1/medication-statements`)).status, 502);
  }
});

import { createMedicationLoader } from './patient-state.mjs';
test('medication loader caches successful expansions and ignores delayed results after patient changes', async () => {
  let resolveOld;
  const updates = [];
  let calls = 0;
  const context = { server: sandbox, patient: { id: 'patient-1' } };
  const loader = createMedicationLoader(async id => {
    calls++;
    if (id === 'patient-1') return new Promise(resolve => { resolveOld = resolve; });
    return { server: sandbox, patientId: id, statements: [] };
  }, value => updates.push(value));
  const old = loader.load(context);
  loader.reset();
  const current = { server: sandbox, patient: { id: 'patient-2' } };
  await loader.load(current);
  resolveOld({ server: sandbox, patientId: 'patient-1', statements: [{ name: 'Wrong patient drug' }] });
  await old;
  assert.equal(updates.at(-1).result.patientId, 'patient-2');
  assert.equal(updates.some(u => u.result?.patientId === 'patient-1'), false);
  await loader.load(current);
  assert.equal(calls, 2);
});

test('medication loader supports retry after errors and rejects mismatched patient identity', async () => {
  let calls = 0;
  const updates = [];
  const loader = createMedicationLoader(async () => {
    calls++;
    if (calls === 1) throw new Error('Sandbox unavailable');
    if (calls === 2) return { server: sandbox, patientId: 'wrong', statements: [] };
    return { server: sandbox, patientId: 'patient-1', statements: [] };
  }, value => updates.push(value));
  const context = { server: sandbox, patient: { id: 'patient-1' } };
  await loader.load(context);
  assert.equal(updates.at(-1).state, 'error');
  await loader.load(context);
  assert.equal(updates.at(-1).state, 'error');
  await loader.load(context);
  assert.equal(updates.at(-1).state, 'loaded');
});

test('prescription records keep source identity, use dosageInstruction, and expose literal coded product strength', async () => {
  const { url } = await startServer({ fhirBaseUrl: sandbox, fhirFetchImpl: async target => {
    const upstream = new URL(target);
    assert.equal(upstream.pathname, '/fhir/MedicationRequest');
    assert.equal(upstream.searchParams.get('patient'), 'patient-1');
    return Response.json(bundle([{ resourceType: 'MedicationRequest', id: 'request-1', subject: { reference: 'Patient/patient-1' }, status: 'active', authoredOn: '2020-01-01', medicationCodeableConcept: { coding: [{ code: '316049', display: 'Hydrochlorothiazide 25 MG' }], text: 'Hydrochlorothiazide 25 MG' }, dosageInstruction: [{ text: 'One tablet daily', doseAndRate: [{ doseQuantity: { value: 1, unit: 'tablet' } }], timing: { repeat: { frequency: 1, period: 1, periodUnit: 'd' } } }] }]));
  }});
  const response = await fetch(`${url}/api/patients/patient-1/medication-requests`);
  assert.equal(response.status, 200);
  const record = (await response.json()).statements[0];
  assert.equal(record.source, 'MedicationRequest');
  assert.equal(record.name, 'Hydrochlorothiazide 25 MG');
  assert.equal(record.labelStrength, '25 MG');
  assert.equal(record.strength, 'Not documented');
  assert.equal(record.dosages[0].dose, '1 tablet');
  assert.equal(record.recordedOn, '2020-01-01');
});

test('incomplete sandbox statements preserve notes and assertion dates without inventing drug details', async () => {
  const { url } = await startServer({ fhirBaseUrl: sandbox, fhirFetchImpl: async () => Response.json(bundle([medStatement({ medicationReference: undefined, medicationCodeableConcept: { text: 'Medication' }, dosage: undefined, note: [{ text: 'Medication taken as prescribed' }], dateAsserted: '2025-09-15', effectivePeriod: undefined })])) });
  const record = (await (await fetch(`${url}/api/patients/patient-1/medication-statements`)).json()).statements[0];
  assert.equal(record.name, 'Medication');
  assert.equal(record.notes, 'Medication taken as prescribed');
  assert.equal(record.recordedOn, '2025-09-15');
  assert.equal(record.effective, 'Not documented');
  assert.equal(record.labelStrength, null);
  assert.equal(record.dosages[0].dose, 'Not documented');
});
