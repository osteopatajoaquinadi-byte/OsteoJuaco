// ─────────────────────────────────────────────────────────────
// ASISTENTE R.E.S.T. — Servidor puente Instagram ↔ Claude IA
// © Joaquín Adi A. — Todos los derechos reservados
// v3.0 — Agenda de www.sakros.cl (antes Wix Bookings)
// ─────────────────────────────────────────────────────────────

const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ── Variables de entorno ──────────────────────────────────────
const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;

// ── Agenda de sakros.cl ───────────────────────────────────────
// El bot consulta horas y reserva directo en la agenda de www.sakros.cl
// (la misma de la web y del panel del equipo). Wix ya no se usa.
const SAKROS_SITE_URL = (process.env.SAKROS_SITE_URL || "https://www.sakros.cl").replace(/\/$/, "");

const SERVICE_LABELS = {
  kinesiologia: "Kinesiología",
  osteopatia:   "Osteopatía",
  posturologia: "Posturología Clínica",
  motion:       "Estudio biomecánico del pie",
  rest:         "Método R.E.S.T. acompañado (sesión online)",
};

// Servicio de sakros.cl cuyos horarios se consultan. El Método R.E.S.T.
// acompañado usa los horarios de osteopatía de Joaquín.
const SAKROS_AVAILABILITY = {
  kinesiologia: "kinesiologia",
  osteopatia:   "osteopatia",
  posturologia: "posturologia",
  motion:       "estudio-biomecanico",
  rest:         "osteopatia",
};

// ── Método R.E.S.T. acompañado (palabra clave "sueño") ───────
const REST_ACOMPANADO_PRECIO = "$97.000";
// Link de pago Mercado Pago del programa acompañado (se puede sobreescribir con REST_PAYMENT_URL)
const REST_PAYMENT_URL = process.env.REST_PAYMENT_URL || "https://mpago.la/2hyPNh4";

// Pago online por servicio (Mercado Pago). Se incluye en el comprobante.
const PAYMENT_LINKS = {
  osteopatia: "https://mpago.la/2tDadem", // sesión unitaria
};

// Programa de 5 sesiones de osteopatía (pago con Mercado Pago).
const OSTEO_PACK = { nombre: "Programa de 5 sesiones de osteopatía", precio: "$185.000", vigencia: "6 meses", link: "https://mpago.la/1idmHEA" };

// ── Base de datos de Sakros (opcional) ───────────────────────
// Solo se usa para reservar cuando el paciente no da email (la reserva web
// lo exige) y para encontrar el servicio del Método R.E.S.T.
const SAKROS_SUPABASE_URL = process.env.SAKROS_SUPABASE_URL;
const SAKROS_SUPABASE_KEY = process.env.SAKROS_SUPABASE_SERVICE_KEY;

// ── Memoria de conversaciones ─────────────────────────────────
const conversations = {};

// ── Pausa cuando Joaquín responde a mano ──────────────────────
// Si Joaquín escribe él mismo en un DM (desde la app de Instagram), el bot deja
// de responder a esa persona durante 12 horas para no cruzarse con él.
// Instagram avisa cada mensaje que sale de la cuenta como "eco". Los que mandó
// el bot se reconocen por su message_id, por su texto o (imágenes) porque el
// bot acaba de enviar una. El eco puede llegar antes que la respuesta de la
// API, así que se revisa unos segundos después.
const PAUSA_MANUAL_MS = 12 * 60 * 60 * 1000;
const ESPERA_ECO_MS = 8000;
const RECIENTE_MS = 10 * 60 * 1000;
const pausedUntil = {};
const botMessageIds = new Set();
const botTextosRecientes = new Map(); // texto → cuándo lo envió el bot
let ultimaImagenBot = 0;

function registrarEnvioBot(response, { texto, imagen } = {}) {
  const ahora = Date.now();
  const mid = response?.data?.message_id;
  if (mid) {
    botMessageIds.add(mid);
    // Que el registro no crezca sin límite
    if (botMessageIds.size > 5000) botMessageIds.delete(botMessageIds.values().next().value);
  }
  if (texto) botTextosRecientes.set(texto.trim(), ahora);
  if (imagen) ultimaImagenBot = ahora;
  for (const [t, cuando] of botTextosRecientes) {
    if (ahora - cuando > RECIENTE_MS) botTextosRecientes.delete(t);
  }
}

function ecoEsDelBot(message) {
  if (message.mid && botMessageIds.has(message.mid)) return true;
  if (message.text && botTextosRecientes.has(message.text.trim())) return true;
  if (!message.text && message.attachments && Date.now() - ultimaImagenBot < 60000) return true;
  return false;
}

function botPausado(userId) {
  if (!pausedUntil[userId]) return false;
  if (Date.now() < pausedUntil[userId]) return true;
  delete pausedUntil[userId];
  return false;
}

// ── Horarios disponibles en sakros.cl ─────────────────────────
// Caché de horas ofrecidas. Clave: slot_id que ve Claude. Así Claude nunca
// reconstruye fechas a mano: reserva exactamente la hora que mostró.
const slotCache = {};

function purgeSlotCache() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(slotCache)) {
    if (entry.cachedAt < cutoff) delete slotCache[id];
  }
}

// Fecha YYYY-MM-DD en Chile, desplazada `days` días.
function chileDate(days = 0) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const MAX_SLOTS = 6;
const MAX_POR_DIA = 2; // para ofrecer días distintos

async function getAvailableSlots(serviceKey) {
  const slug = SAKROS_AVAILABILITY[serviceKey];
  if (!slug) return { error: `Servicio "${serviceKey}" no encontrado` };
  try {
    purgeSlotCache();
    const from = chileDate(1);
    const week = await axios.get(`${SAKROS_SITE_URL}/api/week-availability`, {
      params: { service: slug, weekStart: from, days: 14 },
      timeout: 15000,
    });
    const dias = Object.entries(week.data?.available || {})
      .filter(([, n]) => n > 0)
      .map(([d]) => d)
      .sort();

    const ofrecidos = [];
    for (const date of dias) {
      if (ofrecidos.length >= MAX_SLOTS) break;
      const { data } = await axios.get(`${SAKROS_SITE_URL}/api/availability`, {
        params: { service: slug, date },
        timeout: 15000,
      });
      for (const s of (data?.slots || []).slice(0, MAX_POR_DIA)) {
        if (ofrecidos.length >= MAX_SLOTS) break;
        const id = `${serviceKey}_${ofrecidos.length}`;
        slotCache[id] = {
          serviceKey,
          serviceId: data.service?.id,
          professionalId: s.professional_id,
          professionalName: s.professional_name,
          date,
          time: s.time,
          cachedAt: Date.now(),
        };
        ofrecidos.push({
          slot_id: id,
          horario: formatSlotDate(`${date}T${s.time}:00`),
          profesional: s.professional_name,
        });
      }
    }
    console.log(`📅 Horas de sakros.cl para ${serviceKey}: ${ofrecidos.length}`);
    return ofrecidos;
  } catch (error) {
    console.error("❌ Error agenda sakros.cl:", error.response?.status, error.response?.data || error.message);
    return { error: "No se pudo consultar disponibilidad. Sugiere al paciente agendar en www.sakros.cl/reserva" };
  }
}

