# Health_Hack_2026

## Run locally

Install dependencies with `npm install`, copy `.env.example` to `.env`, and set the
required ElevenLabs and AWS configuration values. A DynamoDB table is required to
save transcripts and create patient links; set `DYNAMODB_TABLE_NAME` to a table
whose partition key is the string `dischargeId`. Attaching a PDF is optional; to
enable PDF uploads, also create an S3 bucket and set `S3_BUCKET_NAME`. Start the
app with `npm start`.
For local AWS access, use an AWS profile rather than placing access keys in `.env`.

Both pages offer a language selector backed by AWS Translate. It loads the
supported-language list from AWS and submits the complete page as an HTML
document to AWS Translate Document; the patient page also includes the loaded
discharge text. Synchronous document translation supports HTML documents up to
100 KB. Translation is machine-generated, so verify clinical instructions
before relying on them.
The AWS identity used by the app needs `translate:ListLanguages` and
`translate:TranslateDocument` permissions in addition to any storage
permissions.
Page text submitted for translation is processed by AWS Translate.

## Deploy to AWS Lambda

Deploy `index.mjs`, `nurseIntake.html`, `ptView.html`, `translate.js`, and the
production dependencies from `package.json`. Set the Lambda handler to `index.handler` and
use a supported Node.js runtime. Set the Lambda timeout to at least 30 seconds
so synchronous AWS Translate document requests can finish before Lambda
terminates the invocation. Configure
`AWS_REGION`, `DYNAMODB_TABLE_NAME`, `S3_BUCKET_NAME`, `ELEVENLABS_API_KEY`, and
`ELEVENLABS_VOICE_ID` as Lambda environment variables; provide S3, DynamoDB,
and AWS Translate access through the Lambda execution role. API Gateway must use a Lambda proxy
integration so the handler receives the API Gateway event and can return its
status, headers, and body.