// Areco Padel - API (reemplazo de Apps Script)
// Contrato idéntico al anterior: POST { fn, args: [...] } -> { ok: true, result } | { ok: false, error }
// Secrets requeridos (Supabase > Edge Functions > Secrets):
//   MP_ACCESS_TOKEN, FRONTEND_URL, RESEND_API_KEY, EMAIL_FROM (opcional),
//   ONESIGNAL_APP_ID, ONESIGNAL_API_KEY, ONESIGNAL_ADMIN_SUBSCRIPTION_ID (opcionales)
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

/* ===================== Utilidades ===================== */

const TZ_OFFSET = "-03:00"; // Argentina no usa horario de verano
const sanitizar = (t: unknown) => (t == null ? "" : String(t).trim().replace(/[<>]/g, ""));
const hhmm = (t: unknown) => String(t ?? "").slice(0, 5);
const bg = (p: Promise<unknown>) => {
  try { (globalThis as any).EdgeRuntime.waitUntil(p.catch((e) => console.error(e))); }
  catch { p.catch((e) => console.error(e)); }
};

function fechaAR(d: Date): string { return new Date(d.getTime() - 3 * 3600e3).toISOString().slice(0, 10); }
const hoyAR = () => fechaAR(new Date());
function addDays(f: string, n: number): string {
  const d = new Date(f + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
function legible(f: string): string { const [y, m, d] = f.slice(0, 10).split("-"); return `${d}/${m}/${y}`; }
const tsLegible = (ts: string) => legible(fechaAR(new Date(ts)));
const inicioMs = (fecha: string, hora: string) => Date.parse(`${fecha}T${hhmm(hora)}:00${TZ_OFFSET}`);
const isoAR = (d: Date) => new Date(d.getTime() - 3 * 3600e3).toISOString().replace("Z", TZ_OFFSET);
const moneda = (n: unknown) => "$ " + Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");

const validarEmail = (e: unknown) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
const validarTelefono = (t: unknown) => { const l = String(t).replace(/[^0-9]/g, ""); return l.length >= 8 && l.length <= 15; };
const noVacio = (v: unknown) => v !== undefined && v !== null && String(v).trim().length > 0;
const validarFechaFormato = (f: unknown) =>
  typeof f === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f) && !isNaN(new Date(f + "T00:00:00Z").getTime());

function franja(hora: string): string { const h = parseInt(hora.split(":")[0], 10); return h < 13 ? "mañana" : h < 19 ? "tarde" : "noche"; }
function fail(error: { message: string } | null) { if (error) throw new Error(error.message); }
async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* ===================== Config / catálogos ===================== */

async function getConfig(): Promise<Record<string, any>> {
  const { data, error } = await sb.from("config").select("parametro,valor"); fail(error);
  const out: Record<string, any> = {};
  for (const r of data!) {
    const v = r.valor;
    out[r.parametro] = v !== null && v !== "" && /^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : v;
  }
  return out;
}

async function listarCanchas(soloActivas?: boolean) {
  let q = sb.from("canchas").select("*").order("cancha_id");
  if (soloActivas) q = q.eq("activa", "SI");
  const { data, error } = await q; fail(error);
  return data!.map((c) => ({ canchaId: c.cancha_id, nombre: c.nombre, tipo: c.tipo, precio: Number(c.precio), activa: String(c.activa).toUpperCase() === "SI" }));
}

async function listarHorarios(soloActivos?: boolean) {
  let q = sb.from("horarios").select("*").order("hora_inicio");
  if (soloActivos) q = q.eq("activo", "SI");
  const { data, error } = await q; fail(error);
  return data!.map((h) => ({ horarioId: h.horario_id, horaInicio: hhmm(h.hora_inicio), horaFin: hhmm(h.hora_fin), activo: String(h.activo).toUpperCase() === "SI" }));
}

async function obtenerDatosInicialesCliente() {
  const c = await getConfig();
  return {
    nombreClub: c.Nombre_Club || "Areco Padel",
    anticipacionMaxDias: Number(c.Anticipacion_Max_Dias) || 14,
    anticipacionMinHoras: Number(c.Anticipacion_Min_Horas) || 24,
    porcentajeSeña: Number(c["Porcentaje_Seña"]) || 30,
    moneda: c.Moneda || "ARS",
    canchas: await listarCanchas(true),
  };
}

/* ===================== Emails (Resend) y push (OneSignal) ===================== */

async function enviarMail(to: string, subject: string, html: string): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) { console.error("Falta RESEND_API_KEY: no se envió el email a " + to); return false; }
  const cfg = await getConfig();
  const nombre = cfg.Email_Remite || cfg.Nombre_Club || "Areco Padel";
  const from = Deno.env.get("EMAIL_FROM") || `${nombre} <onboarding@resend.dev>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  if (!r.ok) { console.error("Resend " + r.status + ": " + await r.text()); return false; }
  return true;
}

async function wrapHtml(titulo: string, contenido: string) {
  const club = (await getConfig()).Nombre_Club || "Areco Padel";
  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#0f0f10;padding:32px;">
<div style="max-width:520px;margin:0 auto;background:#18181a;border:1px solid #2a2a2c;border-radius:16px;overflow:hidden;">
<div style="background:#111;padding:24px 28px;border-bottom:3px solid #CCFF00;"><h1 style="margin:0;color:#CCFF00;font-size:20px;letter-spacing:0.5px;">${club}</h1></div>
<div style="padding:28px;color:#eaeaea;"><h2 style="margin-top:0;color:#fff;font-size:17px;">${titulo}</h2>${contenido}</div>
<div style="padding:16px 28px;background:#111;color:#888;font-size:12px;">Este es un email automático de ${club}. No respondas a este mensaje.</div>
</div></div>`;
}
const fila = (e: string, v: unknown) =>
  `<tr><td style="padding:6px 0;color:#999;font-size:13px;">${e}</td><td style="padding:6px 0;color:#fff;font-size:13px;font-weight:bold;text-align:right;">${v}</td></tr>`;

async function mailConfirmacion(r: any, cli: { nombre: string; apellido: string; email: string }) {
  const c = `<p>Hola ${sanitizar(cli.nombre)}, tu reserva fue registrada con éxito.</p>
<table style="width:100%;border-collapse:collapse;margin-top:12px;">${fila("Código de reserva", r.reservaId)}${fila("Cancha", r.cancha)}${fila("Fecha", legible(r.fecha))}${fila("Horario", r.horaInicio + " - " + r.horaFin)}${fila("Precio total", moneda(r.precio))}${fila("Pagado", moneda(r.pagado || 0))}${fila("Saldo pendiente", moneda(r.saldo))}${fila("Estado", r.estado)}</table>
<p style="margin-top:16px;color:#bbb;font-size:13px;">Guardá el código de reserva: lo vas a necesitar si querés consultarla o cancelarla.</p>`;
  await enviarMail(cli.email, "Confirmación de tu reserva - " + r.reservaId, await wrapHtml("¡Reserva confirmada!", c));
}