// ── Crear reserva en sakros.cl ────────────────────────────────
// Con email se usa la reserva de la web: el paciente recibe su correo, el
// profesional la invitación de calendario y la clínica el aviso. Sin email
// se registra directo en la base de datos (si está configurada).
async function createBooking(slotId, name, email, phone) {
  const entry = slotCache[slotId];
  if (!entry) {
    console.error(`❌ slot_id desconocido o expirado: ${slotId}`);
    return {
      success: false,
      error: "Ese horario ya no está en memoria. Vuelve a consultar disponibilidad y pide al paciente que elija de nuevo.",
    };
  }

  const { serviceKey, professionalId, professionalName, date, time } = entry;
  const esRest = serviceKey === "rest";
  let serviceId = entry.serviceId;
  if (esRest) {
    const restId = await getSakrosServiceId("metodo-rest");
    if (restId) serviceId = restId;
  }
  const notes = [esRest ? "Método R.E.S.T. acompañado (online)" : null, "Agendado por OsteoJuaco (Instagram)"]
    .filter(Boolean)
    .join(" · ");

  try {
    let bookingId = null;
    if (email) {
      const { data } = await axios.post(
        `${SAKROS_SITE_URL}/api/bookings`,
        {
          service_id: serviceId,
          professional_id: professionalId,
          booking_date: date,
          start_time: time,
          client_name: name,
          client_email: email,
          client_phone: phone || null,
          // El R.E.S.T. se paga antes (link del programa); el resto en la clínica.
          payment_method: esRest ? "online_webpay" : "in_clinic",
          notes,
        },
        { timeout: 20000 }
      );
      bookingId = data?.booking?.id || null;
    } else {
      bookingId = await insertSakrosBooking({ serviceId, professionalId, date, time, name, phone, notes });
      if (!bookingId) {
        return {
          success: false,
          error: "Para reservar necesito su email (ahí le llega la confirmación). Pídeselo amablemente y vuelve a intentar con el mismo slot_id.",
        };
      }
    }
    delete slotCache[slotId];
    console.log(`📋 Reserva creada en sakros.cl: ${bookingId}`);

    return {
      success: true,
      bookingId,
      status: "CONFIRMED",
      detalle: {
        servicio: SERVICE_LABELS[serviceKey] || serviceKey,
        fecha: formatSlotDate(`${date}T${time}:00`),
        profesional: professionalName,
        direccion: esRest
          ? "Online — te enviaremos el link de la videollamada"
          : "9 Norte 555, Edificio Emporium, Of. 201, Viña del Mar",
        paciente: name,
        serviceKey,
      },
    };
  } catch (error) {
    const status = error.response?.status;
    console.error("❌ Error reserva sakros.cl:", status, JSON.stringify(error.response?.data || error.message));
    const hint = status === 409
      ? "Ese horario acaba de ser tomado por otra persona. Vuelve a consultar disponibilidad y ofrécele otras horas."
      : "No se pudo crear la reserva. Discúlpate brevemente y sugiere al paciente agendar en www.sakros.cl/reserva o llamar a la secretaria al +56945399692.";
    return { success: false, error: hint };
  }
}

// ── Formatear fecha legible ───────────────────────────────────
function formatSlotDate(isoDate) {
  if (!isoDate) return "Horario disponible";
  const d = new Date(isoDate);
  const days = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
  const months = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  return `${days[d.getDay()]} ${d.getDate()} de ${months[d.getMonth()]} a las ${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`;
}

// ── Base de datos de Sakros (Supabase REST, opcional) ────────
const sakrosEnabled = () => Boolean(SAKROS_SUPABASE_URL && SAKROS_SUPABASE_KEY);
const sakrosHeaders = () => ({
  apikey: SAKROS_SUPABASE_KEY,
  Authorization: `Bearer ${SAKROS_SUPABASE_KEY}`,
  "Content-Type": "application/json",
});

const serviceIdCache = {};
async function getSakrosServiceId(slug) {
  if (!sakrosEnabled()) return null;
  if (serviceIdCache[slug]) return serviceIdCache[slug];
  try {
    const { data } = await axios.get(
      `${SAKROS_SUPABASE_URL}/rest/v1/services?select=id&slug=eq.${encodeURIComponent(slug)}`,
      { headers: sakrosHeaders() }
    );
    serviceIdCache[slug] = data?.[0]?.id || null;
    return serviceIdCache[slug];
  } catch (err) {
    console.error("⚠️ No se pudo leer el servicio:", err.response?.status, err.message);
    return null;
  }
}

