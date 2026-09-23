import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Guardia de acceso. El panel es privado: todo lo que no sea /login o el
// callback de autenticación exige sesión. RLS protege los datos igual, pero
// esto evita que alguien vea siquiera la estructura del panel.
export async function middleware(request: NextRequest) {
  let respuesta = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (nuevas) => {
          nuevas.forEach(({ name, value }) => request.cookies.set(name, value));
          respuesta = NextResponse.next({ request });
          nuevas.forEach(({ name, value, options }) =>
            respuesta.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  const ruta = request.nextUrl.pathname;
  // El webhook de Telegram llega sin sesión; lo protege el secreto que
  // verifica la base, no este guardia.
  const publica = ruta.startsWith("/login") || ruta.startsWith("/auth")
               || ruta === "/api/telegram/webhook";

  if (!user && !publica) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (user && ruta === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/buscador";
    return NextResponse.redirect(url);
  }
  return respuesta;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg)$).*)"],
};
