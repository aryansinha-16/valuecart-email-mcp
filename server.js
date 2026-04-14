import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import sgMail from "@sendgrid/mail";
import { z } from "zod";

const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL       = process.env.FROM_EMAIL || "aryan@valuecart.in";
const FROM_NAME        = process.env.FROM_NAME  || "Valuecart Automation";
const SERVER_SECRET    = process.env.SERVER_SECRET;
const PORT             = process.env.PORT || 3000;

if (!SENDGRID_API_KEY || !SERVER_SECRET) {
  console.error("❌ Missing required env vars: SENDGRID_API_KEY, SERVER_SECRET");
  process.exit(1);
}

sgMail.setApiKey(SENDGRID_API_KEY);
console.log("✅ SendGrid ready");

// ── Fire-and-forget sender ────────────────────────────────────────────────────
function dispatchEmail({ to, subject, body_html, body_text, cc }) {
  const plainText = body_text
    ?? body_html.replace(/<br\s*\/?>/gi, "\n")
                .replace(/<\/?(p|div|h[1-6])[^>]*>/gi, "\n")
                .replace(/<[^>]+>/g, "")
                .replace(/&nbsp;/g, " ")
                .replace(/\n{3,}/g, "\n\n")
                .trim();

  const msg = {
    to,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject,
    html: body_html,
    text: plainText,
  };
  if (cc) msg.cc = cc;

  // No await — returns immediately, sends in background via HTTPS
  sgMail.send(msg)
    .then(() => console.log(`✅ SENT → ${to} | ${subject}`))
    .catch(err => console.error(`❌ FAILED → ${to} | ${err.message}`));
}

// ── Keep-alive & health ───────────────────────────────────────────────────────
app.get("/ping", (_req, res) => res.send("pong"));
app.get("/",     (_req, res) => res.json({ status: "ok", version: "1.3.0" }));

// ── MCP endpoint ──────────────────────────────────────────────────────────────
app.post("/mcp/:secret", async (req, res) => {
  if (req.params.secret !== SERVER_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const mcpServer = new McpServer({
    name: "valuecart-email-sender",
    version: "1.3.0",
  });

  mcpServer.tool(
    "send_email",
    "Send an email via SendGrid on behalf of Valuecart Automation",
    {
      to:        z.string().describe("Recipient email address(es), comma-separated"),
      subject:   z.string().describe("Email subject line"),
      body_html: z.string().describe("Full HTML body of the email"),
      body_text: z.string().optional().describe("Plain text fallback — auto-generated if omitted"),
      cc:        z.string().optional().describe("CC recipients, comma-separated"),
    },
    async ({ to, subject, body_html, body_text, cc }) => {
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
  console.log(`✅ Valuecart Email MCP Server v1.3.0 running on port ${PORT}`);
});
