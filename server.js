  import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
  import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
  import express from "express";
  import { z } from "zod";

  const app = express();
  app.use(express.json());

  // ── Config ────────────────────────────────────────────────────────────────────
  const ZEPTOMAIL_TOKEN  = process.env.ZEPTOMAIL_TOKEN;
  const ZEPTOMAIL_URL    = process.env.ZEPTOMAIL_URL || "https://api.zeptomail.in/v1.1/email";
  const FROM_EMAIL       = process.env.FROM_EMAIL || "noreply@valuecart.in";
  const FROM_NAME        = process.env.FROM_NAME  || "Valuecart Automation";
  const SERVER_SECRET    = process.env.SERVER_SECRET;
  const PORT             = process.env.PORT || 3000;

  if (!ZEPTOMAIL_TOKEN || !SERVER_SECRET) {
    console.error("❌ Missing required env vars: ZEPTOMAIL_TOKEN, SERVER_SECRET");
    process.exit(1);
  }

  console.log("✅ ZeptoMail ready");

  // Parse a comma-separated address string into ZeptoMail recipient objects.
  function toRecipients(str) {
    return str
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .map(address => ({ email_address: { address } }));
  }

  // ── Fire-and-forget sender ────────────────────────────────────────────────────
  function dispatchEmail({ to, subject, body_html, body_text, cc, attachments }) {
    const plainText = body_text
      ?? body_html.replace(/<br\s*\/?>/gi, "\n")
                  .replace(/<\/?(p|div|h[1-6])[^>]*>/gi, "\n")
                  .replace(/<[^>]+>/g, "")
                  .replace(/&nbsp;/g, " ")
                  .replace(/\n{3,}/g, "\n\n")
                  .trim();

    const payload = {
      from: { address: FROM_EMAIL, name: FROM_NAME },
      to: toRecipients(to),
      subject,
      htmlbody: body_html,
      textbody: plainText,
    };
    if (cc) payload.cc = toRecipients(cc);

    // ZeptoMail splits regular attachments from inline (cid) images.
    if (attachments?.length) {
      const files  = [];
      const inline = [];
      for (const a of attachments) {
        if (a.disposition === "inline" && a.content_id) {
          inline.push({ content: a.content, mime_type: a.type, cid: a.content_id });
        } else {
          files.push({ content: a.content, mime_type: a.type, name: a.filename });
        }
      }
      if (files.length)  payload.attachments  = files;
      if (inline.length) payload.inline_images = inline;
    }

    fetch(ZEPTOMAIL_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Zoho-enczapikey ${ZEPTOMAIL_TOKEN}`,
      },
      body: JSON.stringify(payload),
    })
      .then(async (resp) => {
        if (resp.ok) {
          console.log(`✅ SENT → ${to} | ${subject}`);
        } else {
          const detail = await resp.text();
          console.error(`❌ FAILED → ${to} | ${resp.status} ${detail}`);
        }
      })
      .catch(err => console.error(`❌ FAILED → ${to} | ${err.message}`));
  }

  // ── Keep-alive & health ───────────────────────────────────────────────────────
  app.get("/ping", (_req, res) => res.send("pong"));
  app.get("/",     (_req, res) => res.json({ status: "ok", version: "1.5.0" }));

  // ── MCP endpoint ──────────────────────────────────────────────────────────────
  app.post("/mcp/:secret", async (req, res) => {
    if (req.params.secret !== SERVER_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const mcpServer = new McpServer({
      name: "valuecart-email-sender",
      version: "1.5.0",
    });

    mcpServer.tool(
      "send_email",
      "Send an email via ZeptoMail on behalf of Valuecart Automation",
      {
        to:        z.string().describe("Recipient email address(es), comma-separated"),
        subject:   z.string().describe("Email subject line"),
        body_html: z.string().describe("Full HTML body of the email"),
        body_text: z.string().optional().describe("Plain text fallback — auto-generated if omitted"),
        cc:        z.string().optional().describe("CC recipients, comma-separated"),
        attachments: z.array(z.object({
          content:     z.string().describe("Base64-encoded file content"),
          filename:    z.string().describe("File name with extension, e.g. banner.png"),
          type:        z.string().optional().describe("MIME type, e.g. image/png"),
          disposition: z.enum(["attachment", "inline"]).optional().describe("'inline' to embed via cid:, 'attachment' to attach"),
          content_id:  z.string().optional().describe("Content-ID for inline images, referenced in HTML as <img src='cid:YOUR_ID'>"),
        })).optional().describe("File attachments or inline images"),
      },
      async ({ to, subject, body_html, body_text, cc, attachments }) => {
        dispatchEmail({ to, subject, body_html, body_text, cc, attachments });
        console.log(`📤 QUEUED → ${to} | ${subject}`);
        return {
          content: [{
            type: "text",
            text: `📤 Queued for delivery\n   To: ${to}${cc ? `\n   CC: ${cc}` : ""}\n   Subject: ${subject}\n   (Check Railway logs to confirm delivery)`,
          }],
        };
      }
    );

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // ── Start ─────────────────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`✅ Valuecart Email MCP Server v1.5.0 running on port ${PORT}`);
  });
