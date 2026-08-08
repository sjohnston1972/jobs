const RESEND_URL = 'https://api.resend.com/emails';

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Resend wants a real mailbox in `from`. If the configured value is a bare
 * domain, promote it to jobs@<domain> rather than failing the send.
 */
export function normaliseFrom(from: string): string {
  const trimmed = from.trim();
  if (trimmed.includes('@')) return trimmed;
  const domain = trimmed.replace(/^jobs\./, '');
  return `Job Monitor <jobs@${domain}>`;
}

export async function sendEmail(apiKey: string, message: EmailMessage): Promise<void> {
  const response = await fetch(RESEND_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: normaliseFrom(message.from),
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend rejected the send — HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
}