async function mailCancelacion(r: any, cli: any) {
  const c = `<p>Hola ${sanitizar(cli.nombre)}, tu reserva fue cancelada.</p>
<table style="width:100%;border-collapse:collapse;margin-top:12px;">${fila("Código de reserva", r.reserva_id)}${fila("Fecha", legible(r.fecha))}</table>
<p style="margin-top:16px;color:#bbb;font-size:13px;">Si fue un error, podés hacer una nueva reserva desde nuestra web.</p>`;
  await enviarMail(cli.email, "Reserva cancelada - " + r.reserva_id, await wrapHtml("Reserva cancelada", c));
}

async function notificarAdmin(titulo: string, mensaje: string) {
  const appId = Deno.env.get("ONESIGNAL_APP_ID"), key = Deno.env.get("ONESIGNAL_API_KEY"), sub = Deno.env.get("ONESIGNAL_ADMIN_SUBSCRIPTION_ID");
  if (!appId || !key || !sub) return;
  const front = (Deno.env.get("FRONTEND_URL") || "").replace(/\/+$/, "");
  const r = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Key " + key },
    body: JSON.stringify({ app_id: appId, headings: { en: titulo }, contents: { en: mensaje }, include_subscription_ids: [sub], url: front ? front + "/admin/" : undefined }),
  });
  if (!r.ok) console.error("OneSignal " + r.status + ": " + await r.text());
}

/* ===================== Autenticación (OTP + sesión) ===================== */

const SESION_MS = 8 * 3600e3, OTP_MS = 5 * 60e3, OTP_MAX_INTENTOS = 5, COOLDOWN_MS = 45e3;

async function buscarUsuarioPorEmail(email: string) {
  const { data, error } = await sb.from("usuarios").select("*"); fail(error);
  return data!.find((u) => String(u.email).toLowerCase() === email) || null;
}

async function solicitarCodigoAcceso(email: string) {
  email = sanitizar(email).toLowerCase();
  if (!validarEmail(email)) throw new Error("Ingresá un email válido.");
  const { data: prev } = await sb.from("otp_codes").select("*").eq("email", email).maybeSingle();
  if (prev && Date.now() - new Date(prev.ultimo_pedido).getTime() < COOLDOWN_MS) {
    throw new Error("Ya te enviamos un código hace muy poco. Esperá unos segundos y volvé a intentar.");
  }
  const u = await buscarUsuarioPorEmail(email);
  const ahora = new Date();
  if (!u || String(u.activo).toUpperCase() !== "SI") {
    await sb.from("otp_codes").upsert({ email, codigo_hash: null, intentos: 0, expira: ahora.toISOString(), ultimo_pedido: ahora.toISOString() });
    return { ok: true, mensaje: "Si el email corresponde a un usuario activo, recibirás un código por correo." };
  }
  const codigo = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  const { error } = await sb.from("otp_codes").upsert({
    email, codigo_hash: await sha256(codigo + ":" + email), intentos: 0,
    expira: new Date(Date.now() + OTP_MS).toISOString(), ultimo_pedido: ahora.toISOString(),
  });
  fail(error);
  const c = `<p>Hola ${sanitizar(u.nombre)}, tu código de acceso al panel es:</p>
<p style="font-size:32px;font-weight:bold;color:#CCFF00;letter-spacing:6px;text-align:center;margin:24px 0;">${codigo}</p>
<p style="color:#bbb;font-size:13px;">Este código vence en 5 minutos. Si no lo solicitaste, ignorá este email.</p>`;
  const club = (await getConfig()).Nombre_Club || "Areco Padel";
  const ok = await enviarMail(u.email, "Tu código de acceso - " + club, await wrapHtml("Código de acceso", c));
  if (!ok) throw new Error("No se pudo enviar el email con el código. Probá de nuevo en unos minutos.");
  return { ok: true, mensaje: "Te enviamos un código de acceso a tu email." };
}

async function verificarCodigo(email: string, codigo: string) {
  email = sanitizar(email).toLowerCase(); codigo = sanitizar(codigo);
  const { data: row } = await sb.from("otp_codes").select("*").eq("email", email).maybeSingle();
  if (!row || !row.codigo_hash || new Date(row.expira).getTime() < Date.now()) {
    throw new Error("El código ingresado es incorrecto o expiró. Solicitá uno nuevo.");
  }
  if (row.codigo_hash !== await sha256(codigo + ":" + email)) {
    const intentos = row.intentos + 1;
    if (intentos >= OTP_MAX_INTENTOS) {
      await sb.from("otp_codes").update({ codigo_hash: null, intentos: 0 }).eq("email", email);
      throw new Error("Superaste la cantidad de intentos permitidos. Solicitá un código nuevo.");
    }
    await sb.from("otp_codes").update({ intentos }).eq("email", email);
    throw new Error("El código ingresado es incorrecto. Te quedan " + (OTP_MAX_INTENTOS - intentos) + " intentos.");
  }
  await sb.from("otp_codes").update({ codigo_hash: null, intentos: 0 }).eq("email", email);
  const u = await buscarUsuarioPorEmail(email);
  if (!u || String(u.activo).toUpperCase() !== "SI") throw new Error("El usuario no está habilitado.");
  await sb.from("sesiones").delete().lt("expira", new Date().toISOString()); // limpieza
  const { data: s, error } = await sb.from("sesiones")
    .insert({ usuario_id: u.usuario_id, expira: new Date(Date.now() + SESION_MS).toISOString() }).select("token").single();
  fail(error);
  return { ok: true, token: s!.token, usuario: { usuarioId: u.usuario_id, nombre: u.nombre, email: u.email, rol: u.rol } };
}

async function obtenerSesion(token: unknown) {
  if (!token || !/^[0-9a-f-]{36}$/i.test(String(token))) return null;
  const { data } = await sb.from("sesiones").select("token,expira,usuarios(usuario_id,nombre,email,rol,activo)").eq("token", token).maybeSingle();
  const u: any = data?.usuarios;
  if (!data || new Date(data.expira).getTime() < Date.now() || !u || String(u.activo).toUpperCase() !== "SI") return null;
  return { usuarioId: u.usuario_id, nombre: u.nombre, email: u.email, rol: u.rol };
}
async function requireRole(token: unknown, roles: string[]) {
  const s = await obtenerSesion(token);
  if (!s) throw new Error("Tu sesión expiró. Volvé a iniciar sesión.");
  if (!roles.includes(s.rol)) throw new Error("No tenés permisos para realizar esta acción.");
  return s;
}
async function cerrarSesion(token: string) { if (token) await sb.from("sesiones").delete().eq("token", token); return { ok: true }; }
async function validarSesionActual(token: string) { const s = await obtenerSesion(token); return s ? { ok: true, usuario: s } : { ok: false }; }

