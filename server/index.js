import express from "express";
import cors from "cors";
import crypto from "crypto";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

const app = express();

function envValue(name, fallback = "") {
  const value = process.env[name];

  if (value === undefined || value === null) {
    return fallback;
  }

  const trimmed = String(value).trim();

  return trimmed || fallback;
}

const HTTP_PORT = Number(envValue("PORT", "4000"));
const SMTP_PORT = Number(envValue("SMTP_PORT", "2525"));

/*
=====================================================
CONFIGURATION
=====================================================
*/

const MAIL_DOMAIN =
  envValue("MAIL_DOMAIN", "temp.local");

const TTL_MINUTES = 15;

const MAX_MESSAGE_BYTES =
  5 * 1024 * 1024;

const RESEND_API_KEY =
  envValue("RESEND_API_KEY");

const RESEND_WEBHOOK_SECRET =
  envValue("RESEND_WEBHOOK_SECRET");

const SUPABASE_URL =
  envValue("SUPABASE_URL");

const SUPABASE_SECRET_KEY =
  envValue("SUPABASE_SECRET_KEY");

if (!SUPABASE_URL) {
  console.error(
    "Missing SUPABASE_URL environment variable."
  );
  process.exit(1);
}

if (!SUPABASE_SECRET_KEY) {
  console.error(
    "Missing SUPABASE_SECRET_KEY environment variable."
  );
  process.exit(1);
}

/*
=====================================================
SUPABASE
=====================================================
*/

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  }
);

/*
=====================================================
RESEND
=====================================================
*/

const resend = RESEND_API_KEY
  ? new Resend(RESEND_API_KEY)
  : null;

/*
=====================================================
EXPRESS
=====================================================
*/

app.use(cors());

/*
IMPORTANT:
The Resend webhook route MUST come before
express.json() because Resend signature verification
requires the original raw request body.
*/

/*
=====================================================
HELPERS
=====================================================
*/

function normalizeEmail(value) {
  if (!value) {
    return "";
  }

  return String(value)
    .trim()
    .toLowerCase();
}

function extractEmailAddress(value) {
  if (!value) {
    return "";
  }

  const text = String(value).trim();

  const match =
    text.match(/<([^<>@\s]+@[^<>@\s]+)>/);

  if (match) {
    return normalizeEmail(match[1]);
  }

  const directMatch =
    text.match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
    );

  if (directMatch) {
    return normalizeEmail(directMatch[0]);
  }

  return normalizeEmail(text);
}

function collectEmailAddresses(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectEmailAddresses);
  }

  if (typeof value === "object") {
    return collectEmailAddresses(
      value.email ||
        value.address ||
        value.mail ||
        value.value ||
        ""
    );
  }

  const address = extractEmailAddress(value);

  return address ? [address] : [];
}

