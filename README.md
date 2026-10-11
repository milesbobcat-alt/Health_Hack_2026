# Health_Hack_2026

## Patient discharge translation

The patient page loads the supported target languages from Amazon Translate and translates the English discharge transcript with the synchronous `TranslateDocument` API. The translation is shown separately from the source text. Attached PDFs are not translated by this feature.

Run the app with Node.js 20 or newer:

```powershell
npm install
$env:AWS_REGION = "us-east-1"
npm start
```

The AWS SDK uses its standard credential provider chain. For local development, configure credentials with an AWS profile or AWS IAM Identity Center. In AWS, use an execution role rather than storing long-lived access keys in the application. The role needs `translate:ListLanguages` and `translate:TranslateDocument` permissions in the configured region.

The translation controls require confirmation that the organization approves sending the patient text to AWS Translate. This implementation translates English source text only and enforces AWS TranslateDocument's 100,000-byte input limit. Review machine translations against the original clinical instructions; do not rely on a translation as the sole source for clinical decisions.