/* ===================== Usuarios ===================== */

const userOut = (u: any) => ({ Usuario_ID: u.usuario_id, Nombre: u.nombre, Email: u.email, Rol: u.rol, Activo: u.activo });
async function listarUsuarios(token: string) {
  await requireRole(token, ["ADMIN"]);
  const { data, error } = await sb.from("usuarios").select("*").order("usuario_id"); fail(error);
  return data!.map(userOut);
}
async function crearUsuario(token: string, d: any) {
  await requireRole(token, ["ADMIN"]);
  const nombre = sanitizar(d.nombre), email = sanitizar(d.email).toLowerCase(), rol = sanitizar(d.rol).toUpperCase();
  if (!noVacio(nombre)) throw new Error("El nombre es obligatorio.");
  if (!validarEmail(email)) throw new Error("El email no es válido.");
  if (!["ADMIN", "RECEPCION"].includes(rol)) throw new Error("El rol debe ser ADMIN o RECEPCION.");
  if (await buscarUsuarioPorEmail(email)) throw new Error("Ya existe un usuario con ese email.");
  const { data: all } = await sb.from("usuarios").select("usuario_id");
  const max = Math.max(0, ...(all || []).map((u) => parseInt(String(u.usuario_id).replace("USR", ""), 10) || 0));
  const id = "USR" + String(max + 1).padStart(3, "0");
  const { error } = await sb.from("usuarios").insert({ usuario_id: id, nombre, email, rol, activo: "SI" }); fail(error);
  return { ok: true, id };
}
async function actualizarUsuario(token: string, id: string, c: any) {
  await requireRole(token, ["ADMIN"]);
  const { data: u } = await sb.from("usuarios").select("usuario_id").eq("usuario_id", id).maybeSingle();
  if (!u) throw new Error("Usuario no encontrado.");
  const upd: any = {};
  if (c.nombre !== undefined) upd.nombre = sanitizar(c.nombre);
  if (c.rol !== undefined) {
    const rol = sanitizar(c.rol).toUpperCase();
    if (!["ADMIN", "RECEPCION"].includes(rol)) throw new Error("Rol inválido.");
    upd.rol = rol;
  }
  if (c.activo !== undefined) upd.activo = c.activo ? "SI" : "NO";
  const { error } = await sb.from("usuarios").update(upd).eq("usuario_id", id); fail(error);
  return { ok: true };
}

/* ===================== Canchas / horarios / config (admin) ===================== */

async function actualizarCancha(token: string, id: string, c: any) {
  await requireRole(token, ["ADMIN", "RECEPCION"]);
  const upd: any = {};
  if (c.nombre !== undefined) upd.nombre = sanitizar(c.nombre);
  if (c.tipo !== undefined) upd.tipo = sanitizar(c.tipo);
  if (c.precio !== undefined) {
    const p = Number(c.precio); if (isNaN(p) || p < 0) throw new Error("El precio debe ser un número válido.");
    upd.precio = p;
  }
  if (c.activa !== undefined) upd.activa = c.activa ? "SI" : "NO";
  const { data, error } = await sb.from("canchas").update(upd).eq("cancha_id", id).select("cancha_id"); fail(error);
  if (!data?.length) throw new Error("Cancha no encontrada.");
  return { ok: true };
}
async function actualizarHorario(token: string, id: string, c: any) {
  await requireRole(token, ["ADMIN"]);
  const upd: any = {}; if (c.activo !== undefined) upd.activo = c.activo ? "SI" : "NO";
  const { data, error } = await sb.from("horarios").update(upd).eq("horario_id", id).select("horario_id"); fail(error);
  if (!data?.length) throw new Error("Horario no encontrado.");
  return { ok: true };
}
async function actualizarConfig(token: string, cambios: Record<string, unknown>) {
  await requireRole(token, ["ADMIN"]);
  for (const [parametro, valor] of Object.entries(cambios || {})) {
    const { error } = await sb.from("config").update({ valor: valor == null ? "" : String(valor) }).eq("parametro", parametro); fail(error);
  }
  return { ok: true, config: await getConfig() };
}

/* ===================== Reservas ===================== */

const ocupa = (estado: unknown) => String(estado).toUpperCase() !== "CANCELADA";
const ESTADOS_VALIDOS = ["PARCIAL", "CONFIRMADA", "CANCELADA"];

function enr(r: any, canchas: Map<string, any>, horarios: Map<string, any>) {
  const c = canchas.get(r.cancha_id), h = horarios.get(r.horario_id);
  return {
    reservaId: r.reserva_id, fecha: r.fecha, fechaLegible: legible(r.fecha), horarioId: r.horario_id,
    horaInicio: h ? hhmm(h.hora_inicio) : "", horaFin: h ? hhmm(h.hora_fin) : "",
    canchaId: r.cancha_id, cancha: c ? c.nombre : r.cancha_id, clienteId: r.cliente_id, estado: r.estado,
    precio: Number(r.precio) || 0, pagado: Number(r.sena) || 0, saldo: Number(r.saldo) || 0,
    medioPago: r.medio_pago ?? "", creadoPor: r.creado_por ?? "", observaciones: r.observaciones || "",
  };
}
async function mapas() {
  const [c, h] = await Promise.all([sb.from("canchas").select("*"), sb.from("horarios").select("*")]);
  fail(c.error); fail(h.error);
  return { canchas: new Map(c.data!.map((x) => [x.cancha_id, x])), horarios: new Map(h.data!.map((x) => [x.horario_id, x])) };
}

async function getDisponibilidad(fecha: string) {
  if (!validarFechaFormato(fecha)) throw new Error("Fecha invalida.");
  const [canchas, horarios, { data: res, error }, cfg] = await Promise.all([
    listarCanchas(true), listarHorarios(true), sb.from("reservas").select("cancha_id,horario_id,estado").eq("fecha", fecha), getConfig(),
  ]);
  fail(error);
  const ocupados = new Set(res!.filter((r) => ocupa(r.estado)).map((r) => r.cancha_id + "_" + r.horario_id));
  const minHoras = Number(cfg.Anticipacion_Min_Horas) || 24;
  const grilla = horarios.map((h) => {
    const hrs = (inicioMs(fecha, h.horaInicio) - Date.now()) / 3600e3;
    return {
      horarioId: h.horarioId, horaInicio: h.horaInicio, horaFin: h.horaFin,
      canchas: canchas.map((c) => ({ canchaId: c.canchaId, nombreCancha: c.nombre, precio: c.precio, disponible: !ocupados.has(c.canchaId + "_" + h.horarioId) && hrs >= minHoras })),
    };
  });
  return { fecha, horarios: grilla };
}