function safeErrorMessage(error) {
  if (!error) {
    return "Unknown error";
  }

  return (
    error.message ||
    error.details ||
    error.hint ||
    "Unknown error"
  );
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

/*
=====================================================
DATABASE HELPERS
=====================================================
*/

async function cleanupExpired() {
  try {
    const now =
      new Date().toISOString();

    const { error } =
      await supabase
        .from("inboxes")
        .delete()
        .lt("expires_at", now);

    if (error) {
      console.error(
        "Supabase cleanup error:",
        error
      );
    }
  } catch (error) {
    console.error(
      "Cleanup exception:",
      error
    );
  }
}

async function getInboxById(id) {
  const { data, error } =
    await supabase
      .from("inboxes")
      .select("*")
      .eq("id", id)
      .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function getInboxByAddress(address) {
  const normalizedAddress =
    normalizeEmail(address);

  const { data, error } =
    await supabase
      .from("inboxes")
      .select("*")
      .eq("address", normalizedAddress)
      .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function getMessagesForInbox(inboxId) {
  const { data: messages, error } =
    await supabase
      .from("messages")
      .select("*")
      .eq("inbox_id", inboxId)
      .order("received_at", {
        ascending: false
      });

  if (error) {
    throw error;
  }

  const messageRows =
    Array.isArray(messages)
      ? messages
      : [];

  if (messageRows.length === 0) {
    return [];
  }

  const messageIds =
    messageRows.map(
      (message) => message.id
    );

  const {
    data: attachments,
    error: attachmentError
  } = await supabase
    .from("attachments")
    .select(
      "id, message_id, filename, content_type, size, content_base64"
    )
    .in(
      "message_id",
      messageIds
    );

  if (attachmentError) {
    throw attachmentError;
  }

  const attachmentRows =
    Array.isArray(attachments)
      ? attachments
      : [];

  const attachmentsByMessage =
    new Map();

  for (const attachment of attachmentRows) {
    if (
      !attachmentsByMessage.has(
        attachment.message_id
      )
    ) {
      attachmentsByMessage.set(
        attachment.message_id,
        []
      );
    }

    attachmentsByMessage
      .get(attachment.message_id)
      .push({
        id: attachment.id,
        filename: attachment.filename,
        contentType:
          attachment.content_type,
        size:
          attachment.size || 0,
        downloadable:
          Boolean(
            attachment.content_base64
          )
      });
  }

  return messageRows.map(
    (message) => ({
      id: message.id,

      from:
        message.from_email,

      to:
        message.to_email,

      subject:
        message.subject,

      body:
        message.body,

      html:
        message.html,

      receivedAt:
        message.received_at,

      isRead:
        Boolean(message.is_read),

      attachments:
        attachmentsByMessage.get(
          message.id
        ) || []
    })
  );
}

async function getSingleMessage(
  inboxId,
  messageId
) {
  const { data: message, error } =
    await supabase
      .from("messages")
      .select("*")
      .eq("id", messageId)
      .eq("inbox_id", inboxId)
      .maybeSingle();

  if (error) {
    throw error;
  }

  if (!message) {
    return null;
  }

  const {
    data: attachments,
    error: attachmentError
  } = await supabase
    .from("attachments")
    .select(
      "id, message_id, filename, content_type, size, content_base64"
    )
    .eq(
      "message_id",
      messageId
    );

  if (attachmentError) {
    throw attachmentError;
  }

  return {
    id: message.id,

    from:
      message.from_email,

    to:
      message.to_email,

    subject:
      message.subject,

    body:
      message.body,

    html:
      message.html,

    receivedAt:
      message.received_at,

    isRead:
      Boolean(message.is_read),

    attachments:
      (attachments || []).map(
        (attachment) => ({
          id: attachment.id,
          filename:
            attachment.filename,
          contentType:
            attachment.content_type,
          size:
            attachment.size || 0,
          downloadable:
            Boolean(
              attachment.content_base64
            )
        })
      )
  };
}

async function storeResendAttachments(
  emailId,
  messageId
) {
  let attachmentCount = 0;

  try {
    const {
      data: attachmentList,
      error: attachmentListError
    } =
      await resend
        .emails
        .receiving
        .attachments
        .list({
          emailId
        });

    if (attachmentListError) {
      console.error(
        "[RESEND] Attachment list error:",
        attachmentListError
      );

      return attachmentCount;
    }

    const attachments =
      Array.isArray(
        attachmentList?.data
      )
        ? attachmentList.data
        : [];

    if (attachments.length === 0) {
      return attachmentCount;
    }

    const attachmentRows = [];
    let totalAttachmentBytes = 0;

    for (const attachment of attachments) {
      const size =
        Number(
          attachment.size || 0
        );

      if (
        totalAttachmentBytes + size >
        MAX_MESSAGE_BYTES
      ) {
        console.warn(
          `[RESEND] Skipping attachment because total size exceeds ${MAX_MESSAGE_BYTES} bytes.`
        );

        continue;
      }

      let contentBase64 = null;

      if (attachment.download_url) {
        try {
          const response =
            await fetch(
              attachment.download_url
            );

          if (response.ok) {
            const buffer =
              Buffer.from(
                await response.arrayBuffer()
              );

            if (
              buffer.length <=
              MAX_MESSAGE_BYTES
            ) {
              contentBase64 =
                buffer.toString(
                  "base64"
                );

              totalAttachmentBytes +=
                buffer.length;
            }
          } else {
            console.error(
              `[RESEND] Attachment download failed: ${response.status}`
            );
          }
        } catch (
          attachmentDownloadError
        ) {
          console.error(
            "[RESEND] Attachment download error:",
            attachmentDownloadError
          );
        }
      }

      attachmentRows.push({
        id:
          crypto.randomUUID(),

        message_id:
          messageId,

        filename:
          attachment.filename ||
          "attachment",

        content_type:
          attachment.content_type ||
          "application/octet-stream",

        size,

        content_base64:
          contentBase64
      });
    }

    if (attachmentRows.length === 0) {
      return attachmentCount;
    }

    const {
      error: attachmentInsertError
    } =
      await supabase
        .from("attachments")
        .insert(attachmentRows);

    if (attachmentInsertError) {
      throw attachmentInsertError;
    }

    attachmentCount =
      attachmentRows.length;
  } catch (attachmentError) {
    /*
    If attachment processing fails, keep the email
    itself. The user should still be able to read it.
    */

    console.error(
      "[RESEND] Attachment processing error:",
      attachmentError
    );
  }

  return attachmentCount;
}

async function storeResendReceivedEmail(
  emailId,
  eventData = {}
) {
  if (!resend) {
    throw new Error(
      "Resend is not configured"
    );
  }

  if (!emailId) {
    throw new Error(
      "Resend email ID is missing"
    );
  }

  const {
    data: receivedEmail,
    error: receivedEmailError
  } =
    await resend.emails.receiving.get(
      emailId
    );

  if (receivedEmailError) {
    throw receivedEmailError;
  }

  if (!receivedEmail) {
    throw new Error(
      "Received email data is empty"
    );
  }

  const normalizedRecipients =
    [
      ...new Set([
        ...collectEmailAddresses(
          eventData?.to
        ),
        ...collectEmailAddresses(
          receivedEmail?.to
        ),
        ...collectEmailAddresses(
          receivedEmail?.received_for
        )
      ])
    ].filter(Boolean);

  let inbox = null;

  for (const recipient of normalizedRecipients) {
    const possibleInbox =
      await getInboxByAddress(recipient);

    if (possibleInbox) {
      inbox = possibleInbox;
      break;
    }
  }

  if (!inbox) {
    return {
      stored: false,
      reason:
        "Temporary inbox not found",
      recipients:
        normalizedRecipients
    };
  }

  const expiresAt =
    new Date(
      inbox.expires_at
    ).getTime();

  if (expiresAt <= Date.now()) {
    return {
      stored: false,
      reason:
        "Temporary inbox expired",
      inbox:
        inbox.address
    };
  }

  if (isUuid(emailId)) {
    const existingMessage =
      await getSingleMessage(
        inbox.id,
        emailId
      );

    if (existingMessage) {
      return {
        stored: true,
        duplicate: true,
        messageId:
          emailId,
        inboxId:
          inbox.id,
        inbox:
          inbox.address
      };
    }
  }

  const messageId =
    isUuid(emailId)
      ? emailId
      : crypto.randomUUID();

  const sender =
    extractEmailAddress(
      receivedEmail.from ||
        eventData?.from ||
        "unknown@unknown"
    ) ||
    "unknown@unknown";

  const recipient =
    normalizedRecipients.find(
      (address) =>
        address ===
        normalizeEmail(inbox.address)
    ) ||
    inbox.address;

  const subject =
    receivedEmail.subject ||
    eventData?.subject ||
    "(No subject)";

  const body =
    typeof receivedEmail.text ===
    "string"
      ? receivedEmail.text
      : "";

  const html =
    typeof receivedEmail.html ===
    "string"
      ? receivedEmail.html
      : null;

  const receivedAt =
    receivedEmail.created_at ||
    eventData?.created_at ||
    new Date().toISOString();

  const {
    error: messageError
  } =
    await supabase
      .from("messages")
      .insert({
        id:
          messageId,

        inbox_id:
          inbox.id,

        from_email:
          sender,

        to_email:
          recipient,

        subject,

        body,

        html,

        received_at:
          receivedAt,

        is_read:
          false
      });

  if (messageError) {
    if (messageError.code === "23505") {
      return {
        stored: true,
        duplicate: true,
        messageId,
        inboxId:
          inbox.id,
        inbox:
          inbox.address
      };
    }

    throw messageError;
  }

  const attachmentCount =
    await storeResendAttachments(
      emailId,
      messageId
    );

  return {
    stored: true,
    duplicate: false,
    messageId,
    inboxId:
      inbox.id,
    inbox:
      inbox.address,
    from:
      sender,
    to:
      recipient,
    subject,
    attachments:
      attachmentCount
  };
}

/*
=====================================================
INBOX GENERATION
=====================================================
*/

function generateAddress() {
  const localPart =
    crypto
      .randomBytes(6)
      .toString("hex");

  return normalizeEmail(
    `${localPart}@${MAIL_DOMAIN}`
  );
}

async function generateUniqueAddress() {
  for (
    let attempt = 0;
    attempt < 20;
    attempt++
  ) {
    const address =
      generateAddress();

    const { data, error } =
      await supabase
        .from("inboxes")
        .select("id")
        .eq("address", address)
        .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return address;
    }
  }

  throw new Error(
    "Unable to generate a unique email address"
  );
}

function mapInbox(inbox) {
  return {
    id: inbox.id,

    address:
      inbox.address,

    createdAt:
      inbox.created_at,

    expiresAt:
      inbox.expires_at
  };
}

/*
=====================================================
HEALTH
=====================================================
*/

app.get(
  "/api/health",
  async (_req, res) => {
    try {
      const { error } =
        await supabase
          .from("inboxes")
          .select("id")
          .limit(1);

      if (error) {
        console.error(
          "Health database error:",
          error
        );

        return res
          .status(503)
          .json({
            ok: false,
            service:
              "temp-mail-api",
            database: "error",
            error:
              "Database connection failed",
            timestamp:
              new Date().toISOString()
          });
      }

      res.json({
        ok: true,

        service:
          "temp-mail-api",

        database:
          "supabase",

        domain:
          MAIL_DOMAIN,

        smtpPort:
          SMTP_PORT,

        resend:
          Boolean(resend),

        webhookConfigured:
          Boolean(
            RESEND_WEBHOOK_SECRET
          ),

        timestamp:
          new Date().toISOString()
      });
    } catch (error) {
      console.error(
        "Health check error:",
        error
      );

      res
        .status(503)
        .json({
          ok: false,
          service:
            "temp-mail-api",
          database: "error",
          timestamp:
            new Date().toISOString()
        });
    }
  }
);

/*
=====================================================
RESEND WEBHOOK
=====================================================
*/

app.post(
  "/api/webhooks/resend",
  express.raw({
    type: "application/json",
    limit: "1mb"
  }),
  async (req, res) => {
    try {
      if (!resend) {
        console.error(
          "[RESEND] RESEND_API_KEY is missing."
        );

        return res
          .status(503)
          .json({
            error:
              "Resend is not configured"
          });
      }

      if (!RESEND_WEBHOOK_SECRET) {
        console.error(
          "[RESEND] RESEND_WEBHOOK_SECRET is missing."
        );

        return res
          .status(503)
          .json({
            error:
              "Resend webhook secret is not configured"
          });
      }

      const rawBody =
        Buffer.isBuffer(req.body)
          ? req.body.toString("utf8")
          : String(req.body || "");

      const webhookId =
        req.get("webhook-id") ||
        req.get("svix-id");

      const webhookTimestamp =
        req.get("webhook-timestamp") ||
        req.get("svix-timestamp");

      const webhookSignature =
        req.get("webhook-signature") ||
        req.get("svix-signature");

      if (
        !webhookId ||
        !webhookTimestamp ||
        !webhookSignature
      ) {
        console.error(
          "[RESEND] Missing webhook signature headers."
        );

        return res
          .status(400)
          .json({
            error:
              "Missing webhook signature"
          });
      }

      let event;

      try {
        event =
          resend.webhooks.verify({
            payload: rawBody,

            headers: {
              id: webhookId,
              timestamp:
                webhookTimestamp,
              signature:
                webhookSignature
            },

            webhookSecret:
              RESEND_WEBHOOK_SECRET
          });
      } catch (error) {
        console.error(
          "[RESEND] Invalid webhook signature:",
          safeErrorMessage(error)
        );

        return res
          .status(400)
          .json({
            error:
              "Invalid webhook signature"
          });
      }

      console.log(
        `[RESEND] Webhook received: ${event.type}`
      );

      if (
        event.type !==
        "email.received"
      ) {
        return res.json({
          received: true,
          ignored: true,
          type: event.type
        });
      }

      const emailId =
        event?.data?.email_id;

      if (!emailId) {
        console.error(
          "[RESEND] email_id missing."
        );

        return res
          .status(400)
          .json({
            error:
              "email_id missing"
          });
      }

      const result =
        await storeResendReceivedEmail(
          emailId,
          event.data || {}
        );

      if (!result.stored) {
        console.warn(
          "[RESEND] Email received but not stored:",
          result
        );

        return res.json({
          received: true,
          stored: false,
          reason:
            result.reason,
          recipients:
            result.recipients
        });
      }

      if (result.duplicate) {
        console.log(
          `[RESEND] Duplicate webhook ignored: ${emailId}`
        );

        return res.json({
          received: true,
          stored: true,
          duplicate: true,
          messageId:
            result.messageId,
          inboxId:
            result.inboxId
        });
      }

      console.log(
        `[RESEND] Email received: ${result.from} -> ${result.to}`
      );

      console.log(
        `[RESEND] Subject: ${result.subject}`
      );

      console.log(
        `[RESEND] Message ID: ${result.messageId}`
      );

      console.log(
        `[RESEND] Attachments: ${result.attachments || 0}`
      );

      return res.json({
        received: true,
        stored: true,
        messageId:
          result.messageId,
        inboxId:
          result.inboxId,
        attachments:
          result.attachments || 0
      });

      /*
      =================================================
      GET FULL EMAIL FROM RESEND
      =================================================
      */

      const {
        data: receivedEmail,
        error: receivedEmailError
      } =
        await resend.emails.receiving.get(
          emailId
        );

      if (receivedEmailError) {
        console.error(
          "[RESEND] Failed to retrieve email:",
          receivedEmailError
        );

        return res
          .status(500)
          .json({
            error:
              "Failed to retrieve received email"
          });
      }

      if (!receivedEmail) {
        return res
          .status(500)
          .json({
            error:
              "Received email data is empty"
          });
      }

      /*
      =================================================
      FIND OUR TEMP MAIL INBOX
      =================================================
      */

      const possibleRecipients = [];

      if (
        Array.isArray(
          event?.data?.to
        )
      ) {
        possibleRecipients.push(
          ...event.data.to
        );
      }

      if (
        Array.isArray(
          receivedEmail?.to
        )
      ) {
        possibleRecipients.push(
          ...receivedEmail.to
        );
      }

      if (
        Array.isArray(
          receivedEmail?.received_for
        )
      ) {
        possibleRecipients.push(
          ...receivedEmail.received_for
        );
      }

      const normalizedRecipients =
        [
          ...new Set(
            possibleRecipients
              .map(
                extractEmailAddress
              )
              .filter(Boolean)
          )
        ];

      let inbox = null;

      for (
        const recipient of
        normalizedRecipients
      ) {
        const possibleInbox =
          await getInboxByAddress(
            recipient
          );

        if (possibleInbox) {
          inbox =
            possibleInbox;
          break;
        }
      }

      if (!inbox) {
        console.warn(
          "[RESEND] No matching temporary inbox found.",
          normalizedRecipients
        );

        /*
        Return 200 because Resend successfully
        delivered the event. Retrying will not
        create an inbox that doesn't exist.
        */

        return res.json({
          received: true,
          stored: false,
          reason:
            "Temporary inbox not found"
        });
      }

      /*
      =================================================
      CHECK EXPIRATION
      =================================================
      */

      const expiresAt =
        new Date(
          inbox.expires_at
        ).getTime();

      if (
        expiresAt <=
        Date.now()
      ) {
        console.log(
          `[RESEND] Inbox expired: ${inbox.address}`
        );

        return res.json({
          received: true,
          stored: false,
          reason:
            "Temporary inbox expired"
        });
      }

      /*
      =================================================
      DUPLICATE PROTECTION
      =================================================

      Resend can retry webhook deliveries.

      Resend email IDs are UUIDs, so we use the
      Resend email ID as the database message ID.
      This means the existing primary-key column
      gives us natural duplicate protection.
      */

      if (isUuid(emailId)) {
        const existingMessage =
          await getSingleMessage(
            inbox.id,
            emailId
          );

        if (existingMessage) {
          console.log(
            `[RESEND] Duplicate webhook ignored: ${emailId}`
          );

          return res.json({
            received: true,
            stored: true,
            duplicate: true
          });
        }
      }

      /*
      =================================================
      MESSAGE DATA
      =================================================
      */

      const messageId =
        isUuid(emailId)
          ? emailId
          : crypto.randomUUID();

      const sender =
        extractEmailAddress(
          receivedEmail.from ||
            event?.data?.from ||
            "unknown@unknown"
        ) ||
        "unknown@unknown";

      const recipient =
        normalizedRecipients.find(
          (address) =>
            address ===
            normalizeEmail(
              inbox.address
            )
        ) ||
        inbox.address;

      const subject =
        receivedEmail.subject ||
        event?.data?.subject ||
        "(No subject)";

      const body =
        typeof receivedEmail.text ===
        "string"
          ? receivedEmail.text
          : "";

      const html =
        typeof receivedEmail.html ===
        "string"
          ? receivedEmail.html
          : null;

      const receivedAt =
        receivedEmail.created_at ||
        event?.data?.created_at ||
        new Date().toISOString();

      const messageRow = {
        id:
          messageId,

        inbox_id:
          inbox.id,

        from_email:
          sender,

        to_email:
          recipient,

        subject:
          subject,

        body:
          body,

        html:
          html,

        received_at:
          receivedAt,

        is_read:
          false
      };

      /*
      =================================================
      SAVE MESSAGE
      =================================================
      */

      const {
        data: insertedMessage,
        error: messageError
      } =
        await supabase
          .from("messages")
          .insert(
            messageRow
          )
          .select()
          .single();

      if (messageError) {
        /*
        PostgreSQL duplicate key.
        This can happen if Resend retries while
        the first request has already stored it.
        */

        if (
          messageError.code ===
          "23505"
        ) {
          console.log(
            `[RESEND] Duplicate message ignored: ${messageId}`
          );

          return res.json({
            received: true,
            stored: true,
            duplicate: true
          });
        }

        throw messageError;
      }

      /*
      =================================================
      ATTACHMENTS
      =================================================
      */

      let attachmentCount = 0;

      try {
        const {
          data: attachmentList,
          error:
            attachmentListError
        } =
          await resend
            .emails
            .receiving
            .attachments
            .list({
              emailId
            });

        if (
          attachmentListError
        ) {
          console.error(
            "[RESEND] Attachment list error:",
            attachmentListError
          );
        } else {
          const attachments =
            Array.isArray(
              attachmentList?.data
            )
              ? attachmentList.data
              : [];

          if (
            attachments.length > 0
          ) {
            const attachmentRows =
              [];

            let totalAttachmentBytes =
              0;

            for (
              const attachment of
              attachments
            ) {
              const size =
                Number(
                  attachment.size ||
                    0
                );

              /*
              Do not allow attachments to push
              this service beyond the 5 MB message
              storage limit.
              */

              if (
                totalAttachmentBytes +
                  size >
                MAX_MESSAGE_BYTES
              ) {
                console.warn(
                  `[RESEND] Skipping attachment because total size exceeds ${MAX_MESSAGE_BYTES} bytes.`
                );

                continue;
              }

              let contentBase64 =
                null;

              /*
              The Receiving API provides a
              temporary download URL.
              */

              if (
                attachment.download_url
              ) {
                try {
                  const response =
                    await fetch(
                      attachment.download_url
                    );

                  if (
                    response.ok
                  ) {
                    const buffer =
                      Buffer.from(
                        await response.arrayBuffer()
                      );

                    if (
                      buffer.length <=
                      MAX_MESSAGE_BYTES
                    ) {
                      contentBase64 =
                        buffer.toString(
                          "base64"
                        );

                      totalAttachmentBytes +=
                        buffer.length;
                    }
                  } else {
                    console.error(
                      `[RESEND] Attachment download failed: ${response.status}`
                    );
                  }
                } catch (
                  attachmentDownloadError
                ) {
                  console.error(
                    "[RESEND] Attachment download error:",
                    attachmentDownloadError
                  );
                }
              }

              attachmentRows.push({
                id:
                  crypto.randomUUID(),

                message_id:
                  messageId,

                filename:
                  attachment.filename ||
                  "attachment",

                content_type:
                  attachment.content_type ||
                  "application/octet-stream",

                size:
                  size,

                content_base64:
                  contentBase64
              });
            }

            if (
              attachmentRows.length >
              0
            ) {
              const {
                error:
                  attachmentInsertError
              } =
                await supabase
                  .from("attachments")
                  .insert(
                    attachmentRows
                  );

              if (
                attachmentInsertError
              ) {
                throw attachmentInsertError;
              }

              attachmentCount =
                attachmentRows.length;
            }
          }
        }
      } catch (
        attachmentError
      ) {
        /*
        If attachment processing fails,
        keep the email itself. The user should
        still be able to read the email.
        */

        console.error(
          "[RESEND] Attachment processing error:",
          attachmentError
        );
      }

      console.log(
        `[RESEND] Email received: ${sender} -> ${recipient}`
      );

      console.log(
        `[RESEND] Subject: ${subject}`
      );

      console.log(
        `[RESEND] Message ID: ${messageId}`
      );

      console.log(
        `[RESEND] Attachments: ${attachmentCount}`
      );

      return res.json({
        received: true,
        stored: true,
        messageId,
        inboxId:
          inbox.id,
        attachments:
          attachmentCount
      });
    } catch (error) {
      console.error(
        "[RESEND] Webhook processing error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Webhook processing failed"
        });
    }
  }
);

/*
=====================================================
JSON BODY PARSER
=====================================================
*/

app.use(
  express.json({
    limit: "1mb"
  })
);

/*
=====================================================
CREATE INBOX
=====================================================
*/

app.post(
  "/api/inboxes",
  async (_req, res) => {
    try {
      await cleanupExpired();

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
        await generateUniqueAddress();

      const {
        data,
        error
      } =
        await supabase
          .from("inboxes")
          .insert({
            id,

            address,

            created_at:
              createdAt.toISOString(),

            expires_at:
              expiresAt.toISOString()
          })
          .select()
          .single();

      if (error) {
        throw error;
      }

      res
        .status(201)
        .json({
          inbox:
            mapInbox(data)
        });
    } catch (error) {
      console.error(
        "Create inbox error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Failed to create inbox"
        });
    }
  }
);

