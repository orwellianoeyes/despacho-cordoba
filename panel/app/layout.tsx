import type { Metadata } from "next";
import "./globales.css";

export const metadata: Metadata = {
  title: "Panel · Despacho Diario",
  description: "Panel privado del Despacho Diario del Boletín Oficial de Córdoba.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <head>
        {/* Antes de pintar, para que no haya un fogonazo blanco al entrar de
            noche. Si no hay elección guardada, manda el sistema. */}
        <script dangerouslySetInnerHTML={{ __html:
          `try{var t=localStorage.getItem('tema');`
          + `if(t)document.documentElement.setAttribute('data-tema',t)}catch(e){}` }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Bitter:wght@700;800&family=Archivo:wght@400;500;600&family=Chivo+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