async function validarDatosReserva(d: any) {
  if (!noVacio(d.fecha) || !validarFechaFormato(d.fecha)) throw new Error("La fecha ingresada no es válida.");
  if (!noVacio(d.horarioId)) throw new Error("Debés seleccionar un horario.");
  if (!noVacio(d.canchaId)) throw new Error("Debés seleccionar una cancha.");
  if (!noVacio(d.nombre)) throw new Error("El nombre es obligatorio.");
  if (!noVacio(d.apellido)) throw new Error("El apellido es obligatorio.");
  if (!noVacio(d.whatsapp) || !validarTelefono(d.whatsapp)) throw new Error("El número de WhatsApp ingresado no es válido.");
  if (!noVacio(d.email) || !validarEmail(d.email)) throw new Error("El email ingresado no es válido.");
  const cfg = await getConfig(), hoy = hoyAR();
  const maxDias = Number(cfg.Anticipacion_Max_Dias) || 14;
  if (d.fecha > addDays(hoy, maxDias)) throw new Error("No se pueden realizar reservas con más de " + maxDias + " días de anticipación.");
  if (d.fecha < hoy) throw new Error("No se pueden realizar reservas en fechas pasadas.");
}
function validarBasicasReserva(d: any) {
  if (!noVacio(d.fecha) || !validarFechaFormato(d.fecha)) throw new Error("La fecha ingresada no es valida.");
  if (!noVacio(d.horarioId)) throw new Error("Debes seleccionar un horario.");
  if (!noVacio(d.canchaId)) throw new Error("Debes seleccionar una cancha.");
  if (!noVacio(d.nombre)) throw new Error("El nombre es obligatorio.");
  if (!noVacio(d.apellido)) throw new Error("El apellido es obligatorio.");
  if (!noVacio(d.whatsapp) || !validarTelefono(d.whatsapp)) throw new Error("El WhatsApp ingresado no es valido.");
  if (!noVacio(d.email) || !validarEmail(d.email)) throw new Error("El email ingresado no es valido.");
}

async function crearReservaInterna(d: any, ctx: { monto: number; tipoPago: string; medioPago: string; esOnline: boolean; registradoPor: string; notaPago?: string }) {
  const { data, error } = await sb.rpc("crear_reserva", {
    p: {
      fecha: d.fecha, horario_id: d.horarioId, cancha_id: d.canchaId,
      nombre: sanitizar(d.nombre), apellido: sanitizar(d.apellido), whatsapp: sanitizar(d.whatsapp),
      email: sanitizar(d.email).toLowerCase(), observaciones: sanitizar(d.observaciones || ""),
      precio: d.precio ?? null, monto: ctx.monto, tipo_pago: ctx.tipoPago, medio_pago: sanitizar(ctx.medioPago || ""),
      es_online: ctx.esOnline, registrado_por: ctx.registradoPor, nota_pago: ctx.notaPago || "",
    },
  });
  fail(error);
  const reserva: any = data;
  bg(mailConfirmacion(reserva, { nombre: d.nombre, apellido: d.apellido, email: sanitizar(d.email).toLowerCase() }));
  if (ctx.registradoPor === "CLIENTE") {
    bg(notificarAdmin("🔔 Nueva reserva", `${reserva.cancha} · ${reserva.horaInicio} · ${d.nombre} ${d.apellido}`));
  }
  return { ok: true, reserva };
}

async function getReserva(id: string) {
  const { data, error } = await sb.from("reservas").select("*").eq("reserva_id", id).maybeSingle(); fail(error);
  return data;
}
async function getCliente(id: string) {
  const { data } = await sb.from("clientes").select("*").eq("cliente_id", id).maybeSingle(); return data;
}
async function cancelarRecordatorios(reservaId: string) {
  await sb.from("recordatorios").update({ estado: "CANCELADO" }).eq("reserva_id", reservaId).eq("estado", "PENDIENTE");
}

async function consultarReservaCliente(reservaId: string, email: string) {
  const r = await getReserva(reservaId);
  if (!r) throw new Error("No se encontro ninguna reserva con ese codigo.");
  const cli = await getCliente(r.cliente_id);
  if (!cli || String(cli.email).toLowerCase() !== String(email).toLowerCase()) throw new Error("El codigo de reserva y el email no coinciden.");
  const { canchas, horarios } = await mapas();
  const out: any = enr(r, canchas, horarios);
  out.puedeCancelar = false; out.motivoNoCancelable = "";
  if (String(r.estado).toUpperCase() === "CANCELADA") out.motivoNoCancelable = "Esta reserva ya esta cancelada.";
  else {
    const minHoras = Number((await getConfig()).Anticipacion_Min_Horas) || 24;
    const hrs = (inicioMs(r.fecha, horarios.get(r.horario_id).hora_inicio) - Date.now()) / 3600e3;
    if (hrs < minHoras) out.motivoNoCancelable = "Ya no se puede cancelar: faltan menos de " + minHoras + " horas para el turno.";
    else out.puedeCancelar = true;
  }
  return out;
}

async function cancelarReservaCliente(reservaId: string, email: string) {
  const r = await getReserva(reservaId);
  if (!r) throw new Error("No se encontro ninguna reserva con ese codigo.");
  const cli = await getCliente(r.cliente_id);
  if (!cli || String(cli.email).toLowerCase() !== String(email).toLowerCase()) throw new Error("El codigo de reserva y el email no coinciden.");
  if (String(r.estado).toUpperCase() === "CANCELADA") throw new Error("Esa reserva ya estaba cancelada.");
  const { canchas, horarios } = await mapas();
  const h = horarios.get(r.horario_id);
  const minHoras = Number((await getConfig()).Anticipacion_Min_Horas) || 24;
  if ((inicioMs(r.fecha, h.hora_inicio) - Date.now()) / 3600e3 < minHoras) {
    throw new Error("Ya no se puede cancelar: faltan menos de " + minHoras + " horas para el turno.");
  }
  const { error } = await sb.from("reservas").update({ estado: "CANCELADA" }).eq("reserva_id", reservaId); fail(error);
  await cancelarRecordatorios(reservaId);
  bg(mailCancelacion(r, cli));
  bg(notificarAdmin("❌ Cancelación", `${canchas.get(r.cancha_id)?.nombre || r.cancha_id} · ${hhmm(h.hora_inicio)} · ${cli.nombre} ${cli.apellido}`));
  return { ok: true, señaReembolsable: false };
}

async function reservasFormateadas(filtroFecha?: { desde?: string; hasta?: string; fecha?: string }) {
  let q = sb.from("reservas").select("*");
  if (filtroFecha?.fecha) q = q.eq("fecha", filtroFecha.fecha);
  const [{ data, error }, m, { data: clientes }] = await Promise.all([q, mapas(), sb.from("clientes").select("cliente_id,nombre,apellido,whatsapp,email")]);
  fail(error);
  const cmap = new Map((clientes || []).map((c) => [c.cliente_id, c]));
  return data!.map((r) => {
    const e: any = enr(r, m.canchas, m.horarios), c = cmap.get(r.cliente_id);
    if (c) { e.clienteNombre = c.nombre + " " + c.apellido; e.clienteWhatsapp = c.whatsapp; e.clienteEmail = c.email; }
    return e;
  }).sort((a, b) => b.fecha.localeCompare(a.fecha));
}

