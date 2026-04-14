import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import nodemailer from "nodemailer";
import { z } from "zod";

const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const GMAIL_USER         = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const SERVER_SECRET      = process.env.SERVER_SECRET;
const PORT               = process.env.PORT || 3000;

if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !SERVER_SECRET) {
  console.error("❌ Missing required env vars: GMAIL_USER, GMAIL_APP_PASSWORD, SERVER_SECRET");
  process.exit(1);
}

// ── Pooled SMTP transporter — created once at startup ─────────────────────────
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  pool: true,
  maxConnections: 5,
  maxMessages: 100,
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
});

transporter.verify((err) => {
  if (err) console.error("❌ SMTP verify failed:", err.message);
  else     console.log("✅ SMTP connection ready");
});

// ── Fire-and-forget sender — does NOT block the MCP response ─────────────────
// Returns immediately to Cowork, sends in background. Logs result to Railway.
function dispatchEmail({ to, subject, body_html, body_text, cc }) {
  const plainText = body_text
    ?? body_html.replace(/<br\s*\/?>/gi, "\n")
                .replace(/<\/?(p|div|h[1-6])[^>]*>/gi, "\n")
                .replace(/<[^>]+>/g, "")
                .replace(/&nbsp;/g, " ")
                .replace(/\n{3,}/g, "\n\n")
                .trim();

  const mail = {
    from: `Valuecart Automation <${GMAIL_USER}>`,
    to, subject,
    html: body_html,
    text: plainText,
  };
  if (cc) mail.cc = cc;

  // No await — runs in background after MCP response is already returned
  transporter.sendMail(mail)
    .then(info => console.log(`✅ SENT → ${to} | ${subject} | ${info.messageId}`))
    .catch(err => console.error(`❌ FAILED → ${to} | ${err.message}`));
}

// ── Keep-alive (ping every 5 min from UptimeRobot) ───────────────────────────
app.get("/ping", (_req, res) => res.send("pong"));
app.get("/",     (_req, res) => res.json({ status: "ok", version: "1.2.0" }));

// ── MCP endpoint ──────────────────────────────────────────────────────────────
app.post("/mcp/:secret", async (req, res) => {
  if (req.params.secret !== SERVER_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const mcpServer = new McpServer({
    name: "valuecart-email-sender",
    version: "1.2.0",
  });

  mcpServer.tool(
    "send_email",
    "Queue an email for immediate delivery via Gmail SMTP",
    {
      to:        z.string().describe("Recipient email address(es), comma-separated"),
      subject:   z.string().describe("Email subject line"),
      body_html: z.string().describe("Full HTML body of the email"),
      body_text: z.string().optional().describe("Plain text fallback — auto-generated if omitted"),
      cc:        z.string().optional().describe("CC recipients, comma-separated"),
    },
    async ({ to, subject, body_html, body_text, cc }) => {
      // Kick off send in background — return to Cowork immediately
      dispatchEmail({ to, subject, body_html, body_text, cc });

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
  console.log(`✅ Valuecart Email MCP Server v1.2.0 running on port ${PORT}`);
});
