/**
 * Supabase browser client singleton for the Margen web app (ADR-096).
 *
 * Created once from the environment-driven credentials in `config` (ADR-007/
 * ADR-093): only the anon (publishable) key reaches the browser — never the
 * service-role key. The client owns the auth session, persisting it to
 * localStorage, refreshing tokens automatically, and detecting the session
 * returned in the URL after an OAuth redirect.
 *
 * This module is foundation only: it does NOT wire auth into providers, the
 * router, or any UI. Import `supabase` wherever a session or query is needed.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { config } from '../config'

export const supabase: SupabaseClient = createClient(
  config.supabaseUrl,
  config.supabaseAnonKey,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
)