async function listarReservas(token: string, f: any) {
  await requireRole(token, ["ADMIN", "RECEPCION"]); f = f || {};
  let r = await reservasFormateadas();
  if (f.fecha) r = r.filter((x) => x.fecha === f.fecha);
  if (f.fechaDesde) r = r.filter((x) => x.fecha >= f.fechaDesde);
  if (f.fechaHasta) r = r.filter((x) => x.fecha <= f.fechaHasta);
  if (f.canchaId) r = r.filter((x) => x.canchaId === f.canchaId);
  if (f.estado) r = r.filter((x) => String(x.estado).toUpperCase() === String(f.estado).toUpperCase());
  return r;
}

async function obtenerCalendarioDia(token: string, fecha: string, filtros: any) {
  await requireRole(token, ["ADMIN", "RECEPCION"]);
  if (!validarFechaFormato(fecha)) throw new Error("Fecha invalida."); filtros = filtros || {};
  const [canchas, horarios, reservas] = await Promise.all([
    sb.from("canchas").select("*").order("cancha_id"), listarHorarios(false), reservasFormateadas({ fecha }),
  ]);
  fail(canchas.error);
  const activas = reservas.filter((r) => ocupa(r.estado));
  let filas = canchas.data!.map((c) => ({
    canchaId: c.cancha_id, nombre: c.nombre, activa: String(c.activa).toUpperCase() === "SI",
    celdas: horarios.map((h) => ({
      horarioId: h.horarioId, horaInicio: h.horaInicio, horaFin: h.horaFin, filtradoOculto: false,
      reserva: activas.find((r) => r.canchaId === c.cancha_id && r.horarioId === h.horarioId) || null as any,
    })),
  }));
  if (filtros.canchaId) filas = filas.filter((c) => c.canchaId === filtros.canchaId);
  if (filtros.estado) filas = filas.map((c) => ({ ...c, celdas: c.celdas.map((x) => ({ ...x, filtradoOculto: !!(x.reserva && x.reserva.estado !== filtros.estado) })) }));
  return { fecha, canchas: filas };
}

async function crearReservaAdmin(token: string, d: any) {
  const s = await requireRole(token, ["ADMIN", "RECEPCION"]);
  validarBasicasReserva(d);
  const pagoInicial = Number(d.pagoInicial) || 0;
  if (pagoInicial < 0) throw new Error("El pago inicial no puede ser negativo.");
  const { data: cancha } = await sb.from("canchas").select("precio").eq("cancha_id", d.canchaId).maybeSingle();
  const precioRef = d.precio ? Number(d.precio) : (cancha ? Number(cancha.precio) : 0);
  if (pagoInicial > precioRef) throw new Error("El pago inicial no puede superar el precio de la cancha.");
  return await crearReservaInterna(d, {
    monto: pagoInicial, tipoPago: pagoInicial >= precioRef && precioRef > 0 ? "TOTAL" : "SEÑA",
    medioPago: d.medioPago || "", esOnline: false, registradoPor: s.usuarioId,
  });
}

async function editarReserva(token: string, reservaId: string, c: any) {
  await requireRole(token, ["ADMIN", "RECEPCION"]);
  const r = await getReserva(reservaId); if (!r) throw new Error("Reserva no encontrada.");
  const upd: any = {};
  const nf = c.fecha !== undefined ? c.fecha : r.fecha, nh = c.horarioId !== undefined ? c.horarioId : r.horario_id, nc = c.canchaId !== undefined ? c.canchaId : r.cancha_id;
  if (nf !== r.fecha || nh !== r.horario_id || nc !== r.cancha_id) {
    if (!validarFechaFormato(nf)) throw new Error("Fecha invalida.");
    const { data: oc } = await sb.from("reservas").select("reserva_id,estado").eq("fecha", nf).eq("horario_id", nh).eq("cancha_id", nc).neq("reserva_id", reservaId);
    if ((oc || []).some((x) => ocupa(x.estado))) throw new Error("Ese turno ya esta ocupado por otra reserva.");
    upd.fecha = nf; upd.horario_id = nh; upd.cancha_id = nc;
  }
  if (c.estado !== undefined) {
    const e = String(c.estado).toUpperCase();
    if (!ESTADOS_VALIDOS.includes(e)) throw new Error("Estado invalido.");
    upd.estado = e; if (e === "CANCELADA") await cancelarRecordatorios(reservaId);
  }
  if (c.observaciones !== undefined) upd.observaciones = sanitizar(c.observaciones);
  if (c.medioPago !== undefined) upd.medio_pago = sanitizar(c.medioPago);
  if (c.precio !== undefined) {
    const p = Number(c.precio); if (isNaN(p) || p < 0) throw new Error("El precio debe ser un numero valido.");
    upd.precio = p; upd.saldo = Math.max(0, p - (Number(r.sena) || 0));
  }
  const { error } = await sb.from("reservas").update(upd).eq("reserva_id", reservaId);
  if (error) throw new Error((error as any).code === "23505" ? "Ese turno ya esta ocupado por otra reserva." : error.message);
  return { ok: true };
}

async function cancelarReservaAdmin(token: string, reservaId: string, motivo: string) {
  await requireRole(token, ["ADMIN", "RECEPCION"]);
  const r = await getReserva(reservaId); if (!r) throw new Error("Reserva no encontrada.");
  const obs = (r.observaciones ? r.observaciones + " | " : "") + "Cancelada por administracion" + (motivo ? ": " + sanitizar(motivo) : "");
  const { error } = await sb.from("reservas").update({ estado: "CANCELADA", observaciones: obs }).eq("reserva_id", reservaId); fail(error);
  await cancelarRecordatorios(reservaId);
  const cli = await getCliente(r.cliente_id); if (cli) bg(mailCancelacion(r, cli));
  return { ok: true };
}

/* ===================== Pagos manuales ===================== */

async function listarPagosPorReserva(token: string, reservaId: string) {
  await requireRole(token, ["ADMIN", "RECEPCION"]);
  const { data, error } = await sb.from("pagos").select("*").eq("reserva_id", reservaId).order("fecha"); fail(error);
  return data!.map((p) => ({ Pago_ID: p.pago_id, Reserva_ID: p.reserva_id, Fecha: p.fecha, Tipo: p.tipo, Monto: Number(p.monto), Medio_Pago: p.medio_pago, Registrado_Por: p.registrado_por, Observaciones: p.observaciones }));
}

