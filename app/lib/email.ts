/**
 * Sends alert emails through Resend's HTTPS API (Sites can't open SMTP connections).
 * https://resend.com/docs/api-reference/emails/send-email
 *
 * Needs two Site secrets: RESEND_API_KEY and ALERTS_FROM (e.g. "OpenLand Alerts
 * <alerts@yourdomain.com>", on a domain verified in Resend). Without both, nothing
 * is sent: Resend only delivers to other people from a verified domain.
 */
export type EmailConfig = { apiKey?: string; from?: string };
export type OutgoingEmail = { to: string; subject: string; text: string; html: string; headers?: Record<string, string>; idempotencyKey?: string };
export type SendResult = { ok: true; id: string } | { ok: false; error: string };

export const emailEnabled = (c: EmailConfig) => Boolean(c.apiKey?.trim() && c.from?.trim());

export async function sendWithResend(config: EmailConfig, msg: OutgoingEmail, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  if (!emailEnabled(config)) return { ok: false, error: "Email isn't configured (RESEND_API_KEY and ALERTS_FROM)" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...(msg.idempotencyKey ? { "Idempotency-Key": msg.idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: config.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html, headers: msg.headers }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!res.ok || !body.id) return { ok: false, error: `Resend HTTP ${res.status}: ${body.message ?? body.name ?? "no id returned"}` };
    return { ok: true, id: body.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "send failed" };
  } finally {
    clearTimeout(timer);
  }
}
