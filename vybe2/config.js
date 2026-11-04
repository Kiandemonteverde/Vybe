// VYBE backend configuration.
// Both values are PUBLIC by design (Supabase Dashboard → Project Settings → API):
//   - Project URL
//   - "anon" / publishable key
// Security comes from the Row Level Security policies in supabase/schema.sql.
// NEVER put the "service_role" / secret key in this file.
window.VYBE_CONFIG = {
  SUPABASE_URL: "https://srkpfdwvwufmzsvtkmjk.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNya3BmZHd2d3VmbXpzdnRrbWprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM0NzYxNzgsImV4cCI6MjEwOTA1MjE3OH0.7jajczWjNPk_BHulVjuqAqpMAkNumbfBgOQdgBcNXow"
};
