// Email transports. Chosen by the email_transport setting (else the EMAIL_TRANSPORT variable):
//   cloudflare  Cloudflare Email Service, `send_email` binding EMAIL (same as Christmas cards). The sender's domain
//               (overyondrdev.com) must be onboarded in Email Service → Email Sending. Sending to any recipient needs
//               Workers Paid; on Workers Free only verified destination addresses receive mail.
//   resend      Resend API with the RESEND_API_KEY secret (same as marketing requests; overyondrdev.com is verified).
//   off         nothing is sent (logged as failed with a clear reason).
export async function sendEmail(env, transport, { to, subject, text, html }) {
  const from = env.EMAIL_FROM || 'alerts@overyondrdev.com';
  const fromName = env.EMAIL_FROM_NAME || 'Yondr Ops';
  if (transport === 'off') throw new Error('Email is switched off (email transport: off).');
  if (transport === 'resend') {
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY secret is not set.');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: `${fromName} <${from}>`, to: [to], subject, text, html }),
    });
    if (!res.ok) throw new Error(`Resend answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  if (!env.EMAIL) throw new Error('The EMAIL (send_email) binding is missing.');
  await env.EMAIL.send({ from: { email: from, name: fromName }, to, subject, text, html });
}
