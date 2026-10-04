import express from "express";

import cors from "cors";

import crypto from "crypto";

import fs from "fs";

import path from "path";

import { fileURLToPath } from "url";

import { SMTPServer } from "smtp-server";

import { simpleParser } from "mailparser";

const app = express();

const HTTP_PORT =
  Number(process.env.PORT || 4000);

const SMTP_PORT =
  Number(
    process.env.SMTP_PORT || 2525
  );

const MAIL_DOMAIN =
  process.env.MAIL_DOMAIN ||
  "temp.local";

const TTL_MINUTES = 15;

const MAX_MESSAGE_BYTES =
  5 * 1024 * 1024;

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

const DATA_DIR =
  path.join(
    __dirname,
    "data"
  );

const DATA_FILE =
  path.join(
    DATA_DIR,
    "inboxes.json"
  );

app.use(cors());

app.use(
  express.json({
    limit: "1mb"
  })
);

/* =====================================================
   STORAGE
===================================================== */

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, {
      recursive: true
    });
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      "[]",
      "utf8"
    );
  }
}

function readInboxes() {
  ensureStorage();

  try {
    const content =
      fs.readFileSync(
        DATA_FILE,
        "utf8"
      );

    if (!content.trim()) {
      return [];
    }

    const parsed =
      JSON.parse(content);

    return Array.isArray(parsed)
      ? parsed
      : [];
  } catch (error) {
    console.error(
      "Storage read error:",
      error
    );

    return [];
  }
}

/*
 * Reliable atomic storage.
 *
 * A unique temporary filename prevents two
 * operations from fighting over the same .tmp file.
 */
function saveInboxes(inboxes) {
  ensureStorage();

  const temporaryFile =
    `${DATA_FILE}.${process.pid}.${Date.now()}.${crypto
      .randomBytes(4)
      .toString("hex")}.tmp`;

  try {
    fs.writeFileSync(
      temporaryFile,
      JSON.stringify(
        inboxes,
        null,
        2
      ),
      "utf8"
    );

    fs.renameSync(
      temporaryFile,
      DATA_FILE
    );
  } catch (error) {
    try {
      if (
        fs.existsSync(
          temporaryFile
        )
      ) {
        fs.unlinkSync(
          temporaryFile
        );
      }
    } catch (cleanupError) {
      console.error(
        "Storage temp-file cleanup error:",
        cleanupError
      );
    }

    throw error;
  }
}

/* =====================================================
   EXPIRATION
===================================================== */

function cleanupExpired() {
  const inboxes =
    readInboxes();

  const now =
    Date.now();

  const active =
    inboxes.filter(
      (inbox) =>
        new Date(
          inbox.expiresAt
        ).getTime() > now
    );

  if (
    active.length !==
    inboxes.length
  ) {
    saveInboxes(active);
  }

  return active;
}

setInterval(
  cleanupExpired,
  30 * 1000
);

/* =====================================================
   ADDRESS
===================================================== */

function generateAddress(
  inboxes
) {
  let address;

  do {
    const localPart =
      crypto
        .randomBytes(6)
        .toString("hex");

    address =
      `${localPart}@${MAIL_DOMAIN}`;
  } while (
    inboxes.some(
      (inbox) =>
        inbox.address ===
        address
    )
  );

  return address;
}

/* =====================================================
   HEALTH
===================================================== */

app.get(
  "/api/health",
  (_req, res) => {
    res.json({
      ok: true,
      service:
        "temp-mail-api",
      domain:
        MAIL_DOMAIN,
      smtpPort:
        SMTP_PORT,
      timestamp:
        new Date().toISOString()
    });
  }
);

/* =====================================================
   CREATE INBOX
===================================================== */

app.post(
  "/api/inboxes",
  (_req, res) => {
    try {
      const inboxes =
        cleanupExpired();

      const id =
        crypto.randomUUID();

      const createdAt =
        new Date();

      const expiresAt =
        new Date(
          createdAt.getTime() +
            TTL_MINUTES *
              60 *
              1000
        );

      const address =
        generateAddress(
          inboxes
        );

      const inbox = {
        id,

        address,

        createdAt:
          createdAt.toISOString(),

        expiresAt:
          expiresAt.toISOString(),

        messages: []
      };

      inboxes.push(
        inbox
      );

      saveInboxes(
        inboxes
      );

      res.status(201).json({
        inbox: {
          id,

          address,

          createdAt:
            inbox.createdAt,

          expiresAt:
            inbox.expiresAt
        }
      });
    } catch (error) {
      console.error(
        "Create inbox error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to create inbox"
      });
    }
  }
);

/* =====================================================
   GET MESSAGES
===================================================== */

