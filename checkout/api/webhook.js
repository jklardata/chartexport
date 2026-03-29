const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

// Vercel parses the body by default — disable for webhook signature verification
export const config = { api: { bodyParser: false } };

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const rawBody = await buffer(req);
  let event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const key = session.metadata.license_key;
    const email = session.customer_email;
    const plan = session.metadata.plan;

    // Store license in Supabase
    const { error } = await supabase.from('looker_licenses').upsert({
      key,
      email,
      plan,
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
      active: true
    }, { onConflict: 'key' });

    if (error) console.error('Supabase insert error:', error);

    // Send license key via email
    await resend.emails.send({
      from: 'Looker Studio Exporter <support@solofi.io>',
      to: email,
      subject: 'Your Looker Studio Exporter Pro License Key',
      html: `
        <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#111">
          <h2 style="font-size:20px;font-weight:700;margin-bottom:8px">You're now Pro 🎉</h2>
          <p style="color:#555;margin-bottom:24px">Thanks for upgrading Looker Studio Exporter. Here's your license key:</p>
          <div style="background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;padding:16px 20px;font-family:monospace;font-size:15px;letter-spacing:0.04em;word-break:break-all;margin-bottom:24px">
            ${key}
          </div>
          <p style="color:#555;margin-bottom:8px"><strong>How to activate:</strong></p>
          <ol style="color:#555;padding-left:20px;line-height:1.8">
            <li>Open the Looker Studio Exporter extension</li>
            <li>Click "Enter License Key"</li>
            <li>Paste the key above and click Activate</li>
          </ol>
          <p style="color:#888;font-size:13px;margin-top:24px">Save this email — you'll need the key if you reinstall the extension.</p>
        </div>
      `
    });
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    await supabase.from('looker_licenses')
      .update({ active: false })
      .eq('stripe_subscription_id', sub.id);
  }

  res.json({ received: true });
};
