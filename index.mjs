import "dotenv/config";
import express from "express";
import multer from "multer";
import serverless from "serverless-http";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { v4 as uuidv4 } from "uuid";
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  ListLanguagesCommand,
  TranslateClient,
  TranslateDocumentCommand,
} from "@aws-sdk/client-translate";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const projectDirectory = import.meta.dirname;
const defaultMaxAudioBytes = 25 * 1024 * 1024;
const maxPdfBytes = 20 * 1024 * 1024;
const maxSpeechTextCharacters = 5000;
const maxTranscriptBytes = 300 * 1024;
const maxTranslationDocumentBytes = 100 * 1024;
const transcriptionUrl = "https://api.elevenlabs.io/v1/speech-to-text";
const speechUrl = "https://api.elevenlabs.io/v1/text-to-speech";
const dischargeLifetimeSeconds = 30 * 24 * 60 * 60;

function sendJson(response, statusCode, body) {
  response.status(statusCode)
    .set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    })
    .json(body);
}

function createApp({
  apiKey = process.env.ELEVENLABS_API_KEY,
  modelId = process.env.ELEVENLABS_MODEL_ID || "scribe_v2_medical",
  speechModelId = process.env.ELEVENLABS_TTS_MODEL_ID || "eleven_multilingual_v2",
  voiceId = process.env.ELEVENLABS_VOICE_ID,
  fetchImpl = fetch,
  maxAudioBytes = defaultMaxAudioBytes,
  awsRegion = process.env.AWS_REGION,
  tableName = process.env.DYNAMODB_TABLE_NAME,
  bucketName = process.env.S3_BUCKET_NAME,
  dynamoClient,
  s3Client,
  translateClient,
  getSignedUrlImpl = getSignedUrl,
  idGenerator = uuidv4,
  now = Date.now,
  maxPdfBytes: uploadLimit = maxPdfBytes,
} = {}) {
  const app = express();
  const documentClient = dynamoClient
    || DynamoDBDocumentClient.from(new DynamoDBClient({ region: awsRegion }));
  const objectClient = s3Client || new S3Client({ region: awsRegion });
  const translationClient = translateClient || new TranslateClient({ region: awsRegion });
  const pdfUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: uploadLimit, files: 1, fields: 1 },
  }).single("pdfFile");

  app.disable("x-powered-by");
  app.get(["/", "/nurseIntake.html"], (request, response) => {
    response.set("Cache-Control", "no-store").sendFile(
      resolve(projectDirectory, "nurseIntake.html"),
      (error) => {
        if (error && !response.headersSent) {
          sendJson(response, 500, { error: "The nurse intake page could not be loaded." });
        }
      },
    );
  });
  app.get("/ptView.html", (request, response) => {
    response.set("Cache-Control", "no-store").sendFile(
      resolve(projectDirectory, "ptView.html"),
      (error) => {
        if (error && !response.headersSent) {
          sendJson(response, 500, { error: "The patient view page could not be loaded." });
        }
      },
    );
  });
  app.get("/translate.js", (request, response) => {
    response.set("Cache-Control", "no-store").sendFile(
      resolve(projectDirectory, "translate.js"),
      (error) => {
        if (error && !response.headersSent) {
          sendJson(response, 500, { error: "The translation controls could not be loaded." });
        }
      },
    );
  });

  let supportedLanguagesPromise;
  async function getSupportedLanguages() {
    if (!supportedLanguagesPromise) {
      supportedLanguagesPromise = (async () => {
        const languages = [];
        let nextToken;
        do {
          const result = await translationClient.send(new ListLanguagesCommand({
            DisplayLanguageCode: "en",
            ...(nextToken && { NextToken: nextToken }),
          }));
          languages.push(...(result.Languages || []));
          nextToken = result.NextToken;
        } while (nextToken);
        return languages;
      })().catch((error) => {
        supportedLanguagesPromise = undefined;
        throw error;
      });
    }
    return supportedLanguagesPromise;
  }

  app.get("/api/translate/languages", async (request, response) => {
    try {
      const languages = await getSupportedLanguages();
      sendJson(response, 200, {
        languages: languages
          .filter((language) => language.LanguageCode && language.LanguageName)
          .sort((left, right) => left.LanguageName.localeCompare(right.LanguageName))
          .map(({ LanguageCode, LanguageName }) => ({
            code: LanguageCode,
            name: LanguageName,
          })),
      });
    } catch (error) {
      console.error("Failed to list AWS Translate languages.", error);
      sendJson(response, 502, { error: "Available languages could not be loaded from AWS Translate." });
    }
  });

  app.post("/api/translate", express.json({ limit: "700kb" }), async (request, response) => {
    const { html, targetLanguage } = request.body || {};
    if (typeof html !== "string" || !html.trim()) {
      sendJson(response, 400, { error: "Provide the HTML document to translate." });
      return;
    }
    if (Buffer.byteLength(html, "utf8") > maxTranslationDocumentBytes) {
      sendJson(response, 413, { error: "HTML documents must be 100 KB or smaller for AWS Translate." });
      return;
    }
    if (typeof targetLanguage !== "string" || !targetLanguage.trim()) {
      sendJson(response, 400, { error: "Choose a supported target language." });
      return;
    }

    try {
      const languages = await getSupportedLanguages();
      if (!languages.some((language) => language.LanguageCode === targetLanguage)) {
        sendJson(response, 400, { error: "Choose a supported target language." });
        return;
      }

      const result = await translationClient.send(new TranslateDocumentCommand({
        Document: {
          Content: Buffer.from(html, "utf8"),
          ContentType: "text/html",
        },
        SourceLanguageCode: "auto",
        TargetLanguageCode: targetLanguage,
      }));
      const translatedContent = result.TranslatedDocument?.Content;
      if (!translatedContent?.length) {
        throw new Error("AWS Translate returned no translated HTML document.");
      }

      sendJson(response, 200, {
        translatedHtml: Buffer.from(translatedContent).toString("utf8"),
      });
    } catch (error) {
      console.error("Failed to translate HTML document with AWS Translate.", error);
      sendJson(response, 502, { error: "AWS Translate could not translate the HTML document. Please try again." });
    }
  });

  app.post(
    "/api/discharge",
    (request, response, next) => pdfUpload(request, response, (error) => {
      if (error) {
        if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
          sendJson(response, 413, { error: "PDF file exceeds the 20 MB limit." });
          return;
        }
        if (error instanceof multer.MulterError) {
          sendJson(response, 400, { error: "Provide a transcript and at most one PDF file." });
          return;
        }
        next(error);
        return;
      }
      next();
    }),
    async (request, response) => {
      const { transcript } = request.body || {};
      const pdfFile = request.file;
      if (typeof transcript !== "string" || !transcript.trim()) {
        sendJson(response, 400, { error: "Provide a non-empty discharge transcript." });
        return;
      }
      if (Buffer.byteLength(transcript, "utf8") > maxTranscriptBytes) {
        sendJson(response, 413, { error: "Transcript exceeds the supported size limit." });
        return;
      }
      if (pdfFile && (!pdfFile.originalname.toLowerCase().endsWith(".pdf")
        || (pdfFile.mimetype && pdfFile.mimetype !== "application/pdf"))) {
        sendJson(response, 400, { error: "Attach one valid PDF document." });
        return;
      }
      if (!tableName) {
        sendJson(response, 503, {
          error: "Discharge storage is not configured: set DYNAMODB_TABLE_NAME on the server.",
        });
        return;
      }
      if (pdfFile && !bucketName) {
        sendJson(response, 503, {
          error: "PDF storage is not configured: set S3_BUCKET_NAME on the server.",
        });
        return;
      }

      const dischargeId = idGenerator();
      const pdfKey = pdfFile ? `discharges/${dischargeId}/${pdfFile.originalname}` : undefined;
      const submittedAt = now();
      const createdAt = new Date(submittedAt).toISOString();
      const expiresAt = Math.floor(submittedAt / 1000) + dischargeLifetimeSeconds;

      try {
        if (pdfFile) {
          await objectClient.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: pdfKey,
            Body: pdfFile.buffer,
            ContentType: "application/pdf",
          }));
        }
        await documentClient.send(new PutCommand({
          TableName: tableName,
          Item: {
            dischargeId,
            createdAt,
            expiresAt,
            transcript: transcript.trim(),
            ...(pdfFile && {
              pdfKey,
              pdfOriginalName: pdfFile.originalname,
            }),
          },
        }));
      } catch (error) {
        console.error("Failed to save discharge record.", error);
        sendJson(response, 502, { error: "The discharge could not be saved. Please try again." });
        return;
      }

      sendJson(response, 201, {
        dischargeId,
        patientLink: `/ptView.html?id=${encodeURIComponent(dischargeId)}`,
      });
    },
  );

  app.get("/api/discharge/:id", async (request, response) => {
    if (!tableName) {
      sendJson(response, 503, {
        error: "Discharge storage is not configured: set DYNAMODB_TABLE_NAME on the server.",
      });
      return;
    }

    try {
      const result = await documentClient.send(new GetCommand({
        TableName: tableName,
        Key: { dischargeId: request.params.id },
      }));
      const record = result.Item;
      const expiresAt = Number(record?.expiresAt);
      if (!record || !Number.isFinite(expiresAt) || expiresAt <= Math.floor(now() / 1000)) {
        sendJson(response, 404, { error: "Discharge record not found or expired." });
        return;
      }

      const discharge = {
        dischargeId: record.dischargeId,
        transcript: record.transcript,
      };
      if (record.pdfKey) {
        if (!bucketName) {
          sendJson(response, 503, {
            error: "PDF storage is not configured: set S3_BUCKET_NAME on the server.",
          });
          return;
        }
        discharge.pdfUrl = await getSignedUrlImpl(
          objectClient,
          new GetObjectCommand({ Bucket: bucketName, Key: record.pdfKey }),
          { expiresIn: 3600 },
        );
        discharge.pdfOriginalName = record.pdfOriginalName;
      }
      sendJson(response, 200, discharge);
    } catch (error) {
      console.error("Failed to retrieve discharge record.", error);
      sendJson(response, 502, { error: "The discharge could not be loaded. Please try again." });
    }
  });

  app.post("/api/speak", express.json({ limit: "20kb" }), async (request, response) => {
    if (!apiKey || !voiceId) {
      sendJson(response, 503, { error: "Speech generation is not configured on the server." });
      return;
    }

    const text = request.body?.text;
    if (typeof text !== "string" || !text.trim()) {
      sendJson(response, 400, { error: "Provide non-empty patient text to read aloud." });
      return;
    }
    if (text.length > maxSpeechTextCharacters) {
      sendJson(response, 413, { error: `Text must be ${maxSpeechTextCharacters} characters or fewer.` });
      return;
    }

    let providerResponse;
    try {
      providerResponse = await fetchImpl(
        `${speechUrl}/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": apiKey,
          },
          body: JSON.stringify({ text: text.trim(), model_id: speechModelId }),
          signal: AbortSignal.timeout(60_000),
        },
      );
    } catch {
      sendJson(response, 502, { error: "The speech generation service could not be reached." });
      return;
    }

    if (!providerResponse.ok) {
      sendJson(response, 502, {
        error: "The speech generation service rejected the text.",
        providerStatus: providerResponse.status,
      });
      return;
    }

    try {
      const audio = Buffer.from(await providerResponse.arrayBuffer());
      if (audio.length === 0) {
        sendJson(response, 502, { error: "The speech generation service returned empty audio." });
        return;
      }
      response.status(200).set({
        "Cache-Control": "no-store",
        "Content-Type": "audio/mpeg",
        "X-Content-Type-Options": "nosniff",
      }).send(audio);
    } catch {
      sendJson(response, 502, { error: "The speech generation service returned invalid audio." });
    }
  });

  app.post(
    "/api/transcribe",
    express.raw({ type: () => true, limit: maxAudioBytes }),
    async (request, response) => {
      if (!apiKey) {
        sendJson(response, 503, { error: "Speech transcription is not configured on the server." });
        return;
      }
      const contentType = request.headers["content-type"] || "";
      const mediaType = contentType.split(";")[0].trim().toLowerCase();
      if (!mediaType.startsWith("audio/")) {
        sendJson(response, 415, { error: "Send audio bytes with an audio/* Content-Type." });
        return;
      }
      if (!request.body?.length) {
        sendJson(response, 400, { error: "The audio request body is empty." });
        return;
      }

      const form = new FormData();
      form.set("model_id", modelId);
      const extensionByMediaType = {
        "audio/aac": ".aac",
        "audio/flac": ".flac",
        "audio/mp4": ".mp4",
        "audio/mpeg": ".mp3",
        "audio/ogg": ".ogg",
        "audio/wav": ".wav",
        "audio/webm": ".webm",
        "audio/x-wav": ".wav",
      };
      form.set(
        "file",
        new Blob([request.body], { type: mediaType }),
        `recording${extensionByMediaType[mediaType] || ".audio"}`,
      );

      let providerResponse;
      try {
        providerResponse = await fetchImpl(transcriptionUrl, {
          method: "POST",
          headers: { "xi-api-key": apiKey },
          body: form,
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        sendJson(response, 502, { error: "The speech transcription service could not be reached." });
        return;
      }
      if (!providerResponse.ok) {
        sendJson(response, 502, {
          error: "The speech transcription service rejected the audio.",
          providerStatus: providerResponse.status,
        });
        return;
      }

      let result;
      try {
        result = await providerResponse.json();
      } catch {
        sendJson(response, 502, { error: "The speech transcription service returned an invalid response." });
        return;
      }
      if (typeof result.text !== "string") {
        sendJson(response, 502, { error: "The speech transcription service returned no transcript." });
        return;
      }
      sendJson(response, 200, { text: result.text });
    },
  );

  app.use("/api", (request, response) => {
    sendJson(response, 404, { error: "The requested API endpoint was not found." });
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (error?.type === "entity.too.large") {
      sendJson(response, 413, {
        error: request.path === "/api/transcribe"
          ? "Audio file exceeds the configured size limit."
          : "Request body exceeds the configured size limit.",
      });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      sendJson(response, 400, { error: "Request body must contain valid JSON." });
      return;
    }
    console.error("Unhandled request error.", error);
    sendJson(response, 500, { error: "The request could not be completed." });
  });

  return app;
}

export function createAppServer(options) {
  return createHttpServer(createApp(options));
}

export const handler = serverless(createApp());

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