app.get(
  "/api/inboxes/:id/messages",
  (req, res) => {
    try {
      const inboxes =
        cleanupExpired();

      const inbox =
        inboxes.find(
          (item) =>
            item.id ===
            req.params.id
        );

      if (!inbox) {
        return res
          .status(404)
          .json({
            error:
              "Inbox not found or expired"
          });
      }

      /*
       * Normalize older messages in memory.
       *
       * IMPORTANT:
       * This endpoint does not save the normalized
       * data back to disk. That keeps refreshes
       * read-only and avoids storage races.
       */
      const messages = (
        inbox.messages || []
      ).map(
        (message) => ({
          ...message,

          isRead:
            typeof message.isRead ===
            "boolean"
              ? message.isRead
              : false,

          attachments:
            Array.isArray(
              message.attachments
            )
              ? message.attachments.map(
                  (attachment) => ({
                    ...attachment,

                    id:
                      attachment.id ||
                      null,

                    downloadable:
                      Boolean(
                        attachment.contentBase64
                      )
                  })
                )
              : []
        })
      );

      res.json({
        inbox: {
          id:
            inbox.id,

          address:
            inbox.address,

          createdAt:
            inbox.createdAt,

          expiresAt:
            inbox.expiresAt
        },

        messages
      });
    } catch (error) {
      console.error(
        "Get messages error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to load messages"
      });
    }
  }
);

/* =====================================================
   GET SINGLE MESSAGE
===================================================== */

app.get(
  "/api/inboxes/:inboxId/messages/:messageId",
  (req, res) => {
    try {
      const inboxes =
        cleanupExpired();

      const inbox =
        inboxes.find(
          (item) =>
            item.id ===
            req.params.inboxId
        );

      if (!inbox) {
        return res
          .status(404)
          .json({
            error:
              "Inbox not found"
          });
      }

      const message =
        (
          inbox.messages || []
        ).find(
          (item) =>
            item.id ===
            req.params.messageId
        );

      if (!message) {
        return res
          .status(404)
          .json({
            error:
              "Message not found"
          });
      }

      res.json({
        message
      });
    } catch (error) {
      console.error(
        "Get single message error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to load message"
      });
    }
  }
);

/* =====================================================
   MARK MESSAGE AS READ
===================================================== */

app.patch(
  "/api/inboxes/:inboxId/messages/:messageId/read",
  (req, res) => {
    try {
      const inboxes =
        cleanupExpired();

      const inbox =
        inboxes.find(
          (item) =>
            item.id ===
            req.params.inboxId
        );

      if (!inbox) {
        return res
          .status(404)
          .json({
            error:
              "Inbox not found or expired"
          });
      }

      const message =
        (
          inbox.messages || []
        ).find(
          (item) =>
            item.id ===
            req.params.messageId
        );

      if (!message) {
        return res
          .status(404)
          .json({
            error:
              "Message not found"
          });
      }

      message.isRead =
        true;

      saveInboxes(
        inboxes
      );

      res.json({
        success: true,
        message
      });
    } catch (error) {
      console.error(
        "Mark read error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to mark message as read"
      });
    }
  }
);

/* =====================================================
   DELETE SINGLE MESSAGE
===================================================== */

app.delete(
  "/api/inboxes/:inboxId/messages/:messageId",
  (req, res) => {
    try {
      const inboxes =
        cleanupExpired();

      const inbox =
        inboxes.find(
          (item) =>
            item.id ===
            req.params.inboxId
        );

      if (!inbox) {
        return res
          .status(404)
          .json({
            error:
              "Inbox not found or expired"
          });
      }

      const messages =
        inbox.messages || [];

      const originalLength =
        messages.length;

      inbox.messages =
        messages.filter(
          (message) =>
            message.id !==
            req.params.messageId
        );

      if (
        inbox.messages.length ===
        originalLength
      ) {
        return res
          .status(404)
          .json({
            error:
              "Message not found"
          });
      }

      saveInboxes(
        inboxes
      );

      res.status(204).end();
    } catch (error) {
      console.error(
        "Delete message error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to delete message"
      });
    }
  }
);

/* =====================================================
   DOWNLOAD ATTACHMENT
===================================================== */