/*
=====================================================
GET MESSAGES
=====================================================
*/

app.get(
  "/api/inboxes/:id/messages",
  async (req, res) => {
    try {
      await cleanupExpired();

      const inbox =
        await getInboxById(
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

      const expiresAt =
        new Date(
          inbox.expires_at
        ).getTime();

      if (
        expiresAt <=
        Date.now()
      ) {
        return res
          .status(404)
          .json({
            error:
              "Inbox not found or expired"
          });
      }

      const messages =
        await getMessagesForInbox(
          inbox.id
        );

      res.json({
        inbox:
          mapInbox(inbox),

        messages
      });
    } catch (error) {
      console.error(
        "Get messages error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Failed to load messages"
        });
    }
  }
);

/*
=====================================================
GET SINGLE MESSAGE
=====================================================
*/

app.get(
  "/api/inboxes/:inboxId/messages/:messageId",
  async (req, res) => {
    try {
      await cleanupExpired();

      const inbox =
        await getInboxById(
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
        await getSingleMessage(
          req.params.inboxId,
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

      res
        .status(500)
        .json({
          error:
            "Failed to load message"
        });
    }
  }
);

/*
=====================================================
MARK MESSAGE AS READ
=====================================================
*/

app.patch(
  "/api/inboxes/:inboxId/messages/:messageId/read",
  async (req, res) => {
    try {
      await cleanupExpired();

      const inbox =
        await getInboxById(
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

      const {
        data,
        error
      } =
        await supabase
          .from("messages")
          .update({
            is_read: true
          })
          .eq(
            "id",
            req.params.messageId
          )
          .eq(
            "inbox_id",
            req.params.inboxId
          )
          .select()
          .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        return res
          .status(404)
          .json({
            error:
              "Message not found"
          });
      }

      const message =
        await getSingleMessage(
          req.params.inboxId,
          req.params.messageId
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

      res
        .status(500)
        .json({
          error:
            "Failed to mark message as read"
        });
    }
  }
);

/*
=====================================================
DELETE SINGLE MESSAGE
=====================================================
*/

app.delete(
  "/api/inboxes/:inboxId/messages/:messageId",
  async (req, res) => {
    try {
      await cleanupExpired();

      const inbox =
        await getInboxById(
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

      const {
        data,
        error
      } =
        await supabase
          .from("messages")
          .delete()
          .eq(
            "id",
            req.params.messageId
          )
          .eq(
            "inbox_id",
            req.params.inboxId
          )
          .select("id")
          .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        return res
          .status(404)
          .json({
            error:
              "Message not found"
          });
      }

      res
        .status(204)
        .end();
    } catch (error) {
      console.error(
        "Delete message error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Failed to delete message"
        });
    }
  }
);

/*
=====================================================
DOWNLOAD ATTACHMENT
=====================================================
*/

app.get(
  "/api/inboxes/:inboxId/messages/:messageId/attachments/:attachmentId",
  async (req, res) => {
    try {
      await cleanupExpired();

      const inbox =
        await getInboxById(
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

      const {
        data: attachment,
        error
      } =
        await supabase
          .from("attachments")
          .select("*")
          .eq(
            "id",
            req.params.attachmentId
          )
          .eq(
            "message_id",
            req.params.messageId
          )
          .maybeSingle();

      if (error) {
        throw error;
      }

      if (!attachment) {
        return res
          .status(404)
          .json({
            error:
              "Attachment not found"
          });
      }

      if (
        !attachment.content_base64
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
          attachment.content_base64,
          "base64"
        );

      res.setHeader(
        "Content-Type",
        attachment.content_type ||
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

      res.send(content);
    } catch (error) {
      console.error(
        "Attachment download error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Failed to download attachment"
        });
    }
  }
);

/*
=====================================================
DELETE INBOX
=====================================================
*/

app.delete(
  "/api/inboxes/:id",
  async (req, res) => {
    try {
      const inbox =
        await getInboxById(
          req.params.id
        );

      if (!inbox) {
        return res
          .status(404)
          .json({
            error:
              "Inbox not found"
          });
      }

      const {
        data,
        error
      } =
        await supabase
          .from("inboxes")
          .delete()
          .eq(
            "id",
            req.params.id
          )
          .select("id")
          .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        return res
          .status(404)
          .json({
            error:
              "Inbox not found"
          });
      }

      res
        .status(204)
        .end();
    } catch (error) {
      console.error(
        "Delete inbox error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Failed to delete inbox"
        });
    }
  }
);

/*
=====================================================
DEVELOPMENT MESSAGE
=====================================================
*/

app.post(
  "/api/dev/inboxes/:id/messages",
  async (req, res) => {
    try {
      await cleanupExpired();

      const inbox =
        await getInboxById(
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

      const messageId =
        crypto.randomUUID();

      const receivedAt =
        new Date().toISOString();

      const messageRow = {
        id:
          messageId,

        inbox_id:
          inbox.id,

        from_email:
          normalizeEmail(
            req.body.from ||
              "demo@example.com"
          ),

        to_email:
          inbox.address,

        subject:
          req.body.subject ||
          "Test message",

        body:
          req.body.body ||
          "This is a development test message.",

        html:
          null,

        received_at:
          receivedAt,

        is_read:
          false
      };

      const {
        data,
        error
      } =
        await supabase
          .from("messages")
          .insert(
            messageRow
          )
          .select()
          .single();

      if (error) {
        throw error;
      }

      const message = {
        id:
          data.id,

        from:
          data.from_email,

        to:
          data.to_email,

        subject:
          data.subject,

        body:
          data.body,

        html:
          data.html,

        receivedAt:
          data.received_at,

        isRead:
          false,

        attachments: []
      };

      res
        .status(201)
        .json({
          message
        });
    } catch (error) {
      console.error(
        "Development message error:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Failed to create test message"
        });
    }
  }
);

/*
=====================================================
SMTP HELPERS
=====================================================
*/

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

/*
=====================================================
SMTP SERVER
=====================================================

This remains available for local testing.

The production/public path is Resend.
*/

const acceptedSmtpDomains =
  new Set([
    MAIL_DOMAIN.toLowerCase(),
    "temp.local"
  ]);

const smtpServer =
  new SMTPServer({
    name:
      `mail.${MAIL_DOMAIN}`,

    banner:
      "Temp Mail SMTP Service",

    authOptional:
      true,

    disabledCommands: [
      "AUTH"
    ],

    size:
      MAX_MESSAGE_BYTES,

    hideSTARTTLS:
      true,

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
      _session,
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
      _session,
      callback
    ) {
      const recipient =
        normalizeEmail(
          address.address
        );

      const atIndex =
        recipient.lastIndexOf(
          "@"
        );

      const domain =
        atIndex >= 0
          ? recipient.slice(
              atIndex + 1
            )
          : "";

      if (
        !acceptedSmtpDomains.has(
          domain
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

      getInboxByAddress(
        recipient
      )
        .then(
          async (inbox) => {
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

            const expiresAt =
              new Date(
                inbox.expires_at
              ).getTime();

            if (
              expiresAt <=
              Date.now()
            ) {
              const error =
                new Error(
                  "Temporary inbox has expired"
                );

              error.responseCode =
                550;

              return callback(
                error
              );
            }

            callback();
          }
        )
        .catch(
          (error) => {
            console.error(
              "[SMTP] Recipient lookup error:",
              error
            );

            error.responseCode =
              451;

            callback(error);
          }
        );
    },

    onData(
      stream,
      _session,
      callback
    ) {
      const chunks = [];

      let totalBytes = 0;

      let callbackCalled =
        false;

      const finish =
        (
          error,
          message
        ) => {
          if (
            callbackCalled
          ) {
            return;
          }

          callbackCalled =
            true;

          callback(
            error,
            message
          );
        };

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

              return finish(
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

            const inbox =
              await getInboxByAddress(
                normalizedRecipient
              );

            if (!inbox) {
              const error =
                new Error(
                  "Inbox expired or does not exist"
                );

              error.responseCode =
                550;

              return finish(
                error
              );
            }

            const expiresAt =
              new Date(
                inbox.expires_at
              ).getTime();

            if (
              expiresAt <=
              Date.now()
            ) {
              const error =
                new Error(
                  "Inbox has expired"
                );

              error.responseCode =
                550;

              return finish(
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

            const messageId =
              crypto.randomUUID();

            const receivedAt =
              new Date().toISOString();

            const messageRow = {
              id:
                messageId,

              inbox_id:
                inbox.id,

              from_email:
                sender,

              to_email:
                normalizedRecipient,

              subject:
                parsed.subject ||
                "(No subject)",

              body:
                text,

              html,

              received_at:
                receivedAt,

              is_read:
                false
            };

            const {
              error: messageError
            } =
              await supabase
                .from("messages")
                .insert(
                  messageRow
                );

            if (messageError) {
              throw messageError;
            }

            const parsedAttachments =
              Array.isArray(
                parsed.attachments
              )
                ? parsed.attachments
                : [];

            if (
              parsedAttachments.length >
              0
            ) {
              const attachmentRows =
                parsedAttachments.map(
                  (
                    attachment
                  ) => ({
                    id:
                      crypto.randomUUID(),

                    message_id:
                      messageId,

                    filename:
                      attachment.filename ||
                      "attachment",

                    content_type:
                      attachment.contentType ||
                      "application/octet-stream",

                    size:
                      attachment.size ||
                      0,

                    content_base64:
                      Buffer.isBuffer(
                        attachment.content
                      )
                        ? attachment.content.toString(
                            "base64"
                          )
                        : null
                  })
                );

              const {
                error:
                  attachmentError
              } =
                await supabase
                  .from(
                    "attachments"
                  )
                  .insert(
                    attachmentRows
                  );

              if (
                attachmentError
              ) {
                await supabase
                  .from(
                    "messages"
                  )
                  .delete()
                  .eq(
                    "id",
                    messageId
                  );

                throw attachmentError;
              }
            }

            console.log(
              `[SMTP] Email received: ${sender} -> ${normalizedRecipient}`
            );

            console.log(
              `[SMTP] Subject: ${messageRow.subject}`
            );

            if (
              parsedAttachments.length >
              0
            ) {
              console.log(
                `[SMTP] Attachments: ${parsedAttachments.length}`
              );
            }

            finish(
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

            finish(
              error
            );
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

          finish(
            error
          );
        }
      );
    }
  });

/*
=====================================================
SMTP ERROR
=====================================================
*/

smtpServer.on(
  "error",
  (error) => {
    console.error(
      "[SMTP] Server error:",
      error
    );
  }
);

/*
=====================================================
EXPIRATION CLEANUP
=====================================================
*/

setInterval(
  () => {
    cleanupExpired().catch(
      (error) => {
        console.error(
          "Scheduled cleanup error:",
          error
        );
      }
    );
  },
  30 * 1000
);

/*
=====================================================
RESEND INBOUND POLLING FALLBACK
=====================================================

Webhooks are still the primary receive path. This
polling fallback imports recent Resend inbound emails
if a webhook is delayed, misconfigured, or missed.
*/

async function syncRecentResendEmails() {
  if (!resend) {
    return;
  }

  try {
    const { data, error } =
      await resend.emails.receiving.list({
        limit: 20
      });

    if (error) {
      console.error(
        "[RESEND] Polling list error:",
        error
      );

      return;
    }

    const receivedEmails =
      Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data)
        ? data
        : [];

    for (const email of receivedEmails) {
      const emailId =
        email?.id ||
        email?.email_id;

      if (!emailId) {
        continue;
      }

      try {
        const result =
          await storeResendReceivedEmail(
            emailId,
            email
          );

        if (
          result.stored &&
          !result.duplicate
        ) {
          console.log(
            `[RESEND] Polled email stored: ${result.from} -> ${result.to}`
          );
        }
      } catch (error) {
        console.error(
          `[RESEND] Polling import failed for ${emailId}:`,
          safeErrorMessage(error)
        );
      }
    }
  } catch (error) {
    console.error(
      "[RESEND] Polling sync error:",
      safeErrorMessage(error)
    );
  }
}

setInterval(
  () => {
    syncRecentResendEmails().catch(
      (error) => {
        console.error(
          "[RESEND] Scheduled polling error:",
          safeErrorMessage(error)
        );
      }
    );
  },
  60 * 1000
);

/*
=====================================================
START HTTP SERVER
=====================================================
*/

app.listen(
  HTTP_PORT,
  async () => {
    console.log("");

    console.log(
      "========================================"
    );

    console.log(
      "           TEMP MAIL API"
    );

    console.log(
      "========================================"
    );

    console.log("");

    console.log(
      `HTTP Port: ${HTTP_PORT}`
    );

    console.log(
      `Health: http://localhost:${HTTP_PORT}/api/health`
    );

    console.log(
      `Domain: ${MAIL_DOMAIN}`
    );

    console.log(
      "Database: Supabase PostgreSQL"
    );

    console.log(
      `Resend API: ${
        resend
          ? "configured"
          : "not configured"
      }`
    );

    console.log(
      `Resend webhook: ${
        RESEND_WEBHOOK_SECRET
          ? "configured"
          : "not configured"
      }`
    );

    console.log(
      "========================================"
    );

    console.log("");

    try {
      const {
        error
      } =
        await supabase
          .from("inboxes")
          .select("id")
          .limit(1);

      if (error) {
        console.error(
          "[DATABASE] Connection failed:",
          error
        );
      } else {
        console.log(
          "[DATABASE] Supabase connection successful."
        );
      }
    } catch (error) {
      console.error(
        "[DATABASE] Connection error:",
        error
      );
    }

    console.log("");
  }
);

/*
=====================================================
START SMTP SERVER
=====================================================
*/

smtpServer.listen(
  SMTP_PORT,
  "0.0.0.0",
  () => {
    console.log(
      `[SMTP] Listening on port ${SMTP_PORT}`
    );

    console.log(
      `[SMTP] Accepted domains: ${[
        ...acceptedSmtpDomains
      ].join(", ")}`
    );

    console.log("");

    console.log(
      "Phase 2 mail receiver is ready."
    );

    console.log("");
  }
);
