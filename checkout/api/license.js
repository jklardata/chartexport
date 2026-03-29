const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Called by the success page to retrieve the license key from the session
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not completed' });
    }
    res.json({
      key: session.metadata.license_key,
      email: session.customer_email,
      plan: session.metadata.plan
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
