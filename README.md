# Health_Hack_2026

## Patient discharge translation

The patient and nurse pages load the supported target languages from Amazon Translate and translate the rendered HTML page with the synchronous `TranslateDocument` API. The original page DOM and its event handlers stay in place; translated visible text, form values, placeholders, and accessibility labels are applied as text rather than inserting returned HTML. Selecting **English (original)** restores the saved English strings. Attached PDF contents are not translated.

Run the app with Node.js 20 or newer:

```powershell
npm install
$env:AWS_REGION = "us-east-1"
npm start
```

The AWS SDK uses its standard credential provider chain. For local development, configure credentials with an AWS profile or AWS IAM Identity Center. In AWS, use an execution role rather than storing long-lived access keys in the application. The role needs `translate:ListLanguages` and `translate:TranslateDocument` permissions in the configured region.

The page-translation controls require confirmation that the organization approves sending the rendered page text to AWS Translate. This implementation translates English source text only and enforces AWS TranslateDocument's 100,000-byte input limit. Review machine translations against the original clinical instructions; do not rely on a translation as the sole source for clinical decisions.