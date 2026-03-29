const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'chrome-extension://*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { key } = req.body;
  if (!key) return res.status(400).json({ valid: false });

  const { data, error } = await supabase
    .from('looker_licenses')
    .select('plan, email, active')
    .eq('key', key)
    .single();

  if (error || !data || !data.active) {
    return res.json({ valid: false });
  }

  res.json({ valid: true, plan: data.plan, email: data.email });
};
