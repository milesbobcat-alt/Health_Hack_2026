# Health_Hack_2026

## Run locally

Install dependencies with `npm install`, copy `.env.example` to `.env`, and set the
required ElevenLabs and AWS configuration values. A DynamoDB table is required to
save transcripts and create patient links; set `DYNAMODB_TABLE_NAME` to a table
whose partition key is the string `dischargeId`. Attaching a PDF is optional; to
enable PDF uploads, also create an S3 bucket and set `S3_BUCKET_NAME`. Set
`BEDROCK_MODEL_ID` to a model supported by Bedrock Mantle in the configured
region. The Mantle client uses `AWS_REGION` from Lambda automatically; when
running outside Lambda, it defaults to `us-west-2`. The Lambda execution role
needs `bedrock-mantle:CreateInference` permission, plus the existing S3 and
DynamoDB permissions. It also needs CloudWatch Logs permissions (for example,
the managed `AWSLambdaBasicExecutionRole` policy) to create and write logs.
The checklist endpoint writes request-start and completion records with a
request ID, and returns that ID in the `X-Request-Id` response header. Bedrock
failure responses include the same ID plus the error code, stage, region, and
configured model ID; source transcript and PDF text are not logged.
For a temporary, fixed-prompt Bedrock smoke test in the Lambda environment, set
`BEDROCK_DIAGNOSTICS_ENABLED=true`, deploy, then send a body-free `POST` to
`/api/bedrock-diagnostic`. It uses the configured model and region, sends no
patient data, and is disabled unless explicitly enabled. Disable it again by
removing the setting or setting it to `false` after the test.
Start the app with `npm start`.
For local AWS access, use an AWS profile rather than placing access keys in `.env`.

## Deploy to AWS Lambda

Deploy `index.mjs`, `nurseIntake.html`, `ptView.html`, and the production
dependencies from `package.json`. Set the Lambda handler to `index.handler` and
use a supported Node.js runtime. Configure
`BEDROCK_MODEL_ID`, `AWS_REGION`, `DYNAMODB_TABLE_NAME`, `S3_BUCKET_NAME`,
`ELEVENLABS_API_KEY`, and `ELEVENLABS_VOICE_ID` as Lambda environment variables;
provide `bedrock-mantle:CreateInference`, S3, DynamoDB, and CloudWatch Logs
access through the Lambda execution role. API
Gateway must use a Lambda proxy integration so the handler receives the API
Gateway event and can return its status, headers, and body.

## FHIR patient and medication viewer

Use Node.js 22 or later. From this project folder:

```sh
npm install
cp -n .env.example .env
# Fill in the team's AWS settings and optional ElevenLabs values in .env.
# Use your configured AWS profile for AWS access (no access keys in .env).
PORT=3121 npm start
```

Open http://127.0.0.1:3121/. FHIR search works without AWS credentials: search
`Omar Abernathy`, select the match explicitly, and expand **Medication statement**.
Statement and prescription records are separate sources; missing information is not
invented, and strength is separate from dose. Loading, empty, error, and paginated
search states are supported. `FHIR_BASE_URL` configures the only allowed upstream
server; requests use a 15-second timeout. This is a synthetic sandbox FHIR
connection, not a production EHR authorization integration.

Patient changes require confirmation before clearing text, PDFs, AI plans, and
patient-link details. Finish recording/generation/saving first. FHIR selection is
stored in page state only; it is not sent to Bedrock, used to populate a medication
comparison, or added to persisted discharge records in this step.

Test with `npm test` (AWS, Bedrock, and FHIR services are mocked). Browser checks:
search/select a patient, expand medications, enter synthetic instructions, change
patient, cancel to keep the draft, then confirm to clear it. With your authorized
AWS setup, separately verify Generate AI Care Plan, review/edit, and patient links.
These AWS actions require the existing model/region permissions, DynamoDB table,
and an S3 bucket for PDF storage. Missing AWS setup is reported as an error; no
hardcoded checklist fallback is added.

Include `fhir.mjs`, `patient-state.mjs`, and `patient-viewer.mjs` in the Lambda
package alongside the existing files. Production EHR connections may need SMART
on FHIR authorization and suitable permissions.


Verification on 2026-10-11: 49 mocked automated tests passed. Live sandbox
search for Omar Abernathy and retrieval of his statement/prescription records
passed. Browser checks covered Enter search, explicit selection, medication
expansion, mock AI review/link creation, and cancel/confirm patient changes.
Bedrock, DynamoDB, and S3 were mocked; no paid AWS requests were made and live
AWS behavior has not been verified for this integration. Audio capture was not
retested live. No push or deployment was performed.

