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