import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import nodemailer from "nodemailer";
import { z } from "zod";

const app = express();
app.use(express.json());

// ── Config from environment variables ──────────────────────────────────────
const GMAIL_USER         = process.env.GMAIL_USER;          // aryan@valuecart.in
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;  // 16-char app password
const SERVER_SECRET      = process.env.SERVER_SECRET;       // your chosen secret token
const PORT               = process.env.PORT || 3000;

if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !SERVER_SECRET) {
  console.error("❌ Missing required env vars: GMAIL_USER, GMAIL_APP_PASSWORD, SERVER_SECRET");
  process.exit(1);
}

// ── Health check ────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "Valuecart Email MCP Server", version: "1.0.0" });
});

// ── MCP endpoint (secret in path for security) ─────────────────────────────
app.post("/mcp/:secret", async (req, res) => {
  if (req.params.secret !== SERVER_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const mcpServer = new McpServer({
    name: "valuecart-email-sender",
    version: "1.0.0",
  });

  // ── Tool: send_email ──────────────────────────────────────────────────────
  mcpServer.tool(
    "send_email",
    "Send an email via Gmail SMTP on behalf of Valuecart Automation",
    {
      to:        z.string().describe("Recipient email address(es), comma-separated"),
      subject:   z.string().describe("Email subject line"),
      body_html: z.string().describe("Full HTML body of the email"),
      body_text: z.string().optional().describe("Plain text fallback — auto-stripped from HTML if omitted"),
      cc:        z.string().optional().describe("CC recipients, comma-separated"),
    },
    async ({ to, subject, body_html, body_text, cc }) => {
      try {
        const transporter = nodemailer.createTransport({
          host: "smtp.gmail.com",
          port: 465,
          secure: true,
          auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
        });

        const plainText = body_text
          ?? body_html.replace(/<br\s*\/?>/gi, "\n")
                      .replace(/<\/?(p|div|h[1-6])[^>]*>/gi, "\n")
                      .replace(/<[^>]+>/g, "")
                      .replace(/&nbsp;/g, " ")
                      .replace(/\n{3,}/g, "\n\n")
                      .trim();

        const mail = {
          from:    `Valuecart Automation <${GMAIL_USER}>`,
          to,
          subject,
          html:    body_html,
          text:    plainText,
        };
        if (cc) mail.cc = cc;

        const info = await transporter.sendMail(mail);

        return {
          content: [{
            type: "text",
            text: `✅ Email sent successfully\n   To: ${to}${cc ? `\n   CC: ${cc}` : ""}\n   Subject: ${subject}\n   Message-ID: ${info.messageId}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `❌ Send failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── Wire up transport ─────────────────────────────────────────────────────
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Valuecart Email MCP Server running on port ${PORT}`);
});
