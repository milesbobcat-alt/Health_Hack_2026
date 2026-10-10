# Health Hack 2026

A local nurse intake prototype with synthetic-patient search, care instructions, audio transcription, PDF selection, and a patient read-aloud page. Requires Node.js 22 or newer. No package installation is needed.

## Run on your Mac

In the VS Code terminal:

```sh
cd "/Users/dinadank/Desktop/Changing Hackathon Code/Health_Hack_2026"
PORT=3001 node server.mjs
```

Open http://127.0.0.1:3001 for the nurse page. The patient page is at http://127.0.0.1:3001/ptView.html. Keep the terminal open. To stop, press Control+C. After changing server code, stop and restart it; refresh the browser after changes to the page.

If port 3001 is occupied, use `PORT=3002 node server.mjs` and open that port instead.

## FHIR configuration

Patient search defaults to the public, unauthenticated SMART Health IT R4 endpoint:

```text
https://r4.smarthealthit.org
```

SMART's official documentation lists this as an [R4 open endpoint](https://docs.smarthealthit.org/). Its live CapabilityStatement was verified on October 10, 2026: FHIR 4.0.0, with Patient search parameters `name`, `given`, and `family`. This is a sandbox FHIR connection, not completed production EHR integration. Production use may require SMART on FHIR authorization, appropriate permissions, and an EHR-specific configuration. Only use synthetic patients with this prototype.

To use a different trusted FHIR R4 server, configure it on the server, not in the browser:

```sh
FHIR_BASE_URL="https://r4.smarthealthit.org" PORT=3001 node server.mjs
```

The server makes read-only requests with a 15-second timeout. Browser requests cannot supply an upstream URL. Pagination uses short-lived opaque cursors held by the server (10 minutes; up to 200 pending cursors). Restarting the server invalidates old cursors; search again.

## Test in your browser

1. Search **Andy Gusikowski** and press Enter (or click Search). This synthetic patient was verified by a live full-name query on October 10, 2026. Expected date of birth: `2018-06-07`; FHIR ID: `af1667b5-ef55-4313-8e39-04c2ba4e4c1b`. Sandbox records can change.
2. Check the name, date of birth, and ID, then click **Select patient**. Nothing is selected automatically.
3. Search a first name (`Andy`) or family name (`Gusikowski`). Click **Load more** when available. If no match is found, the page says so; it never substitutes mock patients.
4. Full names are interpreted as given name(s) followed by the final family-name word. For compound family names or names in a different order, search a single name component. FHIR string searches normally match prefixes rather than arbitrary substrings; punctuation or misspellings may yield no results.
5. Enter sample instructions and choose a sample PDF. Click **Change patient**. Cancel the confirmation to keep the selection and draft; confirm to clear both instructions and PDF before choosing another patient. Initially unassigned drafts require the same confirmation before selecting a patient.
6. Try a name such as `NoSuchPatientZzz987`. Verify the no-results message. If the sandbox is down or unreachable, a visible error is shown; retry later.
7. Changing patients is blocked while microphone permission, recording, or transcription is in progress. Finish that operation first. New searches and edited search text invalidate earlier responses so stale results cannot replace current ones.

## Optional ElevenLabs configuration

Patient search does not require an ElevenLabs key. Recording transcription does:

```sh
export ELEVENLABS_API_KEY="your-key"
PORT=3001 node server.mjs
```

The transcription model defaults to `scribe_v2_medical`, configurable using `ELEVENLABS_MODEL_ID`. Patient read-aloud additionally requires `ELEVENLABS_VOICE_ID`; its model defaults to `eleven_multilingual_v2`, configurable using `ELEVENLABS_TTS_MODEL_ID`. API keys stay on the server. Do not commit keys.

## Automated checks

```sh
node --test server.test.mjs
```

Tests mock external services. They cover existing speech features plus patient search, empty results, demographic fallbacks, retrieval identity, input validation, timeouts, upstream failures, constrained pagination, and patient-switch draft safeguards. Live sandbox verification is separate from these tests.

## Files and next step

- `nurseIntake.html`: nurse UI, patient search, explicit selection, and recording/PDF controls.
- `server.mjs`: serves pages and the patient-state module; routes `/api/patients?name=...`, `/api/patients?cursor=...`, and `/api/patients/:id` through the FHIR client. Existing speech routes are preserved.
- `fhir.mjs`: configurable read-only FHIR client with reusable `searchPatients` and `getPatient` operations.
- `patient-state.mjs`: page-memory patient context (`server` plus `patient.id` and demographics), and confirmed draft clearing when the context changes.
- `server.test.mjs`: automated tests.
- `ptView.html`: existing patient read-aloud UI; not automatically connected to this selected patient.

The nurse page emits a `patient-context-changed` document event with the selected context (or `null`). A later medication feature can use that context's server and patient ID to query structured MedicationRequest and MedicationStatement resources through the reusable FHIR module. MedicationStatement retrieval is implemented. MedicationStatement and MedicationRequest retrieval are implemented; before/after comparison, record writes, and PDF parsing are not implemented. PDFs remain selected locally in the page; they are not uploaded or saved. Selection and instructions are not persisted and are lost on refresh.

## Medication statement viewer

After selecting a patient, click the underlined **Medication statement** control to expand the list. Its first expansion loads all available MedicationStatement pages through `/api/patients/:id/medication-statements`. Reopening uses page-memory cached results; changing patients clears them. Errors have a Retry medications button.

The list shows name, separately documented ingredient strength, all dosage instructions (dose, timing, as-needed use, route, and original text), status, and effective dates. Missing fields are omitted from the display and summarized once per record. Strength is not guessed from dosage or drug-name text. Missing referenced Medication records produce a visible warning. Unsafe references and incomplete pagination fail visibly. Historical statuses are included; this list is not a confirmed pre-admission medication list. No PDF extraction, medication comparison, or EHR writes are performed.

Live check on October 10, 2026: Andy Gusikowski has no MedicationStatement records. The viewer shows the empty state rather than substituting another medication resource. Populated medication fields, reference resolution, retries, and patient-switch behavior are verified with synthetic test fixtures.

### Incomplete sandbox records
The expanded viewer now fetches MedicationStatements and MedicationRequests separately, labels each section, and preserves each record's source. Generic “Medication” statements are shown as unnamed records with their notes and recorded dates. They are not counted as identified drugs. No matching or merging of unnamed statements into prescription records is performed. Literal strength text from a coded product name is labeled “Strength in product name”; it is not used as the dose. Each record has one concise missing-information explanation instead of repeated empty fields. If one resource endpoint fails, the other can still be shown alongside a visible warning.

Live check: Omar Abernathy (80a75b5a-fd30-4f38-895d-d8098fe7206e) has two unnamed statements and three named MedicationRequests. The prescription product names contain 25 MG, 325 MG, and 20 MG strengths, but no dosageInstruction is supplied for these orders. Dose and timing cannot be recovered from those records.