async function registrarPago(token: string, d: any) {
  const s = await requireRole(token, ["ADMIN", "RECEPCION"]);
  const monto = Number(d.monto);
  if (isNaN(monto) || monto <= 0) throw new Error("El monto del pago debe ser un número mayor a 0.");
  const tipo = String(d.tipo || "").toUpperCase();
  if (!["SEÑA", "SALDO", "TOTAL"].includes(tipo)) throw new Error("El tipo de pago debe ser SEÑA, SALDO o TOTAL.");
  const { data, error } = await sb.rpc("registrar_pago", {
    p: { reserva_id: d.reservaId, monto, tipo, medio_pago: sanitizar(d.medioPago || ""), registrado_por: s.usuarioId, observaciones: sanitizar(d.observaciones || "") },
  });
  fail(error);
  return { ok: true, ...(data as any) };
}

/* ===================== Clientes ===================== */

async function listarClientes(token: string, filtro?: string) {
  await requireRole(token, ["ADMIN", "RECEPCION"]);
  const { data, error } = await sb.from("clientes").select("*").order("cliente_id"); fail(error);
  let out = data!.map((c) => ({
    clienteId: c.cliente_id, nombre: c.nombre, apellido: c.apellido, whatsapp: c.whatsapp, email: c.email,
    fechaAlta: c.fecha_alta ? tsLegible(c.fecha_alta) : "", activo: String(c.activo).toUpperCase() === "SI", observaciones: c.observaciones || "",
  }));
  if (filtro) { const f = filtro.toLowerCase(); out = out.filter((c) => (c.nombre + " " + c.apellido + " " + c.email).toLowerCase().includes(f)); }
  return out;
}
async function actualizarCliente(token: string, id: string, c: any) {
  await requireRole(token, ["ADMIN", "RECEPCION"]);
  if (!(await getCliente(id))) throw new Error("Cliente no encontrado.");
  const upd: any = {};
  if (c.nombre !== undefined) upd.nombre = sanitizar(c.nombre);
  if (c.apellido !== undefined) upd.apellido = sanitizar(c.apellido);
  if (c.whatsapp !== undefined) { if (!validarTelefono(c.whatsapp)) throw new Error("El WhatsApp ingresado no es valido."); upd.whatsapp = sanitizar(c.whatsapp); }
  if (c.email !== undefined) { if (!validarEmail(c.email)) throw new Error("El email ingresado no es valido."); upd.email = sanitizar(c.email).toLowerCase(); }
  if (c.activo !== undefined) upd.activo = c.activo ? "SI" : "NO";
  if (c.observaciones !== undefined) upd.observaciones = sanitizar(c.observaciones);
  const { error } = await sb.from("clientes").update(upd).eq("cliente_id", id); fail(error);
  return { ok: true };
}
async function historialCliente(token: string, clienteId: string) {
  await requireRole(token, ["ADMIN", "RECEPCION"]);
  const [{ data, error }, m] = await Promise.all([sb.from("reservas").select("*").eq("cliente_id", clienteId), mapas()]); fail(error);
  const reservas = data!.map((r) => enr(r, m.canchas, m.horarios)).sort((a, b) => b.fecha.localeCompare(a.fecha));
  const hoy = hoyAR();
  const act = reservas.filter((r) => r.estado !== "CANCELADA");
  const cc: Record<string, number> = {}, ch: Record<string, number> = {}, fr: Record<string, number> = { mañana: 0, tarde: 0, noche: 0 };
  act.forEach((r) => { cc[r.cancha] = (cc[r.cancha] || 0) + 1; ch[r.horaInicio] = (ch[r.horaInicio] || 0) + 1; fr[franja(r.horaInicio)]++; });
  const top = (o: Record<string, number>) => { let b: string | null = null, n = 0; for (const k in o) if (o[k] > n) { b = k; n = o[k]; } return b; };
  return {
    reservas,
    stats: {
      totalReservas: reservas.length, finalizadas: act.filter((r) => r.fecha < hoy).length,
      canceladas: reservas.filter((r) => r.estado === "CANCELADA").length, proximas: act.filter((r) => r.fecha >= hoy).length,
      ultimaReserva: reservas.length ? reservas[0].fechaLegible : "-", canchaMasUsada: top(cc) || "-", horarioHabitual: top(ch) || "-",
      reservasMañana: fr["mañana"], reservasTarde: fr.tarde, reservasNoche: fr.noche,
    },
  };
}

/* ===================== Dashboard ===================== */

function rangoPeriodo(p: string) {
  const hoy = hoyAR(); let desde = hoy, hasta = hoy;
  if (p === "7D") desde = addDays(hoy, -6);
  else if (p === "MES") desde = hoy.slice(0, 8) + "01";
  else if (p === "ANIO") desde = hoy.slice(0, 4) + "-01-01";
  else if (p === "MAÑANA") { desde = hasta = addDays(hoy, 1); }
  else if (p === "PROX_7D") hasta = addDays(hoy, 6);
  return { desde, hasta };
}
async function obtenerResumenDashboard(token: string, periodo: string) {
  await requireRole(token, ["ADMIN", "RECEPCION"]);
  periodo = ["HOY", "7D", "MES", "ANIO", "MAÑANA", "PROX_7D"].includes(periodo) ? periodo : "HOY";
  const { desde, hasta } = rangoPeriodo(periodo);
  const [{ data, error }, canchas, horarios] = await Promise.all([
    sb.from("reservas").select("*").gte("fecha", desde).lte("fecha", hasta), listarCanchas(true), listarHorarios(true),
  ]);
  fail(error);
  const act = data!.filter((r) => ocupa(r.estado));
  const cobrados = act.reduce((a, r) => a + (Number(r.sena) || 0), 0);
  const pendientes = act.reduce((a, r) => a + (Number(r.saldo) || 0), 0);
  const potenciales = act.reduce((a, r) => a + (Number(r.precio) || 0), 0);
  const dias = Math.max(1, Math.round((Date.parse(hasta) - Date.parse(desde)) / 86400000) + 1);
  const posibles = canchas.length * horarios.length * dias;
  const libres = Math.max(0, posibles - act.length);
  const uso = canchas.map((c) => {
    const n = act.filter((r) => r.cancha_id === c.canchaId).length, pos = horarios.length * dias;
    return { cancha: c.nombre, reservas: n, ocupacionPorc: pos > 0 ? Math.round((n / pos) * 100) : 0 };
  }).sort((a, b) => b.reservas - a.reservas);
  const ch: Record<string, number> = {};
  act.forEach((r) => { const h = horarios.find((x) => x.horarioId === r.horario_id); const l = h ? h.horaInicio : r.horario_id; ch[l] = (ch[l] || 0) + 1; });
  const hOrd = Object.keys(ch).sort().map((k) => ({ horario: k, reservas: ch[k] }));
  const hDem = hOrd.slice().sort((a, b) => b.reservas - a.reservas);
  const porDia: Record<string, number> = {};
  for (let f = desde; f <= hasta; f = addDays(f, 1)) porDia[f] = 0;
  act.forEach((r) => { if (porDia[r.fecha] !== undefined) porDia[r.fecha]++; });
  const fechas = Object.keys(porDia).sort();
  return {
    periodo,
    resumen: {
      reservas: act.length, ocupacionPorc: posibles > 0 ? Math.round((act.length / posibles) * 100) : 0, turnosLibres: libres,
      ingresosCobrados: cobrados, ingresosPendientes: pendientes, ingresosPotenciales: potenciales,
      progresoCobroPorc: potenciales > 0 ? Math.round((cobrados / potenciales) * 100) : 0,
      canchaMasUsada: uso.length ? uso[0].cancha : "-", horarioMasDemandado: hDem.length ? hDem[0].horario : "-",
    },
    graficos: {
      reservasPorDia: { etiquetas: fechas.map(legible), valores: fechas.map((f) => porDia[f]) },
      ocupacionPorCancha: { etiquetas: uso.map((u) => u.cancha), valores: uso.map((u) => u.ocupacionPorc) },
      reservasPorHorario: { etiquetas: hOrd.map((h) => h.horario), valores: hOrd.map((h) => h.reservas) },
      ocupacionDonut: { ocupados: act.length, disponibles: libres },
    },
  };
}

