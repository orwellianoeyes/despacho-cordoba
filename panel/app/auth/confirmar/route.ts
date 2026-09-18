import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { clienteServidor } from "@/lib/supabase/servidor";

// Adonde cae el enlace mágico del correo.
//
// Supabase manda DOS formatos distintos según cómo esté la plantilla de
// correo, y hay que aceptar los dos:
//
//   ?code=…                 plantilla por defecto ({{ .ConfirmationURL }}).
//                           Supabase verifica de su lado y vuelve con un
//                           código que hay que canjear por sesión.
//   ?token_hash=…&type=…    plantilla personalizada ({{ .TokenHash }}).
//
// La primera versión de esta ruta solo entendía la segunda, así que con la
// plantilla por defecto rebotaba sin decir por qué.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const supabase = await clienteServidor();

  const code = searchParams.get("code");
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  // Si Supabase rechazó el enlace, lo dice acá y conviene repetirlo tal cual.
  const errorDirecto = searchParams.get("error_description") ?? searchParams.get("error");

  let motivo = errorDirecto ?? "";

  if (!motivo && code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/buscador", origin));
    motivo = error.message;
  } else if (!motivo && token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) return NextResponse.redirect(new URL("/buscador", origin));
    motivo = error.message;
  } else if (!motivo) {
    motivo = "el enlace llegó sin code ni token_hash: revisá las Redirect URLs "
           + "en Supabase (Authentication → URL Configuration)";
  }

  // El motivo viaja a la pantalla de login: rebotar en silencio hace perder
  // intentos, y son cuatro por hora.
  const destino = new URL("/login", origin);
  destino.searchParams.set("motivo", motivo);
  return NextResponse.redirect(destino);
}
