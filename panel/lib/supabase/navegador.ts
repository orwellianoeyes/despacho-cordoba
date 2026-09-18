import { createBrowserClient } from "@supabase/ssr";

// Cliente del navegador: usa la clave publishable, que es pública a
// propósito. Lo que protege los datos es RLS, no esconder esta clave.
export function clienteNavegador() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
