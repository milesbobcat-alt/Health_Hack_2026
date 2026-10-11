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

The patient page offers a language selector backed by AWS Translate. It loads the
supported-language list from AWS and submits the complete page as an HTML
document to AWS Translate Document; the patient page also includes the loaded
discharge text. Synchronous document translation supports HTML documents up to
100 KB. Translation is machine-generated, so verify clinical instructions
before relying on them.
The AWS identity used by the app needs `translate:ListLanguages` and
`translate:TranslateDocument` permissions in addition to any storage
permissions.
Page text submitted for translation is processed by AWS Translate.
If translation reports that the app API cannot be reached, verify that
`/api/translate` and `/api/translate/languages` are routed to the deployed Lambda.
If the app reports an AWS error code and request ID, use those values to locate
the corresponding `aws_translate_document_failed` entry in CloudWatch Logs; the
log records diagnostics but never the submitted page content.

## Deploy to AWS Lambda

Deploy `index.mjs`, `nurseIntake.html`, `ptView.html`, `translate.js`, and the
production dependencies from `package.json`. Set the Lambda handler to
`index.handler` and use a supported Node.js runtime. Set the Lambda timeout to
at least 30 seconds so synchronous AWS Translate document requests can finish
before Lambda terminates the invocation. Configure `BEDROCK_MODEL_ID`,
`AWS_REGION`, `DYNAMODB_TABLE_NAME`, `S3_BUCKET_NAME`,
`ELEVENLABS_API_KEY`, and `ELEVENLABS_VOICE_ID` as Lambda environment variables;
set `DYNAMODB_TABLE_NAME` to the exact name of the existing DynamoDB table whose
partition key is the string `dischargeId`; without this setting, creating or
loading patient discharge records returns HTTP 503.
provide `bedrock-mantle:CreateInference`, S3, DynamoDB, AWS Translate, and
CloudWatch Logs access through the Lambda execution role. The role needs
`translate:ListLanguages` and `translate:TranslateDocument` permissions for
translation. API Gateway must use a Lambda proxy integration so the handler
receives the API Gateway event and can return its status, headers, and body.
