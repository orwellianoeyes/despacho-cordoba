// Mandar un mensaje por el bot. Devuelve null si salió, o el motivo si no.
export async function enviarTelegram(chatId: number, texto: string): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return "falta TELEGRAM_BOT_TOKEN en el entorno";
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto, disable_web_page_preview: true }),
  });
  const c = await r.json().catch(() => ({}));
  return r.ok && c?.ok ? null : `Telegram rechazó el envío: ${c?.description ?? r.status}`;
}
