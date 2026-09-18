"use client";

import { useState } from "react";
import { clienteNavegador } from "@/lib/supabase/navegador";

export default function Login() {
  const [correo, setCorreo] = useState("");
  const [estado, setEstado] = useState<"quieto" | "enviando" | "enviado" | "error">("quieto");
  const [detalle, setDetalle] = useState("");

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setEstado("enviando");
    const supabase = clienteNavegador();
    const { error } = await supabase.auth.signInWithOtp({
      email: correo,
      options: { emailRedirectTo: `${location.origin}/auth/confirmar` },
    });
    if (error) {
      setDetalle(error.message);
      setEstado("error");
    } else {
      setEstado("enviado");
    }
  }

  return (
    <main className="centro">
      <div className="tarjeta">
        <p className="eyebrow">Despacho diario · Córdoba</p>
        <h1 style={{ marginTop: 10 }}>Panel</h1>
        <p style={{ color: "var(--grafito)", fontSize: 14, marginTop: 12 }}>
          Acceso privado. Te mandamos un enlace al correo; no hay contraseña
          que recordar ni que perder.
        </p>

        <form onSubmit={entrar} style={{ marginTop: 22 }}>
          <input
            type="email"
            required
            value={correo}
            onChange={(e) => setCorreo(e.target.value)}
            placeholder="tu correo"
            style={{ width: "100%" }}
            disabled={estado === "enviando" || estado === "enviado"}
          />
          <button
            className="btn"
            type="submit"
            style={{ marginTop: 12, width: "100%" }}
            disabled={estado === "enviando" || estado === "enviado"}
          >
            {estado === "enviando" ? "Enviando…" : "Enviarme el enlace"}
          </button>
        </form>

        {estado === "enviado" && (
          <p className="ok">
            Listo. Revisá el correo y abrí el enlace desde este mismo navegador.
          </p>
        )}
        {estado === "error" && <p className="error">{detalle}</p>}
      </div>
    </main>
  );
}
