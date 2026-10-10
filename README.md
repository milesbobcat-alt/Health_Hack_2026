# Care Checklist Demo

## Run

Use Node.js 20 or newer:

```sh
node server.mjs
```

Open http://127.0.0.1:3000. If port 3000 is busy, run `PORT=3001 node server.mjs` and open port 3001 instead. Run tests with `node --test *.test.mjs`.

Upload a text-based PDF or paste discharge instructions. The app drafts smaller steps from the discharge section, groups them into medicines, daily care, appointments, tests, and other steps, and separates warning signs. Review each line and its source wording; adjust category and timing before sharing. If a PDF contains multiple patient examples, choose one first. Share by copying a link or select SMS/email; message delivery requires configured providers and patient consent. Messages contain only a generic link. Daily reminders are optional and stop after all items are checked.

## Demo limits

Without provider credentials, SMS and email have status `demo only` and no messages leave the computer. Scanned image PDFs require OCR and will not extract text here. Drafting is a conservative rules-based aid: it classifies source lines but does not infer doses, translate, or simplify clinical instructions. The clinician must review the wording and timing. Checklist data and contacts are kept in server memory for at most 30 days, and a restart clears them sooner. Localhost links can only be opened on the same computer. Use fictional patient information in this demo.

For delivery after deployment, set `PUBLIC_BASE_URL` to the public HTTPS origin and configure `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `SENDGRID_API_KEY`, and `SENDGRID_FROM_EMAIL` in the server environment. The sending code uses [Twilio Messages](https://www.twilio.com/docs/messaging/api/message-resource) and [SendGrid Mail Send](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send). A production service also needs durable storage and a persistent scheduler so reminders survive restarts.