app.get(
  "/api/inboxes/:inboxId/messages/:messageId/attachments/:attachmentId",
  (req, res) => {
    try {
      const inboxes =
        cleanupExpired();

      const inbox =
        inboxes.find(
          (item) =>
            item.id ===
            req.params.inboxId
        );

      if (!inbox) {
        return res
          .status(404)
          .json({
            error:
              "Inbox not found or expired"
          });
      }

      const message =
        (
          inbox.messages || []
        ).find(
          (item) =>
            item.id ===
            req.params.messageId
        );

      if (!message) {
        return res
          .status(404)
          .json({
            error:
              "Message not found"
          });
      }

      const attachment =
        (
          message.attachments ||
          []
        ).find(
          (item) =>
            item.id ===
            req.params.attachmentId
        );

      if (!attachment) {
        return res
          .status(404)
          .json({
            error:
              "Attachment not found"
          });
      }

      if (
        !attachment.contentBase64
      ) {
        return res
          .status(404)
          .json({
            error:
              "Attachment content is not available"
          });
      }

      const content =
        Buffer.from(
          attachment.contentBase64,
          "base64"
        );

      res.setHeader(
        "Content-Type",
        attachment.contentType ||
          "application/octet-stream"
      );

      res.setHeader(
        "Content-Length",
        content.length
      );

      const safeFilename =
        String(
          attachment.filename ||
            "attachment"
        ).replace(
          /["\r\n]/g,
          "_"
        );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeFilename}"`
      );

      res.send(
        content
      );
    } catch (error) {
      console.error(
        "Attachment download error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to download attachment"
      });
    }
  }
);

/* =====================================================
   DELETE INBOX
===================================================== */

app.delete(
  "/api/inboxes/:id",
  (req, res) => {
    try {
      const inboxes =
        cleanupExpired();

      const filtered =
        inboxes.filter(
          (item) =>
            item.id !==
            req.params.id
        );

      if (
        filtered.length ===
        inboxes.length
      ) {
        return res
          .status(404)
          .json({
            error:
              "Inbox not found"
          });
      }

      saveInboxes(
        filtered
      );

      res.status(204).end();
    } catch (error) {
      console.error(
        "Delete inbox error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to delete inbox"
      });
    }
  }
);

/* =====================================================
   DEVELOPMENT MESSAGE
===================================================== */

app.post(
  "/api/dev/inboxes/:id/messages",
  (req, res) => {
    try {
      const inboxes =
        cleanupExpired();

      const inbox =
        inboxes.find(
          (item) =>
            item.id ===
            req.params.id
        );

      if (!inbox) {
        return res
          .status(404)
          .json({
            error:
              "Inbox not found or expired"
          });
      }

      const message = {
        id:
          crypto.randomUUID(),

        from:
          req.body.from ||
          "demo@example.com",

        to:
          inbox.address,

        subject:
          req.body.subject ||
          "Test message",

        body:
          req.body.body ||
          "This is a development test message.",

        html: null,

        receivedAt:
          new Date().toISOString(),

        isRead: false,

        attachments: []
      };

      if (!inbox.messages) {
        inbox.messages = [];
      }

      inbox.messages.unshift(
        message
      );

      saveInboxes(
        inboxes
      );

      res.status(201).json({
        message
      });
    } catch (error) {
      console.error(
        "Development message error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to create test message"
      });
    }
  }
);

/* =====================================================
   SMTP HELPERS
===================================================== */

function normalizeEmail(
  value
) {
  if (!value) {
    return "";
  }

  return String(value)
    .trim()
    .toLowerCase();
}

function getEmailAddress(
  addressObject
) {
  if (!addressObject) {
    return "";
  }

  if (
    Array.isArray(
      addressObject.value
    )
  ) {
    return normalizeEmail(
      addressObject.value[0]
        ?.address
    );
  }

  return "";
}

/* =====================================================
   SMTP SERVER
===================================================== */