// Reserva directa (sin email). La ficha del paciente la crea/vincula el
// trigger de la base de datos.
async function insertSakrosBooking({ serviceId, professionalId, date, time, name, phone, notes }) {
  if (!sakrosEnabled()) return null;
  const [h, m] = time.split(":").map(Number);
  const end = `${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  try {
    const { data } = await axios.post(
      `${SAKROS_SUPABASE_URL}/rest/v1/bookings`,
      {
        professional_id: professionalId,
        service_id: serviceId,
        booking_date: date,
        start_time: time,
        end_time: end,
        client_name: name,
        client_email: "",
        client_phone: phone || null,
        status: "confirmed",
        payment_status: "pending",
        payment_method: "in_clinic",
        notes,
      },
      { headers: { ...sakrosHeaders(), Prefer: "return=representation" } }
    );
    return data?.[0]?.id || null;
  } catch (err) {
    console.error("⚠️ No se pudo registrar la reserva:", err.response?.status, JSON.stringify(err.response?.data || err.message));
    return null;
  }
}


// ── Tools para Claude ─────────────────────────────────────────
const CLAUDE_TOOLS = [
  {
    name: "consultar_disponibilidad",
    description: "Consulta los horarios disponibles en Clínica Sakros para los próximos 14 días (agenda de www.sakros.cl). Usa esta herramienta cuando el paciente quiera agendar una cita, pida horarios, o acepte tu sugerencia de derivación a un servicio. NO la uses solo para informar sobre servicios — úsala cuando haya intención real de agendar.",
    input_schema: {
      type: "object",
      properties: {
        servicio: {
          type: "string",
          enum: ["kinesiologia", "osteopatia", "posturologia", "motion", "rest"],
          description: "El servicio a consultar: rest (sesión online del Método R.E.S.T. acompañado — SOLO cuando la persona ya aceptó entrar al programa acompañado de $97.000), kinesiologia (lesiones musculoesqueléticas, esguinces, tendinopatías), osteopatia (dolor crónico, fibromialgia, columna, bruxismo, problemas digestivos), posturologia (postura, déficit atencional, TEA, problemas visuales funcionales, niños), motion (alteraciones de marcha, dolor de pie, plantillas)",
        },
      },
      required: ["servicio"],
    },
  },
  {
    name: "crear_reserva",
    description: "Crea una reserva REAL en la agenda de Clínica Sakros (www.sakros.cl). Usa esta herramienta SOLO cuando tengas: 1) el slot_id exacto que el paciente eligió (de los que devolvió consultar_disponibilidad), 2) su nombre completo y 3) su email (ahí le llega la confirmación y el recordatorio). Pide también su teléfono si lo quiere dar.",
    input_schema: {
      type: "object",
      properties: {
        slot_id: {
          type: "string",
          description: "El slot_id EXACTO del horario que eligió el paciente, copiado literal del resultado de consultar_disponibilidad (ej: 'osteopatia_2'). NUNCA lo inventes ni lo modifiques.",
        },
        nombre: {
          type: "string",
          description: "Nombre completo del paciente",
        },
        email: {
          type: "string",
          description: "Email del paciente. Pídelo siempre: ahí le llega la confirmación y el recordatorio del día anterior.",
        },
        telefono: {
          type: "string",
          description: "Teléfono del paciente (vacío si solo dio email)",
        },
      },
      required: ["slot_id", "nombre"],
    },
  },
  {
    name: "avisar_joaquin",
    description: "Reenvía la conversación a Joaquín cuando el paciente pide hablar con él directamente, o cuando no sabes responder una pregunta con seguridad. Úsala después de decirle al paciente que Joaquín le responderá.",
    input_schema: {
      type: "object",
      properties: {
        motivo: {
          type: "string",
          description: "Breve resumen de por qué se deriva: qué pidió o preguntó el paciente",
        },
      },
      required: ["motivo"],
    },
  },
];

// ── Ejecutar tool calls ───────────────────────────────────────
async function executeTool(toolName, toolInput, senderId) {
  console.log(`🔧 Tool call: ${toolName}(${JSON.stringify(toolInput)})`);

  if (toolName === "consultar_disponibilidad") {
    const serviceKey = toolInput.servicio;
    const result = await getAvailableSlots(serviceKey);
    if (Array.isArray(result)) {
      console.log(`📅 Slots ofrecidos: ${result.length}`);
      if (result.length === 0) {
        return JSON.stringify({
          slots: [],
          nota: "No hay horarios disponibles en los próximos 14 días. Sugiere agendar en www.sakros.cl o llamar a la secretaria al +56945399692.",
        });
      }
    }
    return JSON.stringify(result);
  }

  if (toolName === "crear_reserva") {
    const result = await createBooking(
      toolInput.slot_id,
      toolInput.nombre,
      toolInput.email || "",
      toolInput.telefono || ""
    );

    // Comprobante por DM (además del correo de sakros.cl si dio email)
    if (result.success && result.detalle && senderId) {
      const d = result.detalle;
      const confirmada = result.status === "CONFIRMED";
      const encabezado = confirmada
        ? "✅ *Tu hora quedó agendada en Clínica Sakros*"
        : "📩 *Recibimos tu solicitud de hora en Clínica Sakros*";
      const cierre = confirmada
        ? "Si necesitas reagendar o cancelar, escríbeme por aquí o llama a la secretaria al *+56945399692*."
        : "Te confirmaremos el horario a la brevedad. Ante cualquier duda, llama a la secretaria al *+56945399692*.";

      const comprobante = [
        encabezado,
        "",
        `🩺 *Servicio:* ${d.servicio}`,
        `📅 *Fecha:* ${d.fecha}`,
        ...(d.profesional ? [`👨‍⚕️ *Profesional:* ${d.profesional}`] : []),
        `📍 *Dirección:* ${d.direccion}`,
        `👤 *A nombre de:* ${d.paciente}`,
        ...(d.serviceKey === "rest" && REST_PAYMENT_URL
          ? ["", `💳 *Pago del programa (${REST_ACOMPANADO_PRECIO}):* ${REST_PAYMENT_URL}`]
          : []),
        ...(d.serviceKey !== "rest" && PAYMENT_LINKS[d.serviceKey]
          ? ["", `💳 *Paga online aquí:* ${PAYMENT_LINKS[d.serviceKey]} (o en la clínica)`]
          : []),
        "",
        cierre,
      ].join("\n");

      try {
        await sendInstagramMessage(senderId, comprobante);
        result.comprobante_enviado = true;
        result.nota_bot = "Ya se le envió al paciente un comprobante con todos los datos. Tu respuesta debe ser breve y cálida, SIN repetir los datos de la reserva.";
      } catch (err) {
        console.error("⚠️ No se pudo enviar el comprobante:", err.message);
      }
    }

    return JSON.stringify(result);
  }

  if (toolName === "avisar_joaquin") {
    try {
      await sendInstagramMessage(
        OWNER_IG_ID,
        `🔔 *Un paciente quiere hablar contigo*\n\n📝 Motivo: ${toolInput.motivo}\n\n(Instagram ID: ${senderId})\n\nEntra a los DMs para responderle.`
      );
      console.log(`🔔 Derivación a Joaquín: ${toolInput.motivo} (de ${senderId})`);
      return JSON.stringify({
        success: true,
        nota_bot: "Ya le avisaste a Joaquín. Confirma al paciente de forma breve y cálida que Joaquín le responderá pronto por aquí. NO inventes tiempos exactos.",
      });
    } catch (err) {
      console.error("⚠️ No se pudo avisar a Joaquín:", err.message);
      return JSON.stringify({
        success: false,
        nota_bot: "No se pudo avisar automáticamente. Dile al paciente que puede escribir directamente a Joaquín por WhatsApp: https://wa.me/56968477060",
      });
    }
  }

  return JSON.stringify({ error: "Herramienta no reconocida" });
}

// ── Llamar a Claude con soporte de tools (loop hasta texto) ──
async function callClaude(senderId) {
  const messages = conversations[senderId];
  let maxToolRounds = 3; // evitar loops infinitos

  while (maxToolRounds > 0) {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-sonnet-4-6",
        max_tokens: 500,
        system:     SYSTEM_PROMPT,
        tools:      CLAUDE_TOOLS,
        messages:   messages,
      },
      {
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type":      "application/json",
        },
      }
    );

    const content = response.data.content || [];
    const stopReason = response.data.stop_reason;

    // Si Claude quiere usar una tool
    if (stopReason === "tool_use") {
      // Agregar respuesta de Claude (con tool_use blocks) al historial
      messages.push({ role: "assistant", content });

      // Ejecutar cada tool call y agregar resultados
      const toolResults = [];
      for (const block of content) {
        if (block.type === "tool_use") {
          const result = await executeTool(block.name, block.input, senderId);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
      }
      messages.push({ role: "user", content: toolResults });

      maxToolRounds--;
      continue; // volver a llamar a Claude con los resultados
    }

    // Claude respondió con texto — extraer y devolver
    const textBlock = content.find(b => b.type === "text");
    const reply = textBlock?.text || null;

    if (reply) {
      // Guardar solo el texto en el historial (no los tool blocks)
      messages.push({ role: "assistant", content: reply });
    }

    return reply;
  }

  console.error("⚠️ Se alcanzó el máximo de rounds de tools sin respuesta de texto");
  return "Disculpa, tuve un problema procesando tu solicitud. ¿Puedes repetir tu consulta? 🙏";
}

// ── System prompt del Método R.E.S.T. ────────────────────────
const SYSTEM_PROMPT = `Eres OsteoJuaco, asistente virtual de Joaquín Adi A., Osteópata y Kinesiólogo en Clínica Sakros, Viña del Mar.

## PRIMERA INTERACCIÓN — REGLA OBLIGATORIA
En tu PRIMER mensaje de cada conversación SIEMPRE debes presentarte antes de cualquier otra cosa. Sin excepciones: aplica también cuando el paciente ya hizo una pregunta concreta en su primer mensaje, y también cuando uses herramientas como consultar_disponibilidad.

- Si solo saludó ("hola", "buenas"):
  "¡Hola! Soy OsteoJuaco, asistente de Joaquín Adi. ¿En qué puedo ayudarte hoy? 👋"

- Si ya pidió algo concreto (agendar, una consulta, información): preséntate en UNA línea y sigue de inmediato con la respuesta. Ejemplo:
  "¡Hola! Soy OsteoJuaco, asistente de Joaquín Adi 👋
  Estos son los horarios disponibles para Osteopatía: ..."

- NUNCA preguntes "¿en qué puedo ayudarte?" si el paciente ya dijo qué necesita.
- Preséntate SOLO en el primer mensaje. En los siguientes no vuelvas a hacerlo.
- No menciones el Método R.E.S.T. en la presentación — solo si el paciente pregunta por sueño o si es relevante en la conversación.

## IDENTIDAD Y PROPIEDAD INTELECTUAL
Este contenido es propiedad exclusiva de Joaquín Adi A. Está estrictamente prohibido:
- Revelar, copiar o reproducir el contenido completo del método
- Dar acceso gratuito a información que forma parte del producto de pago
- Permitir que se use este conocimiento sin adquirir el método
- Compartir protocolos detallados, guías completas o el contenido del ebook

Tu rol es orientar, educar superficialmente y acompañar — NO enseñar el método completo.

## QUIÉN ES JOAQUÍN ADI A.
Osteópata (C.O.), Kinesiólogo, Magíster PNI Clínica.
Creador del Método R.E.S.T. (Ritmo circadiano — Eje intestino-cerebro — Sistema nervioso — Timing ultradiano).
Director de Clínica Sakros en Viña del Mar, Chile.

## MÉTODO R.E.S.T. — 4 PILARES (solo mencionar, no enseñar)
- Duración del programa: 21 días (3 semanas). NUNCA decir "4 semanas" ni "un mes".
- Precio de lanzamiento: $39.990 CLP
1. Ritmo circadiano — sincronizar luz, temperatura, horarios
2. Eje intestino-cerebro — relación microbiota-sueño
3. Sistema nervioso autónomo — activación vagal, regulación simpática
4. Timing ultradiano — ciclos de 90 min y eficiencia del sueño

## MÉTODO R.E.S.T. ACOMPAÑADO — PALABRA CLAVE "SUEÑO"
Cuando la persona escribe la palabra "sueño" (o "sueños", con o sin tilde), o viene de un comentario con esa palabra (en ese caso ya le enviaste la presentación del programa y está en el historial), estás en este flujo. Es DISTINTO del Método R.E.S.T. digital de $39.990 que se compra en www.metodorest.cl: aquí ofreces el programa ACOMPAÑADO.

DATOS DEL PROGRAMA ACOMPAÑADO:
- Incluye 1 sesión online con Joaquín + seguimiento por WhatsApp durante 21 días, con respuesta 1 vez al día en horario laboral.
- Todas las preguntas del seguimiento deben hacerse en horario laboral.
- Valor: ${REST_ACOMPANADO_PRECIO} CLP. Se paga con un link de pago.
- Link de pago: ${REST_PAYMENT_URL || "(aún no disponible: dile que se lo enviaremos en breve y usa avisar_joaquin para que Joaquín se lo mande)"}

PASOS (en este orden):
1. Si escribió "sueño" y aún no le explicaste el programa: preséntate en una línea (si es tu primer mensaje), explica brevemente qué incluye (sesión online + 21 días de WhatsApp con respuesta 1 vez al día en horario laboral, preguntas en horario laboral) y el valor, y pregúntale si le gustaría entrar.
2. Si acepta: envíale el link de pago SOLO en este momento (nunca antes de que acepte) y dile que ahora agendaremos su sesión online.
3. Usa consultar_disponibilidad con servicio "rest" y muéstrale los horarios disponibles.
4. Pídele nombre completo, correo electrónico y número de WhatsApp. Para este programa los TRES son obligatorios (el WhatsApp es para el seguimiento).
5. Cuando elija un horario y tengas los tres datos, usa crear_reserva con el slot_id exacto.
6. Si no acepta: agradece con calidez, sin insistir. Si pregunta por algo más económico, puedes mencionar el Método R.E.S.T. digital en www.metodorest.cl.

REGLAS DEL FLUJO SUEÑO:
- La sesión es ONLINE: no le des la dirección de la clínica.
- La regla general de "derivar siempre a www.metodorest.cl" NO aplica a este flujo: quien aceptó el programa acompañado paga con el link de pago de arriba.
- Respeta el límite de 60 palabras salvo en el mensaje que explica el programa.

## FLUJO DEL CURSO "DOLOR LUMBAR CRÓNICO" (gancho profesional)
Cuando una persona escribe interesada en el curso (o ya recibió el mensaje de bienvenida del curso), estás en un flujo especial dirigido a PROFESIONALES DE LA SALUD. Sigue este guion:

DATOS DEL CURSO:
- Nombre: Dolor Lumbar Crónico — el diafragma y el control lumbopélvico
- Fecha: sábado 5 y domingo 6 de septiembre de 2026
- Lugar: Clínica Sakros, Viña del Mar
- Duración: 14 horas · 5 bloques prácticos · 12 cupos
- Docente: Joaquín Adi
- Dirigido a: kinesiólogos, osteópatas, fisioterapeutas, médicos y estudiantes avanzados del área de salud
- Preventa: $290.000 (hasta el 6 de agosto) · Valor general: $360.000
- Ficha PDF: https://raw.githubusercontent.com/osteopatajoaquinadi-byte/OsteoJuaco/main/assets/curso/ficha_curso.pdf
- WhatsApp de inscripción (atiende Joaquín directamente): https://wa.me/56968477060

EL FILTRO (paso clave):
El mensaje de bienvenida ya le preguntó si trabaja con pacientes de dolor persistente / si es del área de la salud. Según cómo responda:

**Si confirma que es del área o trabaja con dolor persistente** (kinesiólogo, osteópata, fisio, médico, estudiante avanzado de salud):
"¡Perfecto! Arriba te dejé la ficha con el detalle 🙌\n\nEs un curso muy práctico: 14 horas, 12 cupos, evaluación pre-post con VFC en sala. Preventa $290.000 hasta el 6 de agosto, valor general $360.000.\n\nPara reservar tu cupo y resolver cualquier duda directo con Joaquín, escríbele por WhatsApp acá:\n👉 https://wa.me/56968477060?text=Hola%2C%20vengo%20de%20Instagram%20y%20me%20interesa%20el%20curso%20de%20Dolor%20Lumbar%20Cr%C3%B3nico\n\nTe atiende él mismo. 🙌"

**Si NO es del área de la salud, o su respuesta no confirma el filtro:**
"Gracias por tu interés 🙌 Este curso es bastante técnico y está pensado para profesionales que tratan dolor persistente. Si igual quieres el programa o tienes dudas, escríbeme y lo vemos: https://wa.me/56968477060"

**Si sigue conversando después (dudas, agradecimientos):**
Responde breve y cálido. Cierre tipo: "Cualquier cosa que necesites, por acá o por WhatsApp estoy. ¡Que tengas buen día!"

REGLAS DEL FLUJO CURSO:
- La ficha del curso ya se le envió al paciente como IMAGEN. Refiérete a ella como "la ficha que te dejé arriba", NO mandes links de PDF crudos (se ven mal).
- El PDF completo y la inscripción van por WhatsApp +56968477060 — ahí Joaquín le pasa todo el detalle formal.
- NO derives el curso a la secretaria (+56945399692) ni a metodorest@gmail.com.
- NO mezcles el curso con el Método R.E.S.T. ni con agendamiento de horas clínicas.
- Envía siempre el link de WhatsApp con el texto pre-cargado en la versión para profesionales.
- Sé cálido y directo, de colega a colega. No uses lenguaje de venta agresivo.

## AGENDAMIENTO DE CITAS EN CLÍNICA SAKROS
Tienes acceso a dos herramientas para gestionar citas reales en Clínica Sakros (sakros.cl):
- **consultar_disponibilidad**: consulta horarios reales disponibles para un servicio
- **crear_reserva**: crea una reserva real con los datos del paciente

### CUÁNDO USAR LAS HERRAMIENTAS
- Cuando el paciente acepte tu sugerencia de evaluación o diga que quiere atenderse
- Cuando pregunte por horarios, disponibilidad, o cómo agendar
- Cuando diga "sí", "dale", "me interesa", "quiero ir", "agéndame" u otra afirmación después de que le sugieras un servicio
- NO uses la herramienta solo para describir servicios — úsala cuando haya intención real de agendar

### FLUJO DE AGENDAMIENTO (seguir EXACTAMENTE en este orden)
1. Cuando detectes intención de agendar, usa consultar_disponibilidad con el servicio apropiado
2. La herramienta devuelve una lista de horarios, cada uno con un "slot_id" y un "horario" legible
3. Muestra al paciente SOLO los textos de "horario" (nunca los slot_id, son internos)
4. Cuando el paciente elija uno, pídele nombre completo, email y teléfono (el email es necesario: ahí le llega la confirmación)
5. Llama a crear_reserva pasando el slot_id EXACTO del horario que eligió
6. Si la reserva es exitosa, confirma con entusiasmo mencionando día y hora
7. Si el resultado trae una "nota", síguela al pie de la letra: NUNCA le digas al paciente que su hora está confirmada si el sistema no la confirmó
8. Si falla, discúlpate brevemente y sigue la instrucción del mensaje de error

### REGLAS INQUEBRANTABLES DE AGENDAMIENTO
- NUNCA inventes ni deduzcas un horario. Solo existen los que devolvió consultar_disponibilidad en ESTA conversación.
- El slot_id se copia LITERAL del resultado. Nunca lo construyas, modifiques ni adivines.
- Si el paciente pide un día/hora que NO está en la lista devuelta, dile con honestidad que ese horario no está disponible y ofrécele los que sí están. NUNCA intentes reservarlo igual.
- Si el paciente pide "el viernes" y hay varios viernes, pregúntale cuál antes de reservar.
- Si ya pasó tiempo desde que mostraste los horarios y el paciente recién responde, vuelve a llamar consultar_disponibilidad antes de reservar.
- Si el paciente da sus datos antes de que consultes disponibilidad, recuérdalos y úsalos al momento de crear_reserva.
- Si no sabes qué servicio corresponde, pregúntale o sugiérelo según sus síntomas.

## DERIVACIÓN POR SERVICIOS EN SAKROS (sakros.cl)

### KINESIOLOGÍA
Derivar cuando mencione: esguinces, lesiones de rodilla/hombro, tendinopatías, disquinesias escapulares, epicondilitis, epitrocleítis, túnel carpiano, lesiones de muñeca y mano

### OSTEOPATÍA
Pago de la sesión individual: online en ${PAYMENT_LINKS.osteopatia} o en la clínica (el link va en el comprobante de la reserva, no lo repitas salvo que lo pidan).
También existe el ${OSTEO_PACK.nombre}: ${OSTEO_PACK.precio}, válido por ${OSTEO_PACK.vigencia}. Ofrécelo cuando el paciente pregunte por precios, por varias sesiones o por un tratamiento continuo. ${OSTEO_PACK.link ? `Se paga en ${OSTEO_PACK.link}.` : "Para comprarlo, derivar a la secretaria al +56945399692."}
Derivar cuando mencione: dolor de columna, dolor persistente (+3 meses), fibromialgia, dolor orofacial, trastornos temporomandibulares, bruxismo, intestino irritable, gastritis, acidez crónica, palpitaciones, sudoraciones, disautonomías

### MOTION AND BALANCE
Derivar cuando mencione: alteraciones de la marcha, dolor de pie, plantillas ortopédicas, evaluación del pie

### POSTUROLOGÍA CLÍNICA
Derivar cuando mencione: mala postura, problemas de sensorialidad, déficit atencional, TEA, dificultades de aprendizaje, problemas visuales funcionales, niños con problemas de desarrollo

### REGLA GENERAL
- Si no menciona ciudad, derivar igual a Sakros
- Si es de otra ciudad, recomendar especialista en su zona
- Si además tiene mal sueño, introducir el Método R.E.S.T. después de derivar
- NUNCA diagnostiques — orienta, educa y deriva

### CUANDO NO SEPAS UNA RESPUESTA CLÍNICA O DE KINESIOLOGÍA
Si te hacen una pregunta clínica que no puedes responder con confianza, o piden información administrativa de la clínica que no tienes:
→ Derivar a la secretaria de Clínica Sakros: +56945399692
→ Ejemplo: "Para esa consulta te recomiendo contactar directamente a nuestra secretaria al +56945399692 — ella te puede orientar mejor 😊"
→ NUNCA inventes respuestas clínicas

### USO CORRECTO DE metodorest@gmail.com
- Usar SOLO en conversaciones relacionadas con el Método R.E.S.T. (dudas de compra, acceso, soporte post-venta)
- NUNCA derivar a metodorest@gmail.com para temas clínicos, kinesiología, osteopatía o consultas generales
- Para temas clínicos → secretaria +56945399692
- Para temas del Método R.E.S.T. → metodorest@gmail.com o www.metodorest.cl

## CASOS ESPECIALES — MANEJO OBLIGATORIO

### EMBARAZO
Validar con empatía + cerrar con calidez "Cuídate mucho" + NO hacer más preguntas sobre el embarazo

### MEDICAMENTOS
NUNCA sugerir dejar o reducir medicación. Siempre decir que cualquier cambio debe ser supervisado por médico.

### NIÑOS Y ADOLESCENTES
El método es para adultos. Para menores derivar a pediatra o neuropediatra.

### USUARIO HOSTIL
No defenderse. Con calma: "Entiendo tu escepticismo, es válido."

### APNEA DEL SUEÑO
Requiere diagnóstico médico y posiblemente CPAP. El método complementa pero no reemplaza.

### SOPORTE POST-VENTA (solo Método R.E.S.T.)
Si ya compró el Método R.E.S.T. y tiene problemas de acceso: "Escríbenos a metodorest@gmail.com"

### SOLO QUIERE TIPS GRATIS
Máximo 1 tip genérico, luego redirigir.

### PRIVACIÓN SEVERA DE SUEÑO
Si duerme menos de 3 horas por noche y lleva más de una semana:
- Validar con seriedad y empatía
- SIEMPRE derivar primero al médico
- Luego presentar el Método R.E.S.T. como complemento

### MENSAJES DE AGRADECIMIENTO O CIERRE
Responder cálido y breve. NO intentar vender ni hacer preguntas para continuar.

## DETECCIÓN DE TONO — ADAPTA TU RESPUESTA AL TIPO DE MENSAJE

### CONSULTA CLÍNICA (dolor, síntomas, problemas de salud)
Ejemplos: "me duele la espalda", "tengo insomnio", "mi hijo tiene problemas de postura"
→ Tono profesional y empático
→ Hacer 1-2 preguntas para orientar
→ Derivar al servicio de Sakros que corresponda
→ Ofrecer agendar si el paciente muestra interés
→ Máximo 60 palabras

### PREGUNTA SOBRE MÉTODO R.E.S.T. (información del producto)
Ejemplos: "¿cómo funciona el método?", "¿cuánto cuesta?", "¿qué incluye?"
→ Tono educativo, breve
→ Mencionar los 4 pilares sin revelar contenido detallado
→ Mencionar precio de lanzamiento ($39.990 CLP) si preguntan
→ Máximo 60 palabras

### INTENCIÓN DE COMPRA DEL MÉTODO R.E.S.T.
Cuando el usuario diga "sí", "quiero comprarlo", "me interesa", "cómo lo compro", "dónde lo compro" o cualquier señal de querer adquirir el método:
→ Derivar SIEMPRE a www.metodorest.cl como link directo de compra
→ Ejemplo: "¡Genial! Puedes acceder al Método R.E.S.T. directamente aquí: www.metodorest.cl — Si tienes dudas, escríbenos a metodorest@gmail.com 😊"
→ NUNCA decir "puedes adquirirlo con Joaquín" ni derivar a otro lado — el link de compra es siempre www.metodorest.cl

### PREGUNTA SOBRE EL CURSO DE DOLOR LUMBAR CRÓNICO (profesionales)
Si un kinesiólogo o profesional pregunta por el curso presencial de Dolor Lumbar Crónico:
→ Datos clave: 5 y 6 de septiembre 2026, Clínica Sakros Viña del Mar, 14 horas, 12 cupos, dirigido a kinesiólogos
→ Preventa $290.000 (hasta 6 de agosto), valor general $360.000
→ Para inscripción y cierre → SIEMPRE derivar al WhatsApp +56 9 6847 7060
→ Ejemplo: "El curso de Dolor Lumbar Crónico es el 5 y 6 de septiembre en Clínica Sakros. Para reservar tu cupo escríbenos por WhatsApp al +56 9 6847 7060 📲"
→ Tono profesional, de colega a colega (no de terapeuta a paciente)
→ NUNCA intentes cerrar la venta tú — solo informa y deriva al WhatsApp

### MENSAJE INFORMAL O SOCIAL (saludos, agradecimientos, cariño)
Ejemplos: "gracias Juaco!", "un abrazo!", "buena semana", "eres crack", "te pasaste", "saludos!"
→ Respuesta cálida, corta y natural, como respondería Joaquín a un conocido
→ Máximo 15-20 palabras
→ Puede incluir 1 emoji
→ NUNCA intentar vender, derivar, ni hacer preguntas para continuar la conversación
→ Ejemplos de buenas respuestas: "¡Abrazo grande! 🙌", "¡Gracias a ti! Cualquier cosa aquí estamos 💪", "¡Un abrazo de vuelta! Cuídate mucho"

### EMOJI SUELTO O REACCIÓN (👍, ❤️, 🔥, 😂)
→ No responder. Ignorar silenciosamente.

### TERAPEUTA QUE PIDE DETALLES
No revelar contenido. "Para evaluarlo con criterio clínico, la mejor forma es acceder directamente."

## LO QUE NUNCA DEBES HACER
- Sugerir dejar medicamentos sin supervisión médica
- Adaptar o vender el método para menores de edad
- Revelar protocolos completos del ebook
- Resolver problemas técnicos de acceso al Método R.E.S.T. — derivar a metodorest@gmail.com
- Derivar a metodorest@gmail.com para temas que NO sean del Método R.E.S.T.
- Para dudas clínicas o administrativas de Sakros → secretaria +56945399692

## HABLAR DIRECTAMENTE CON JOAQUÍN
Cuando el paciente pida hablar con Joaquín directamente ("quiero hablar con Joaquín", "me puede responder Joaquín", "prefiero hablar con él", o similar), O cuando te hagan una pregunta que NO sabes responder con seguridad:
- NUNCA inventes una respuesta. Es mejor derivar que equivocarse.
- Responde cálido: "¡Por supuesto, no hay problema! Le aviso a Joaquín y él te responde por aquí a la brevedad 🙌"
- Usa la herramienta avisar_joaquin para reenviarle la conversación.

## PRIMERA PERSONA — SIEMPRE
Habla siempre en primera persona como si fueras Joaquín Adi o parte de su equipo.

## FORMATO
- Máximo 60 palabras por respuesta
- Tono cálido, empático, nunca agresivo ni insistente

## IDIOMA
Responde siempre en el mismo idioma que usa la persona.`;

// ── Verificación del webhook ──────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado correctamente");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── Recibe mensajes de Instagram ──────────────────────────────
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object !== "instagram") return res.sendStatus(404);

  res.sendStatus(200);

  for (const entry of body.entry || []) {
    // ── Procesar COMENTARIOS (lead magnets) ─────────────────
    for (const change of entry.changes || []) {
      if (change.field === "comments") {
        const comment = change.value;
        const commentText = sinTildes((comment.text || "").toLowerCase().trim());
        const commentId = comment.id;
        const commenterId = comment.from?.id;
        const commenterUsername = comment.from?.username || "unknown";

        // Ignorar comentarios propios
        if (commenterId === INSTAGRAM_ACCOUNT_ID) continue;

        console.log(`💬 Comentario de @${commenterUsername}: "${comment.text}"`);

        // Buscar keyword de lead magnet
        for (const [keyword, magnet] of Object.entries(LEAD_MAGNETS)) {
          if (coincideKeyword(commentText, keyword, magnet) && !magnet.disabled) {
            handleLeadMagnetComment(commentId, commenterId, commenterUsername, keyword).catch(err => {
              console.error(`❌ Error en lead magnet "${keyword}":`, err.message);
            });
            break; // solo un lead magnet por comentario
          }
        }
      }
    }

    // ── Procesar MENSAJES DIRECTOS ──────────────────────────
    for (const event of entry.messaging || []) {
      const senderId    = event.sender?.id;
      const recipientId = event.recipient?.id;
      const text        = event.message?.text;

      // Ecos: mensajes que salieron de la cuenta (del bot o de Joaquín a mano)
      const esEco = event.message?.is_echo || (recipientId && recipientId !== INSTAGRAM_ACCOUNT_ID);
      if (esEco) {
        const message = event.message;
        if (message && recipientId) {
          setTimeout(() => {
            if (ecoEsDelBot(message)) return;
            pausedUntil[recipientId] = Date.now() + PAUSA_MANUAL_MS;
            console.log(`✋ Joaquín respondió a mano a ${recipientId}: bot en pausa 12 h para esta persona`);
          }, ESPERA_ECO_MS);
        }
        continue;
      }

      // Ignorar mensajes sin contenido
      if (!senderId || !text) continue;

      if (botPausado(senderId)) {
        console.log(`⏸️ Bot en pausa para ${senderId} (Joaquín está respondiendo a mano): "${text}"`);
        continue;
      }

      console.log(`📩 Mensaje de ${senderId}: ${text}`);

      try {
        // Inicializar historial
        if (!conversations[senderId]) conversations[senderId] = [];

        // ── FLUJO CURSO: capturar número de WhatsApp antes de enviar la ficha ──
        if (cursoContext[senderId] && !cursoFichaSent[senderId]) {
          const telefono = extraerTelefono(text);

          if (telefono) {
            // Tiene número válido → registrar, avisar a Juaco y enviar la ficha
            cursoFichaSent[senderId] = true;

            // 1. Reenviar el lead a Juaco por DM
            try {
              await sendInstagramMessage(
                OWNER_IG_ID,
                `🎓 *Nuevo interesado en el curso*\n\n📲 WhatsApp: ${telefono}\n💬 Escribió: "${text}"\n\n(Instagram ID: ${senderId})`
              );
              console.log(`📨 Lead del curso reenviado a Juaco: ${telefono}`);
            } catch (e) {
              console.error("⚠️ No se pudo avisar a Juaco:", e.response?.data?.error?.message || e.message);
            }

            // 2. Enviar las 2 páginas de la ficha al interesado
            for (const pag of [`${GITHUB_ASSETS}/curso/curso_pag1.jpg`, `${GITHUB_ASSETS}/curso/curso_pag2.jpg`]) {
              try {
                await sendInstagramImage(senderId, pag);
              } catch (imgErr) {
                console.error("⚠️ No se pudo enviar página de ficha:", imgErr.response?.status || imgErr.message);
              }
            }
            console.log(`🎓 Ficha del curso enviada a ${senderId}`);

            // 3. Mensaje de cierre con el WhatsApp de inscripción
            try {
              await sendInstagramMessage(
                senderId,
                "¡Listo! Arriba te dejé la ficha con todo el detalle del programa. 🙌\n\nEs un curso muy práctico: 14 horas, 12 cupos, evaluación pre-post con VFC en sala. Preventa $290.000 hasta el 6 de agosto.\n\nCualquier duda o para reservar tu cupo, escríbenos directo por WhatsApp: +56 9 6847 7060 📲\n\n¡Te esperamos!"
              );
            } catch (e) {
              console.error("⚠️ No se pudo enviar cierre del curso:", e.message);
            }

            // Cerrar el modo curso para este usuario
            delete cursoContext[senderId];
            continue; // no pasar por Claude, el flujo del curso ya está completo
          } else {
            // No dio número válido → pedirlo de nuevo (sin activar Claude)
            try {
              await sendInstagramMessage(
                senderId,
                "¡Genial! Para enviarte el programa completo necesito tu número de WhatsApp 📲 (con el código, por ejemplo +56 9 1234 5678). ¿Me lo dejas?"
              );
            } catch (e) {
              console.error("⚠️ No se pudo repedir número:", e.message);
            }
            continue; // esperar a que mande el número
          }
        }

        // Agregar mensaje del usuario
        conversations[senderId].push({ role: "user", content: text });

        // Limitar historial a 20 mensajes (sin contar tool_result internos)
        if (conversations[senderId].length > 30) {
          conversations[senderId] = conversations[senderId].slice(-30);
        }

        // Llamar a Claude con tools
        const reply = await callClaude(senderId);

        if (reply) {
          await sendInstagramMessage(senderId, reply);
        }

      } catch (error) {
        console.error("❌ Error:", error.response?.data || error.message);
      }
    }
  }
});

// ── Función para enviar mensaje a Instagram ───────────────────
// ── Private Reply: DM en respuesta a un comentario ────────────
// Instagram NO permite enviar un DM normal a alguien que solo comentó (error 403
// "outside allowed window"). El endpoint de private replies sí lo permite, pero:
//  - Solo se puede enviar UNA private reply por comentario
//  - Se dirige por comment_id, no por user_id
//  - Llega a Inbox si te sigue, o a Solicitudes si no te sigue
async function sendPrivateReply(commentId, text) {
  const response = await axios.post(
    `https://graph.instagram.com/v25.0/${INSTAGRAM_ACCOUNT_ID}/messages`,
    {
      recipient: { comment_id: commentId },
      message:   { text: text },
    },
    { headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` } }
  );
  registrarEnvioBot(response, { texto: text });
  console.log(`📨 Private reply enviada al comentario ${commentId}`);
}

async function sendInstagramMessage(senderId, text) {
  // Instagram tiene límite de 1000 caracteres por mensaje
  // Si la respuesta es más larga, enviar en partes
  const maxLen = 950;
  const parts = [];

  if (text.length <= maxLen) {
    parts.push(text);
  } else {
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        parts.push(remaining);
        break;
      }
      // Cortar en el último salto de línea o espacio antes del límite
      let cutAt = remaining.lastIndexOf("\n", maxLen);
      if (cutAt < maxLen * 0.5) cutAt = remaining.lastIndexOf(" ", maxLen);
      if (cutAt < maxLen * 0.3) cutAt = maxLen;
      parts.push(remaining.substring(0, cutAt));
      remaining = remaining.substring(cutAt).trimStart();
    }
  }

  for (const part of parts) {
    const response = await axios.post(
      `https://graph.instagram.com/v25.0/${INSTAGRAM_ACCOUNT_ID}/messages`,
      {
        recipient: { id: senderId },
        message:   { text: part },
      },
      {
        headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` },
      }
    );
    registrarEnvioBot(response, { texto: part });
  }
  console.log(`✅ Respuesta enviada a ${senderId} (${parts.length} parte${parts.length > 1 ? "s" : ""})`);
}

// ── Lead Magnets — Configuración de keywords y archivos ──────
const GITHUB_ASSETS = "https://raw.githubusercontent.com/osteopatajoaquinadi-byte/OsteoJuaco/main/assets";

const LEAD_MAGNETS = {
  "me pasa": {
    images: [],
    pdf: null,
    commentReply: "¡Te escribo al DM! 📩",
    dmText: "¿Sientes que vives en alerta, como si tu cuerpo no lograra \"apagar\" el motor? 🌙\n\nLo que probablemente pasa es que tu sistema nervioso se quedó en modo defensa. Ante estrés sostenido —trabajo, preocupaciones, mal dormir— la rama simpática (la del \"acelerador\") se mantiene activada más tiempo del que debería. El cuerpo interpreta que sigue habiendo una amenaza, aunque no la haya, y no baja a modo reparación.\n\nPor eso cuesta relajarse, dormir profundo o sentir calma real: el sistema quedó \"trabado\" en alerta.\n\nEste es justamente el eje que trabajamos en el Método R.E.S.T. Si quieres entender cómo empezar a regularlo → www.metodorest.cl",
    dmFollowUp: null,
  },
  dormir: {
    images: [`${GITHUB_ASSETS}/dormir/dormir_guia.jpg`],
    pdf: null,
    commentReply: "¡Te lo envío al DM! 📩",
    dmText: "¡Hola! 🌙 Aquí tienes tu guía sobre qué sucede cuando no dormimos bien.",
    dmFollowUp: "Si llevas tiempo sin descansar bien, el Método R.E.S.T. es un programa de 21 días que trabaja el sueño desde la raíz → www.metodorest.cl 😊\n\nCualquier duda, estoy aquí para ayudarte 💪",
  },
  errores: {
    images: [`${GITHUB_ASSETS}/errores/errores_page_1.jpg`],
    pdf: `${GITHUB_ASSETS}/errores/errores_sueno.pdf`,
    commentReply: "¡Te lo envío al DM! 📩",
    dmText: "¡Hola! 🌙 Aquí tienes la guía de errores comunes que sabotean el sueño.",
    dmFollowUp: "Descarga la guía completa en PDF aquí:\nhttps://raw.githubusercontent.com/osteopatajoaquinadi-byte/OsteoJuaco/main/assets/errores/errores_sueno.pdf\n\n¿Sabías que el Método R.E.S.T. trabaja estos temas en profundidad? 21 días para recuperar tu sueño desde la raíz → www.metodorest.cl 😊\n\nCualquier duda, estoy aquí 💪",
  },
  ejercicio: {
    images: [`${GITHUB_ASSETS}/ejercicio/ejercicio_page_1.jpg`],
    pdf: `${GITHUB_ASSETS}/ejercicio/ejercicio_respiracion.pdf`,
    commentReply: "¡Te lo envío al DM! 📩",
    dmText: "¡Hola! 🌙 Aquí tienes un ejercicio de respiración 4-7-8 para tu sistema nervioso. Practícalo antes de dormir.",
    dmFollowUp: "Descarga la guía completa en PDF aquí:\nhttps://raw.githubusercontent.com/osteopatajoaquinadi-byte/OsteoJuaco/main/assets/ejercicio/ejercicio_respiracion.pdf\n\nEste ejercicio es parte del pilar S (Sistema Nervioso) del Método R.E.S.T. → www.metodorest.cl 😊\n\nCualquier duda, estoy aquí 💪",
  },
  stress: {
    images: [],
    pdf: null,
    commentReply: "¡Te lo envío al DM! 📩",
    dmText: "¡Hola! 🌙 Estamos preparando una guía especial sobre estrés. Por ahora te cuento que el Método R.E.S.T. trabaja directamente la regulación del sistema nervioso — un pilar clave para manejar el estrés crónico.",
    dmFollowUp: "Más info en www.metodorest.cl — cualquier duda, estoy aquí 💪",
    disabled: true,  // Activar cuando tenga archivo
  },
  // DOLOR y KINE: CTA de los posts de @osteopatajoaquinadi. Solo cuentan como
  // palabra completa, para no saltar con "kinesiólogo" o "dolorido".
  dolor: {
    wholeWord: true,
    images: [],
    pdf: null,
    commentReply: "¡Te lo envío al DM! 📩",
    dmText: "¡Hola! 🙌 Si llevas tiempo con dolor, el primer paso es una buena evaluación: entender qué lo está manteniendo, no solo dónde duele.\n\nPuedes agendar tu evaluación en Clínica Sakros (Viña del Mar) aquí 👉 https://www.sakros.cl/reserva",
    dmFollowUp: "¿Prefieres coordinar por WhatsApp? Escríbenos al +56 9 4539 9692 📲",
  },
  kine: {
    wholeWord: true,
    images: [],
    pdf: null,
    commentReply: "¡Te lo envío al DM! 📩",
    dmText: "¡Hola! 💪 Aquí puedes agendar con el equipo de kinesiología de Clínica Sakros (Viña del Mar) 👉 https://www.sakros.cl/reserva",
    dmFollowUp: "Si no sabes si te conviene kinesiología u osteopatía, respóndeme por aquí y lo vemos. También puedes escribirnos por WhatsApp al +56 9 4539 9692 📲",
  },
  "curso grabado": {
    images: [],
    pdf: null,
    commentReply: "¡Te escribo al DM! 📩",
    dmText: "¡Genial que te interese el curso de Dolor Lumbar Crónico! 🙌\n\nLa grabación estará disponible pronto. Para acceder y coordinar, contáctate directamente con Joaquín acá 👉 https://wa.me/56968477060",
    dmFollowUp: null,
  },
  curso: {
    context: "curso",
    disabled: true,  // Curso presencial ya pasó (5-6 sept). Reactivar si se repite.
    images: [`${GITHUB_ASSETS}/curso/curso_pag1.jpg`, `${GITHUB_ASSETS}/curso/curso_pag2.jpg`],
    pdf: `${GITHUB_ASSETS}/curso/ficha_curso.pdf`,
    commentReply: "¡Te escribo al DM! 📩",
    conversational: true,
    dmText: "¡Hola! Gracias por tu interés en el curso *Dolor Lumbar Crónico* (5 y 6 de septiembre, Viña del Mar). 🙌\n\nPara enviarte el programa completo, ¿me dejas tu número de WhatsApp? Así también puedo pasarte cualquier novedad o resolver dudas directo. 📲",
    dmFollowUp: null,
  },
};

// Quita tildes para comparar palabras clave ("sueño" = "sueno")
function sinTildes(texto) {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// commentText ya viene en minúsculas y sin tildes
function coincideKeyword(commentText, keyword, magnet) {
  const k = sinTildes(keyword.toLowerCase());
  if (!magnet.wholeWord) return commentText.includes(k);
  return new RegExp(`(^|[^a-z0-9])${k}($|[^a-z0-9])`).test(commentText);
}

// "sueño" va al final: si un comentario coincide con otra palabra clave
// (por ejemplo "errores"), se mantiene ese lead magnet.
LEAD_MAGNETS["sueño"] = {
  images: [],
  pdf: null,
  commentReply: "¡Te escribo al DM! 🌙",
  conversational: true,
  context: "rest",
  dmText:
    "¡Hola! Soy OsteoJuaco, asistente de Joaquín Adi 🌙\n\n" +
    "Te cuento del Método R.E.S.T. acompañado:\n" +
    "• 1 sesión online con Joaquín\n" +
    "• 21 días de seguimiento por WhatsApp, con respuesta 1 vez al día en horario laboral\n\n" +
    "Las preguntas del seguimiento se hacen en horario laboral. " +
    `El programa cuesta ${REST_ACOMPANADO_PRECIO} y se paga con un link de pago.\n\n` +
    "¿Te gustaría entrar al programa? 🙌",
  dmFollowUp: null,
};

// Registro para evitar enviar lead magnets duplicados al mismo usuario
const leadMagnetsSent = {};

// Registro de usuarios en flujo conversacional del curso (para que Claude conduzca el filtro)
const cursoContext = {};

// Registro de a quién ya se le envió la imagen de la ficha (evita reenvíos)
const cursoFichaSent = {};

// Instagram ID de Juaco (@osteopatajoaquinadi) — para reenviarle los leads del curso
const OWNER_IG_ID = "17841400494105253";

// Extraer un número de teléfono de un texto libre.
// Devuelve el número normalizado si parece válido, o null si no hay.
function extraerTelefono(texto) {
  if (!texto) return null;
  // Quitar todo lo que no sea dígito o + para contar dígitos reales
  const soloNumeros = texto.replace(/[^\d+]/g, "");
  const digitos = soloNumeros.replace(/\D/g, "");
  // Un teléfono chileno válido tiene 8-9 dígitos (sin código) o 11 (con +56 9)
  // Aceptamos entre 8 y 15 dígitos para cubrir formatos internacionales
  if (digitos.length >= 8 && digitos.length <= 15) {
    return soloNumeros;
  }
  return null;
}

// ── Responder a un comentario de Instagram ───────────────────
async function replyToComment(commentId, text) {
  try {
    await axios.post(
      `https://graph.instagram.com/v25.0/${commentId}/replies`,
      { message: text },
      { headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` } }
    );
    console.log(`💬 Respuesta a comentario ${commentId}`);
  } catch (error) {
    console.error("❌ Error respondiendo comentario:", error.response?.status, error.response?.data?.error?.message || error.message);
  }
}

// ── Enviar imagen por DM de Instagram ─────────────────────────
async function sendInstagramImage(recipientId, imageUrl) {
  try {
    const response = await axios.post(
      `https://graph.instagram.com/v25.0/${INSTAGRAM_ACCOUNT_ID}/messages`,
      {
        recipient: { id: recipientId },
        message: {
          attachment: {
            type: "image",
            payload: { url: imageUrl },
          },
        },
      },
      { headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` } }
    );
    registrarEnvioBot(response, { imagen: true });
    console.log(`🖼️ Imagen enviada a ${recipientId}`);
  } catch (error) {
    console.error("❌ Error enviando imagen:", error.response?.status, error.response?.data?.error?.message || error.message);
  }
}

// ── Manejar comentario con keyword de lead magnet ─────────────
async function handleLeadMagnetComment(commentId, commenterId, commenterUsername, keyword) {
  const magnet = LEAD_MAGNETS[keyword];
  if (!magnet || magnet.disabled) return;

  // Evitar duplicados (mismo usuario + mismo keyword en últimas 24h)
  const key = `${commenterId}_${keyword}`;
  const now = Date.now();
  if (leadMagnetsSent[key] && now - leadMagnetsSent[key] < 86400000) {
    console.log(`⏭️ Lead magnet ${keyword} ya enviado a ${commenterUsername} en las últimas 24h`);
    return;
  }
  leadMagnetsSent[key] = now;

  console.log(`🎯 Lead magnet "${keyword}" activado por @${commenterUsername}`);

  // Responder públicamente el comentario (para que otros vean que respondemos)
  if (magnet.commentReply) {
    try {
      await replyToComment(commentId, magnet.commentReply);
    } catch (e) {
      console.error("⚠️ No se pudo responder el comentario público:", e.response?.status || e.message);
    }
  }

  // Instagram solo permite UNA private reply por comentario, así que consolidamos
  // el contenido en un único mensaje. En flujos conversacionales (curso) NO se
  // agrega el link del PDF: ahí el material va por otro camino (fotos tras el número).
  const partes = [magnet.dmText];
  if (magnet.pdf && !magnet.conversational) {
    partes.push(`\n📄 Descarga aquí: ${magnet.pdf}`);
  }
  if (magnet.dmFollowUp && !magnet.conversational) {
    partes.push(`\n${magnet.dmFollowUp}`);
  }
  const mensajeCompleto = partes.filter(Boolean).join("\n");

  try {
    // Private reply: el ÚNICO camino permitido para escribirle a alguien que
    // solo comentó (un DM normal daría 403 "outside allowed window").
    await sendPrivateReply(commentId, mensajeCompleto);
  } catch (error) {
    const sub = error.response?.data?.error?.error_subcode;
    const msg = error.response?.data?.error?.message || error.message;
    console.error(`❌ Error private reply "${keyword}":`, error.response?.status, sub, msg);
    // Si la private reply falla, intentamos responder el comentario públicamente
    // pidiéndole que nos escriba por DM (así abre la ventana de conversación).
    try {
      await replyToComment(commentId, "¡Hola! Te intenté escribir por privado 📩 Si no te llegó, mándanos un DM y te paso la info al toque 🙌");
    } catch (e) {
      console.error("❌ Tampoco se pudo responder el comentario:", e.message);
    }
    return;
  }

  // Si es conversacional (curso), registrar el contexto para que Claude conduzca
  // el filtro cuando la persona responda a la private reply.
  if (magnet.conversational) {
    if (!conversations[commenterId]) conversations[commenterId] = [];
    conversations[commenterId].push({
      role: "assistant",
      content: magnet.dmText,
    });
    if (magnet.context === "curso") {
      cursoContext[commenterId] = Date.now();
      console.log(`🎓 Modo curso activado para @${commenterUsername} — Claude conduce el filtro`);
    } else {
      console.log(`🌙 Flujo "${keyword}" activado para @${commenterUsername} — Claude continúa la conversación`);
    }
  }

  console.log(`✅ Lead magnet "${keyword}" completo para @${commenterUsername}`);
}

// ── Health check ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("🌙 OsteoJuaco v2.0 — Tool Use activo.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 OsteoJuaco v2.0 corriendo en puerto ${PORT}`);
});
