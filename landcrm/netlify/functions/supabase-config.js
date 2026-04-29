// netlify/functions/supabase-config.js
// Returns public Supabase config to the client (anon key is safe to expose)
exports.handler = async () => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: process.env.SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
  }),
});