const smtpServer =
  new SMTPServer({
    name:
      `mail.${MAIL_DOMAIN}`,

    banner:
      "Temp Mail SMTP Service",

    authOptional: true,

    disabledCommands: [
      "AUTH"
    ],

    size:
      MAX_MESSAGE_BYTES,

    hideSTARTTLS: true,

    onConnect(
      session,
      callback
    ) {
      console.log(
        `[SMTP] Connection from ${session.remoteAddress}`
      );

      callback();
    },

    onMailFrom(
      address,
      session,
      callback
    ) {
      const sender =
        normalizeEmail(
          address.address
        );

      if (!sender) {
        const error =
          new Error(
            "Invalid sender"
          );

        error.responseCode =
          550;

        return callback(
          error
        );
      }

      callback();
    },

    onRcptTo(
      address,
      session,
      callback
    ) {
      const recipient =
        normalizeEmail(
          address.address
        );

      const expectedSuffix =
        `@${MAIL_DOMAIN.toLowerCase()}`;

      if (
        !recipient.endsWith(
          expectedSuffix
        )
      ) {
        const error =
          new Error(
            "Recipient domain is not accepted"
          );

        error.responseCode =
          550;

        return callback(
          error
        );
      }

      const inboxes =
        cleanupExpired();

      const inbox =
        inboxes.find(
          (item) =>
            normalizeEmail(
              item.address
            ) ===
            recipient
        );

      if (!inbox) {
        const error =
          new Error(
            "Temporary inbox does not exist or has expired"
          );

        error.responseCode =
          550;

        return callback(
          error
        );
      }

      callback();
    },

    onData(
      stream,
      session,
      callback
    ) {
      const chunks = [];

      let totalBytes = 0;

      stream.on(
        "data",
        (chunk) => {
          totalBytes +=
            chunk.length;

          if (
            totalBytes <=
            MAX_MESSAGE_BYTES
          ) {
            chunks.push(chunk);
          }
        }
      );

      stream.on(
        "end",
        async () => {
          try {
            if (
              stream.sizeExceeded ||
              totalBytes >
                MAX_MESSAGE_BYTES
            ) {
              const error =
                new Error(
                  "Email is too large"
                );

              error.responseCode =
                552;

              return callback(
                error
              );
            }

            const rawEmail =
              Buffer.concat(
                chunks
              );

            const parsed =
              await simpleParser(
                rawEmail
              );

            const recipient =
              getEmailAddress(
                parsed.to
              );

            const normalizedRecipient =
              normalizeEmail(
                recipient
              );

            const inboxes =
              cleanupExpired();

            const inbox =
              inboxes.find(
                (item) =>
                  normalizeEmail(
                    item.address
                  ) ===
                  normalizedRecipient
              );

            if (!inbox) {
              const error =
                new Error(
                  "Inbox expired or does not exist"
                );

              error.responseCode =
                550;

              return callback(
                error
              );
            }

            const sender =
              getEmailAddress(
                parsed.from
              ) ||
              "unknown@unknown";

            const text =
              typeof parsed.text ===
              "string"
                ? parsed.text
                : "";

            const html =
              typeof parsed.html ===
              "string"
                ? parsed.html
                : null;

            /*
             * Store attachment content as base64
             * so it can be downloaded later.
             */
            const attachments =
              Array.isArray(
                parsed.attachments
              )
                ? parsed.attachments.map(
                    (attachment) => ({
                      id:
                        crypto.randomUUID(),

                      filename:
                        attachment.filename ||
                        "attachment",

                      contentType:
                        attachment.contentType ||
                        "application/octet-stream",

                      size:
                        attachment.size ||
                        0,

                      contentBase64:
                        Buffer.isBuffer(
                          attachment.content
                        )
                          ? attachment.content.toString(
                              "base64"
                            )
                          : null
                    })
                  )
                : [];

            const message = {
              id:
                crypto.randomUUID(),

              from:
                sender,

              to:
                normalizedRecipient,

              subject:
                parsed.subject ||
                "(No subject)",

              body:
                text,

              html,

              receivedAt:
                new Date().toISOString(),

              isRead: false,

              attachments
            };

            if (
              !inbox.messages
            ) {
              inbox.messages = [];
            }

            inbox.messages.unshift(
              message
            );

            saveInboxes(
              inboxes
            );

            console.log(
              `[SMTP] Email received: ${sender} -> ${normalizedRecipient}`
            );

            console.log(
              `[SMTP] Subject: ${message.subject}`
            );

            if (
              attachments.length > 0
            ) {
              console.log(
                `[SMTP] Attachments: ${attachments.length}`
              );
            }

            callback(
              null,
              "Message accepted"
            );
          } catch (error) {
            console.error(
              "[SMTP] Message processing error:",
              error
            );

            error.responseCode =
              451;

            callback(error);
          }
        }
      );

      stream.on(
        "error",
        (error) => {
          console.error(
            "[SMTP] Stream error:",
            error
          );

          callback(error);
        }
      );
    }
  });

smtpServer.on(
  "error",
  (error) => {
    console.error(
      "[SMTP] Server error:",
      error
    );
  }
);

/* =====================================================
   START
===================================================== */

ensureStorage();

app.listen(
  HTTP_PORT,
  () => {
    console.log("");

    console.log(
      "========================================"
    );

    console.log(
      "          TEMP MAIL API"
    );

    console.log(
      "========================================"
    );

    console.log(
      `HTTP: http://localhost:${HTTP_PORT}`
    );

    console.log(
      `Health: http://localhost:${HTTP_PORT}/api/health`
    );

    console.log(
      `Domain: ${MAIL_DOMAIN}`
    );

    console.log(
      "========================================"
    );

    console.log("");
  }
);

smtpServer.listen(
  SMTP_PORT,
  "0.0.0.0",
  () => {
    console.log(
      `[SMTP] Listening on port ${SMTP_PORT}`
    );

    console.log(
      `[SMTP] Accepted domain: ${MAIL_DOMAIN}`
    );

    console.log("");

    console.log(
      "Phase 2 mail receiver is ready."
    );

    console.log("");
  }
);