/* ===================== Mercado Pago ===================== */

async function mpFetch(metodo: "GET" | "POST", path: string, body?: unknown) {
  const t = Deno.env.get("MP_ACCESS_TOKEN"); if (!t) throw new Error("Falta configurar MP_ACCESS_TOKEN.");
  const r = await fetch("https://api.mercadopago.com" + path, {
    method: metodo, headers: { Authorization: "Bearer " + t, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text(); let j: any; try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
  if (!r.ok) { console.error(`Mercado Pago ${metodo} ${path} -> ${r.status}: ${txt}`); throw new Error("Mercado Pago respondió con error " + r.status + ". Probá de nuevo en unos minutos."); }
  return j;
}

async function iniciarPagoReserva(d: any, tipoPago: string) {
  await validarDatosReserva(d);
  tipoPago = String(tipoPago || "").toUpperCase();
  if (!["SEÑA", "TOTAL"].includes(tipoPago)) throw new Error("Elegi una forma de pago valida.");
  const [{ data: cancha }, { data: horario }] = await Promise.all([
    sb.from("canchas").select("*").eq("cancha_id", d.canchaId).maybeSingle(), sb.from("horarios").select("*").eq("horario_id", d.horarioId).maybeSingle(),
  ]);
  if (!cancha || String(cancha.activa).toUpperCase() !== "SI") throw new Error("La cancha seleccionada no esta disponible.");
  if (!horario || String(horario.activo).toUpperCase() !== "SI") throw new Error("El horario seleccionado no esta disponible.");
  const cfg = await getConfig();
  const minHoras = Number(cfg.Anticipacion_Min_Horas) || 24;
  if ((inicioMs(d.fecha, horario.hora_inicio) - Date.now()) / 3600e3 < minHoras) {
    throw new Error("Esta operación requiere al menos " + minHoras + " hora(s) de anticipación respecto al horario del turno.");
  }
  const { data: oc } = await sb.from("reservas").select("estado").eq("fecha", d.fecha).eq("horario_id", d.horarioId).eq("cancha_id", d.canchaId);
  if ((oc || []).some((r) => ocupa(r.estado))) throw new Error("Ese turno ya no esta disponible. Elegi otro horario.");

  const precio = Number(cancha.precio), pct = Number(cfg["Porcentaje_Seña"]) || 30;
  const monto = tipoPago === "TOTAL" ? precio : Math.round((precio * pct) / 100);
  if (!(monto > 0)) throw new Error("El monto a pagar no es valido. Contacta al club.");

  const token = crypto.randomUUID();
  const payload = {
    data: { fecha: d.fecha, horarioId: d.horarioId, canchaId: d.canchaId, nombre: sanitizar(d.nombre), apellido: sanitizar(d.apellido), whatsapp: sanitizar(d.whatsapp), email: sanitizar(d.email).toLowerCase(), observaciones: sanitizar(d.observaciones || "") },
    tipoPago, monto, precio,
  };
  const { error } = await sb.from("pagos_pendientes").insert({ token, payload, expira: new Date(Date.now() + 3600e3).toISOString() }); fail(error);

  const front = (Deno.env.get("FRONTEND_URL") || "").replace(/\/+$/, "");
  if (!front) throw new Error("Falta configurar FRONTEND_URL.");
  const ahora = new Date(), vence = new Date(ahora.getTime() + 30 * 60e3);
  const pref = await mpFetch("POST", "/checkout/preferences", {
    items: [{ id: d.canchaId + "-" + d.horarioId, title: `Reserva ${cancha.nombre} - ${d.fecha} ${hhmm(horario.hora_inicio)}` + (tipoPago === "TOTAL" ? " (pago total)" : " (seña)"), quantity: 1, unit_price: monto, currency_id: cfg.Moneda || "ARS" }],
    payer: { name: payload.data.nombre, surname: payload.data.apellido, email: payload.data.email },
    external_reference: token,
    back_urls: { success: `${front}/?pago=ok&t=${token}`, failure: `${front}/?pago=error&t=${token}`, pending: `${front}/?pago=pendiente&t=${token}` },
    auto_return: "approved",
    notification_url: `${SUPABASE_URL}/functions/v1/api?mp=1`,
    expires: true, expiration_date_from: isoAR(ahora), expiration_date_to: isoAR(vence),
    payment_methods: { excluded_payment_types: [{ id: "ticket" }, { id: "atm" }] },
  });
  if (!pref.init_point) throw new Error("No se pudo generar el link de pago. Probá de nuevo.");
  return { ok: true, pagoToken: token, urlPago: pref.init_point, monto, tipoPago, precio, resumen: { cancha: cancha.nombre, fecha: d.fecha, horaInicio: hhmm(horario.hora_inicio), horaFin: hhmm(horario.hora_fin) } };
}

async function verificarPagoReserva(pagoToken: string) {
  pagoToken = String(pagoToken || ""); if (!pagoToken) throw new Error("Falta el codigo de pago.");
  if (!/^[0-9a-f-]{36}$/i.test(pagoToken)) return { estado: "EXPIRADO" };
  const { data: row } = await sb.from("pagos_pendientes").select("*").eq("token", pagoToken).maybeSingle();
  if (!row) return { estado: "EXPIRADO" };
  if (row.resultado) return row.resultado;
  if (new Date(row.expira).getTime() < Date.now()) return { estado: "EXPIRADO" };
  const busq = await mpFetch("GET", "/v1/payments/search?sort=date_created&criteria=desc&limit=10&external_reference=" + encodeURIComponent(pagoToken));
  const aprobado = (busq.results || []).find((p: any) => p.status === "approved");
  if (!aprobado) return { estado: "PENDIENTE" };
  return await confirmarPagoMP(pagoToken, aprobado);
}

async function confirmarPagoMP(token: string, pago: any): Promise<any> {
  const { data: row } = await sb.from("pagos_pendientes").select("*").eq("token", token).maybeSingle();
  if (!row) return { estado: "EXPIRADO" };
  if (row.resultado) return row.resultado;
  const payload: any = row.payload;
  if (pago.status !== "approved") return { estado: "PENDIENTE" };
  if (String(pago.external_reference) !== token) { console.error("external_reference no coincide"); return { estado: "PENDIENTE" }; }
  if (Math.abs(Number(pago.transaction_amount) - Number(payload.monto)) > 0.01) { console.error(`Monto no coincide. MP: ${pago.transaction_amount} esperado: ${payload.monto}`); return { estado: "PENDIENTE" }; }

  // Idempotencia: sólo un proceso (webhook o vuelta del cliente) puede crear la reserva
  const { data: claim } = await sb.from("pagos_pendientes").update({ procesando: true }).eq("token", token).eq("procesando", false).is("resultado", null).select("token").maybeSingle();
  if (!claim) {
    const { data: again } = await sb.from("pagos_pendientes").select("resultado").eq("token", token).maybeSingle();
    return again?.resultado || { estado: "PENDIENTE" };
  }
  let salida: any;
  try {
    const r = await crearReservaInterna(payload.data, { monto: payload.monto, tipoPago: payload.tipoPago, medioPago: "MERCADO_PAGO", esOnline: true, registradoPor: "CLIENTE", notaPago: "Pago online Mercado Pago #" + pago.id });
    salida = { estado: "CONFIRMADO", reserva: r.reserva };
  } catch (err) {
    const msg = (err as Error).message;
    salida = { estado: "CONFLICTO", mensaje: msg, mpPagoId: pago.id };
    bg(avisarConflicto(payload, pago, msg));
  }
  await sb.from("pagos_pendientes").update({ resultado: salida }).eq("token", token);
  return salida;
}

async function avisarConflicto(payload: any, pago: any, motivo: string) {
  console.error(`PAGO SIN TURNO. MP #${pago.id} - ${motivo}`);
  const destino = (await getConfig()).Email_Club; if (!destino) return;
  const p = payload.data;
  await enviarMail(destino, `Pago aprobado sin turno asignado (Mercado Pago #${pago.id})`,
    `<p>Se aprobó un pago en Mercado Pago pero el turno ya no estaba disponible.</p><p>Pago: #${pago.id}<br>Monto: ${pago.transaction_amount}<br>Cliente: ${p.nombre} ${p.apellido}<br>Email: ${p.email}<br>WhatsApp: ${p.whatsapp}<br>Turno pedido: ${p.fecha} (horario ${p.horarioId}, cancha ${p.canchaId})<br>Motivo: ${motivo}</p><p>Hay que devolverle el dinero desde el panel de Mercado Pago o reubicar al cliente.</p>`);
}

async function webhookMP(req: Request, url: URL) {
  try {
    let tipo = url.searchParams.get("type") || url.searchParams.get("topic") || "";
    let id = url.searchParams.get("data.id") || url.searchParams.get("id") || "";
    try { const b = JSON.parse(await req.text()); if (b?.type) tipo = b.type; if (b?.data?.id) id = String(b.data.id); } catch { /* sin cuerpo JSON */ }
    if ((tipo && tipo !== "payment") || !id) return;
    const pago = await mpFetch("GET", "/v1/payments/" + encodeURIComponent(id)); // nunca se confía en el aviso
    if (pago.status === "approved" && pago.external_reference) await confirmarPagoMP(String(pago.external_reference), pago);
  } catch (e) { console.error("Webhook Mercado Pago: " + (e as Error).message); }
}

/* ===================== Recordatorios (cron cada hora) ===================== */

async function procesarRecordatoriosPendientes() {
  const { data, error } = await sb.from("recordatorios").select("*").eq("estado", "PENDIENTE").lte("fecha_programada", new Date().toISOString()); fail(error);
  if (!data?.length) return { procesados: 0 };
  const m = await mapas(); let n = 0;
  for (const rec of data) {
    const { data: claim } = await sb.from("recordatorios").update({ estado: "ENVIANDO" }).eq("recordatorio_id", rec.recordatorio_id).eq("estado", "PENDIENTE").select("recordatorio_id").maybeSingle();
    if (!claim) continue;
    const r = await getReserva(rec.reserva_id);
    if (!r || String(r.estado).toUpperCase() === "CANCELADA") { await sb.from("recordatorios").update({ estado: "CANCELADO" }).eq("recordatorio_id", rec.recordatorio_id); continue; }
    const c = m.canchas.get(r.cancha_id), h = m.horarios.get(r.horario_id);
    const html = await wrapHtml("Recordatorio de turno", `<p>¡Te esperamos! Recordá tu turno de mañana:</p><table style="width:100%;border-collapse:collapse;margin-top:12px;">${fila("Código de reserva", r.reserva_id)}${fila("Cancha", c ? c.nombre : r.cancha_id)}${fila("Fecha", legible(r.fecha))}${fila("Horario", h ? hhmm(h.hora_inicio) + " - " + hhmm(h.hora_fin) : "")}</table>`);
    const ok = await enviarMail(rec.email, "Recordatorio de tu turno - " + r.reserva_id, html);
    await sb.from("recordatorios").update({ estado: ok ? "ENVIADO" : "ERROR", fecha_envio: ok ? new Date().toISOString() : null }).eq("recordatorio_id", rec.recordatorio_id);
    n++;
  }
  return { procesados: n };
}

/* ===================== Router ===================== */

const API: Record<string, (...a: any[]) => Promise<unknown>> = {
  obtenerDatosInicialesCliente, getDisponibilidad, iniciarPagoReserva, verificarPagoReserva, consultarReservaCliente,
  cancelarReservaCliente, listarCanchas, listarHorarios, getConfig,
  solicitarCodigoAcceso, verificarCodigo, validarSesionActual, cerrarSesion,
  listarUsuarios, crearUsuario, actualizarUsuario, listarClientes, actualizarCliente, historialCliente,
  listarReservas, crearReservaAdmin, cancelarReservaAdmin, editarReserva, registrarPago, listarPagosPorReserva,
  obtenerCalendarioDia, obtenerResumenDashboard, actualizarCancha, actualizarHorario, actualizarConfig,
  procesarRecordatoriosPendientes,
};

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  if (url.searchParams.get("mp") === "1") { await webhookMP(req, url); return new Response("OK", { headers: CORS }); }
  if (req.method !== "POST") return json({ ok: true, servicio: "Areco Padel API" });
  try {
    const body = JSON.parse(await req.text());
    if (!Object.hasOwn(API, body?.fn)) throw new Error("Función no permitida: " + body?.fn);
    const result = await API[body.fn](...(Array.isArray(body.args) ? body.args : []));
    return json({ ok: true, result });
  } catch (e) {
    console.error((e as Error).message);
    return json({ ok: false, error: (e as Error).message || String(e) });
  }
});
