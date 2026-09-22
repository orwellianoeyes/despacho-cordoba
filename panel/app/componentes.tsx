import Link from "next/link";
import { Tema } from "./tema";

export function Cabecera({ activa }: { activa: string }) {
  const secciones = [
    { href: "/buscador", texto: "Buscador" },
    { href: "/contactos", texto: "Contactos" },
    { href: "/vigilancia", texto: "Vigilancia" },
    { href: "/entregas", texto: "Entregas" },
  ];
  return (
    <header className="cabecera">
      <div>
        <p className="eyebrow">Despacho diario · Boletín Oficial de Córdoba</p>
        <h1 style={{ marginTop: 6 }}>Panel</h1>
      </div>
      <nav className="nav">
        {secciones.map((s) => (
          <Link key={s.href} href={s.href} className={activa === s.href ? "activa" : ""}>
            {s.texto}
          </Link>
        ))}
        <Tema />
      </nav>
    </header>
  );
}
