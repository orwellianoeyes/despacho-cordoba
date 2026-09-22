"use client";

import { useEffect, useState } from "react";

// Tres estados a propósito: "auto" sigue al sistema, que es lo correcto por
// defecto; los otros dos son para cuando el sistema se equivoca respecto de
// dónde está Leo leyendo. La elección vive en el navegador, no en la base:
// es una preferencia de este aparato, no de la cuenta.
type Tema = "auto" | "claro" | "oscuro";
const VUELTA: Record<Tema, Tema> = { auto: "oscuro", oscuro: "claro", claro: "auto" };
const ROTULO: Record<Tema, string> = { auto: "auto", oscuro: "noche", claro: "día" };

export function Tema() {
  const [tema, setTema] = useState<Tema>("auto");

  useEffect(() => {
    try {
      const g = localStorage.getItem("tema") as Tema | null;
      if (g === "claro" || g === "oscuro") setTema(g);
    } catch { /* navegador sin storage: queda en auto */ }
  }, []);

  function cambiar() {
    const nuevo = VUELTA[tema];
    setTema(nuevo);
    const raiz = document.documentElement;
    if (nuevo === "auto") raiz.removeAttribute("data-tema");
    else raiz.setAttribute("data-tema", nuevo);
    try {
      if (nuevo === "auto") localStorage.removeItem("tema");
      else localStorage.setItem("tema", nuevo);
    } catch { /* si no se puede guardar, vale igual para esta sesión */ }
  }

  return (
    <button type="button" className="tema" onClick={cambiar}
            title="Cambiar entre automático, noche y día">
      {ROTULO[tema]}
    </button>
  );
}