### Structured discharge medications
Generate from a nurse transcript, a text-based PDF, or both. Empty/unreadable PDFs are rejected; scanned PDFs have no OCR support. PDF text already goes to Bedrock; S3 saves the original on confirmation. Medicine items contain name, strength (per unit), dose (amount taken), frequency, and optional instructions. Missing values remain null and display “Not documented”; source conflicts are marked REVIEW REQUIRED for nurse review. Edit the fields before saving. Older string-based medicine plans remain readable. FHIR medications remain separate.

Run `npm test`, then `PORT=3121 npm start`. Test PDF-only generation, edit/save medication fields, and open the patient link to check display and read-aloud. Live generation/storage/audio require configured AWS/ElevenLabs access; automated tests mock providers.

Wound-care items now include `instructions` and nullable `frequency`; legacy strings remain readable. The `contactPhysician` category displays “Contact Physician Immediately” and contains only source-documented warnings in patient language. The AI prompt preserves emergency actions such as calling 911; nurses must review generated wording. Legacy plans receive an empty warning category without reclassifying their existing instructions. Medicine fields use compact responsive rows in review and patient views.

Combined-source generation explicitly asks Bedrock to cover both PDF and transcript without prioritizing either, and flag conflicts for review. Mocked tests verify both inputs reach the model and returned instructions from both render on the patient page; this does not prove live model completeness. PDF extraction failures log only a generic error code. Patient-link copy feedback is retained, with a compact styled link box.

Combined-input generation now extracts the PDF and transcript independently (two Bedrock requests when both are present), then merges supported items in code. Matching medication/wound fields with conflicting values become null and retain both values in a REVIEW REQUIRED instruction. A failed/empty source result prevents a misleading partial plan. Numbered example headings do not reject uploaded PDFs. No general patient-identity verification or OCR is implemented.

### Before/After medication review
The Medical Workspace displays CarePack Instructions and a full-width medication comparison below checklist review. Generation retrieves named MedicationStatement and MedicationRequest records for the explicitly selected patient from the configured FHIR server (no need to expand the viewer first). FHIR-only history is provisional/unverified, including historical and prescription records; it is not confirmed pre-admission use. Partial FHIR failures show incomplete-history warnings. FHIR is not sent to Bedrock.

The AI extracts `medicationTransitions` (`before`, `continue`, `begin`, `stop`) independently from PDF and transcript. Explicit prior fields override corresponding FHIR fields; discharge directions do not overwrite Before. Conflicts retain both wordings for review. Explicitly changed regimens display Begin; omitted discharge actions remain “Discharge information not provided.” Rows align by medication/formulation and sort Begin, Continue, Stop, then unknown. Distinct documented formulations remain separate; undocumented/ambiguous names are not assumed equivalent. Dose means documented units taken, separate from per-unit strength; total mg amounts remain in instructions when unit counts are unknown. No dose conversion is performed.

Use “Review or edit medication groups” to review/revise the provisional baseline and four transition groups before confirmation. The comparison and patient/server context are stored with the discharge record, displayed in the patient portal, and included in read-aloud. Legacy records without comparisons still load. Source/patient changes invalidate the comparison. Test with synthetic patients: generate, inspect Before/After, edit a group, save, open the patient link, and verify missing/changed/stopped medications. Run `npm test`; start with `PORT=3121 npm start`. Live AI/storage/audio behavior requires configured services and is not exercised by mocked tests.

### Patient translation

Integrated selectively from `origin/liza_translate_merge`; existing FHIR, checklist generation, storage, and medication comparison stay intact. Restart with `PORT=3121 npm start`, open a saved patient link, choose a language, and select Translate page. Show original restores English. Checklist tab changes translate the new content without replacing controls or losing checks. Read-aloud uses the translated care text; the PDF itself and patient-entered questions are unchanged.

Uses AWS Translate in `AWS_REGION` with the same AWS credential chain. The local identity and deployed Lambda role need `translate:ListLanguages` and `translate:TranslateDocument`. No translation API key is required. Requests translate English to a supported language, send only text markers (no scripts, styles, URLs, or question input), enforce the 100 KB synchronous document limit, and time out after 15 seconds. Languages and repeated page snapshots are cached. Translations are display-only; saved plans retain their original wording. Paid live calls were not used in integration testing.
