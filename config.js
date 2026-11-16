/* Simple connections - which database the game talks to.

   Fill in both values from your Supabase project (see the setup guide):
     supabaseUrl  Project URL,  e.g. "https://abcdefghijklmnop.supabase.co"
     supabaseKey  the "publishable" key (starts sb_publishable_), or the
                  legacy "anon" key - never the secret / service_role key.

   Both are safe to publish on GitHub. The key only lets the website call
   the game's sc_* functions; the answers, the scores and the host passcode
   stay inside the database. */

window.SC_CONFIG = {
  supabaseUrl: "https://pchxxtwwrvwjbkhrfozb.supabase.co",
  supabaseKey: "sb_publishable_IOILpgyVOM_h3P-XZZX75g_rXDInvL-"
};
