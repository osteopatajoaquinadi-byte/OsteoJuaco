// ─────────────────────────────────────────────────────────────
// ASISTENTE R.E.S.T. — Servidor puente Instagram ↔ Claude IA
// © Joaquín Adi A. — Todos los derechos reservados
// v2.0 — Refactor: Claude tool use para Wix Bookings
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

// ── Variables Wix ─────────────────────────────────────────────
const WIX_API_KEY  = process.env.WIX_API_KEY;
const WIX_SITE_ID  = process.env.WIX_SITE_ID;
const WIX_SERVICES = {
  kinesiologia: process.env.WIX_SERVICE_KINESIOLOGIA,
  osteopatia:   process.env.WIX_SERVICE_OSTEOPATIA,
  posturologia: process.env.WIX_SERVICE_POSTUROLOGIA,
  motion:       process.env.WIX_SERVICE_MOTION,
};

// ── Memoria de conversaciones ─────────────────────────────────
const conversations = {};

// ── Headers Wix ───────────────────────────────────────────────
const wixHeaders = {
  "Authorization": WIX_API_KEY,
  "wix-site-id":   WIX_SITE_ID,
  "Content-Type":  "application/json",
};

// ── Obtener horarios disponibles de Wix ──────────────────────
async function getAvailableSlots(serviceId) {
  try {
    const now = new Date();
    // Wix Time Slots V2 usa fechas locales + timezone (no ISO UTC)
    const fromLocal = now.toISOString().split(".")[0]; // "2026-06-21T23:00:00"
    const toDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const toLocal = toDate.toISOString().split(".")[0];

    const response = await axios.post(
      "https://www.wixapis.com/_api/service-availability/v2/time-slots",
      {
        serviceId: serviceId,
        fromLocalDate: fromLocal,
        toLocalDate: toLocal,
        timeZone: "America/Santiago",
        bookable: true,
      },
      { headers: wixHeaders }
    );

    console.log("📦 Wix response keys:", Object.keys(response.data || {}));

    const slots = response.data?.timeSlots || response.data?.availabilityEntries || [];
    
    // Log primer slot COMPLETO para debug
    if (slots.length > 0) {
      console.log("🔍 SLOT COMPLETO:", JSON.stringify(slots[0]));
    }
    
    return slots
      .filter(s => s.bookable !== false)
      .slice(0, 5)
      .map(s => {
        // El campo correcto es availableResources (no resources)
        const resource = s.availableResources?.[0] || null;
        const localStart = s.localStartDate;
        const localEnd = s.localEndDate;
        
        return {
          start: localStart,
          endDate: localEnd,
          resource: resource,
          scheduleId: s.scheduleId || null,  // está en el nivel del slot, no del resource
          location: s.location || null,
          label: formatSlotDate(localStart),
        };
      });
  } catch (error) {
    console.error("❌ Error Wix slots:", error.response?.status, error.response?.data || error.message);
    return { error: "No se pudo consultar disponibilidad. Sugiere al paciente agendar en www.sakros.cl" };
  }
}

// ── Crear reserva en Wix ──────────────────────────────────────
async function createWixBooking(serviceId, slotStart, name, email, phone, slotEnd, resource, location, scheduleId) {
  // Intentar con el endpoint Bookings v2 (formato simple, no requiere resource.id)
  try {
    const bookingBody = {
      booking: {
        bookedEntity: {
          slot: {
            serviceId: serviceId,
            startDate: slotStart,
            ...(slotEnd && { endDate: slotEnd }),
            ...(scheduleId && { scheduleId }),
            timezone: "America/Santiago",
            location: {
              locationType: "OWNER_BUSINESS",
            },
          },
        },
        contactDetails: {
          firstName: name.split(" ")[0],
          lastName:  name.split(" ").slice(1).join(" ") || ".",
          ...(email && { email }),
          ...(phone && { phone }),
        },
        numberOfParticipants: 1,
        selectedPaymentOption: "OFFLINE",
      },
      options: {
        flowControlSettings: {
          skipAvailabilityValidation: true,
        },
      },
    };

    console.log("📤 Wix booking request (Writer V2):", JSON.stringify(bookingBody, null, 2));

    const response = await axios.post(
      "https://www.wixapis.com/_api/bookings-service/v2/bookings",
      bookingBody,
      { headers: wixHeaders }
    );
    
    const bookingId = response.data?.booking?.id || response.data?.booking?._id || "confirmado";
    const status = response.data?.booking?.status || "CREATED";
    
    // Si la reserva quedó en CREATED, intentar confirmarla automáticamente
    if (status === "CREATED" && bookingId && bookingId !== "confirmado") {
      try {
        await axios.post(
          `https://www.wixapis.com/_api/bookings-service/v2/bookings/${bookingId}/confirm`,
          { revision: response.data?.booking?.revision || "1" },
          { headers: wixHeaders }
        );
        console.log("✅ Booking confirmado automáticamente");
        return { success: true, bookingId, status: "CONFIRMED" };
      } catch (confirmErr) {
        console.log("⚠️ Booking creado pero no confirmado:", confirmErr.response?.data?.message || confirmErr.message);
        return { success: true, bookingId, status };
      }
    }
    
    return { success: true, bookingId, status };
  } catch (error) {
    console.error("❌ Error Wix booking Writer V2:", error.response?.status, error.response?.data || error.message);
    
    // Fallback: intentar con el endpoint viejo /bookings/v2/bookings (formato legacy)
    try {
      console.log("🔄 Intentando endpoint legacy...");
      const legacyBody = {
        booking: {
          selectedPaymentOption: "OFFLINE",
          totalParticipants: 1,
          contactDetails: {
            firstName: name.split(" ")[0],
            lastName:  name.split(" ").slice(1).join(" ") || ".",
            ...(email && { email }),
            ...(phone && { phone }),
          },
          bookedEntity: {
            slot: {
              serviceId: serviceId,
              startDate: slotStart,
              ...(slotEnd && { endDate: slotEnd }),
              ...(scheduleId && { scheduleId }),
              timezone: "America/Santiago",
              location: { locationType: "OWNER_BUSINESS" },
            },
          },
        },
      };

      console.log("📤 Wix legacy request:", JSON.stringify(legacyBody, null, 2));

      const response = await axios.post(
        "https://www.wixapis.com/bookings/v2/bookings",
        legacyBody,
        { headers: wixHeaders }
      );
      return {
        success: true,
        bookingId: response.data?.booking?.id || "confirmado-legacy",
        status: response.data?.booking?.status || "CREATED",
      };
    } catch (legacyError) {
      console.error("❌ Error Wix booking legacy:", legacyError.response?.status, legacyError.response?.data || legacyError.message);
      return {
        success: false,
        error: "No se pudo crear la reserva. Sugiere al paciente agendar directamente en www.sakros.cl",
      };
    }
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

// ── Tools para Claude ─────────────────────────────────────────
const CLAUDE_TOOLS = [
  {
    name: "consultar_disponibilidad",
    description: "Consulta los horarios disponibles en Clínica Sakros para los próximos 7 días. Usa esta herramienta cuando el paciente quiera agendar una cita, pida horarios, o acepte tu sugerencia de derivación a un servicio. NO la uses solo para informar sobre servicios — úsala cuando haya intención real de agendar.",
    input_schema: {
      type: "object",
      properties: {
        servicio: {
          type: "string",
          enum: ["kinesiologia", "osteopatia", "posturologia", "motion"],
          description: "El servicio clínico a consultar: kinesiologia (lesiones musculoesqueléticas, esguinces, tendinopatías), osteopatia (dolor crónico, fibromialgia, columna, bruxismo, problemas digestivos), posturologia (postura, déficit atencional, TEA, problemas visuales funcionales, niños), motion (alteraciones de marcha, dolor de pie, plantillas)",
        },
      },
      required: ["servicio"],
    },
  },
  {
    name: "crear_reserva",
    description: "Crea una reserva real en Clínica Sakros vía Wix Bookings. Usa esta herramienta SOLO cuando tengas: 1) el servicio elegido, 2) el horario elegido por el paciente (de los que devolvió consultar_disponibilidad), 3) nombre completo, y 4) email o teléfono del paciente.",
    input_schema: {
      type: "object",
      properties: {
        servicio: {
          type: "string",
          enum: ["kinesiologia", "osteopatia", "posturologia", "motion"],
          description: "El servicio clínico a reservar",
        },
        horario: {
          type: "string",
          description: "La fecha/hora ISO del slot elegido por el paciente (copiada exactamente del resultado de consultar_disponibilidad)",
        },
        nombre: {
          type: "string",
          description: "Nombre completo del paciente",
        },
        email: {
          type: "string",
          description: "Email del paciente (puede ser vacío si solo dio teléfono)",
        },
        telefono: {
          type: "string",
          description: "Teléfono del paciente (puede ser vacío si solo dio email)",
        },
        horario_fin: {
          type: "string",
          description: "La fecha/hora ISO de fin del slot (copiada del campo endDate del resultado de consultar_disponibilidad, si está disponible)",
        },
        resource: {
          type: "object",
          description: "El objeto resource del slot (copiado directamente del resultado de consultar_disponibilidad, si está disponible)",
        },
        location: {
          type: "object",
          description: "El objeto location del slot (copiado directamente del resultado de consultar_disponibilidad, si está disponible)",
        },
        scheduleId: {
          type: "string",
          description: "El scheduleId del slot (copiado directamente del resultado de consultar_disponibilidad). OBLIGATORIO para crear la reserva.",
        },
      },
      required: ["servicio", "horario", "nombre"],
    },
  },
];

// ── Ejecutar tool calls ───────────────────────────────────────
async function executeTool(toolName, toolInput) {
  console.log(`🔧 Tool call: ${toolName}(${JSON.stringify(toolInput)})`);

  if (toolName === "consultar_disponibilidad") {
    const serviceId = WIX_SERVICES[toolInput.servicio];
    if (!serviceId) {
      return JSON.stringify({ error: `Servicio "${toolInput.servicio}" no encontrado` });
    }
    const result = await getAvailableSlots(serviceId);
    console.log(`📅 Slots encontrados: ${Array.isArray(result) ? result.length : "error"}`);
    return JSON.stringify(result);
  }

  if (toolName === "crear_reserva") {
    const serviceId = WIX_SERVICES[toolInput.servicio];
    if (!serviceId) {
      return JSON.stringify({ error: `Servicio "${toolInput.servicio}" no encontrado` });
    }
    const result = await createWixBooking(
      serviceId,
      toolInput.horario,
      toolInput.nombre,
      toolInput.email || "",
      toolInput.telefono || "",
      toolInput.horario_fin || null,
      toolInput.resource || null,
      toolInput.location || null,
      toolInput.scheduleId || null
    );
    console.log(`📋 Reserva: ${result.success ? "✅ " + result.bookingId : "❌ " + result.error}`);
    return JSON.stringify(result);
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
          const result = await executeTool(block.name, block.input);
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
const SYSTEM_PROMPT = `Eres el OsteoJuaco, asistente virtual oficial del Método R.E.S.T., creado por Joaquín Adi A.

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

## AGENDAMIENTO DE CITAS EN CLÍNICA SAKROS
Tienes acceso a dos herramientas para gestionar citas reales en Clínica Sakros (sakros.cl):
- **consultar_disponibilidad**: consulta horarios reales disponibles para un servicio
- **crear_reserva**: crea una reserva real con los datos del paciente

### CUÁNDO USAR LAS HERRAMIENTAS
- Cuando el paciente acepte tu sugerencia de evaluación o diga que quiere atenderse
- Cuando pregunte por horarios, disponibilidad, o cómo agendar
- Cuando diga "sí", "dale", "me interesa", "quiero ir", "agéndame" u otra afirmación después de que le sugieras un servicio
- NO uses la herramienta solo para describir servicios — úsala cuando haya intención real de agendar

### FLUJO DE AGENDAMIENTO
1. Cuando detectes intención de agendar, usa consultar_disponibilidad con el servicio apropiado
2. Presenta los horarios disponibles al paciente de forma amigable
3. Cuando elija un horario, pídele nombre completo y email o teléfono
4. Con esos datos, usa crear_reserva para confirmar
5. Si la reserva es exitosa, confirma con entusiasmo
6. Si falla, sugiere agendar en www.sakros.cl

### IMPORTANTE SOBRE AGENDAMIENTO
- Si el paciente da sus datos (nombre, teléfono, email) durante la conversación ANTES de que consultes disponibilidad, recuérdalos y úsalos cuando llegue el momento de crear_reserva
- Si no sabes qué servicio corresponde, pregúntale o sugiere basándote en sus síntomas
- Si no hay horarios disponibles, sugiere www.sakros.cl
- NUNCA inventes horarios — usa SOLO los que devuelve consultar_disponibilidad

## DERIVACIÓN POR SERVICIOS EN SAKROS (sakros.cl)

### KINESIOLOGÍA
Derivar cuando mencione: esguinces, lesiones de rodilla/hombro, tendinopatías, disquinesias escapulares, epicondilitis, epitrocleítis, túnel carpiano, lesiones de muñeca y mano

### OSTEOPATÍA
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

### SOPORTE POST-VENTA
Si ya compró y tiene problemas de acceso: "Escríbenos a contacto@metodorest.com"

### SOLO QUIERE TIPS GRATIS
Máximo 1 tip genérico, luego redirigir.

### PRIVACIÓN SEVERA DE SUEÑO
Si duerme menos de 3 horas por noche y lleva más de una semana:
- Validar con seriedad y empatía
- SIEMPRE derivar primero al médico
- Luego presentar el Método R.E.S.T. como complemento

### MENSAJES DE AGRADECIMIENTO O CIERRE
Responder cálido y breve. NO intentar vender ni hacer preguntas para continuar.

### TERAPEUTA QUE PIDE DETALLES
No revelar contenido. "Para evaluarlo con criterio clínico, la mejor forma es acceder directamente."

## LO QUE NUNCA DEBES HACER
- Sugerir dejar medicamentos sin supervisión médica
- Adaptar o vender el método para menores de edad
- Revelar protocolos completos del ebook
- Resolver problemas técnicos de acceso — derivar a contacto@metodorest.com

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
    for (const event of entry.messaging || []) {
      const senderId    = event.sender?.id;
      const recipientId = event.recipient?.id;
      const text        = event.message?.text;

      // Ignorar mensajes sin contenido
      if (!senderId || !text) continue;

      // Ignorar ecos del propio bot
      if (event.message?.is_echo) continue;
      if (recipientId && recipientId !== INSTAGRAM_ACCOUNT_ID) {
        console.log(`🔄 Ignorando eco (recipient=${recipientId}, sender=${senderId})`);
        continue;
      }

      console.log(`📩 Mensaje de ${senderId}: ${text}`);

      try {
        // Inicializar historial
        if (!conversations[senderId]) conversations[senderId] = [];

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
    await axios.post(
      `https://graph.instagram.com/v25.0/${INSTAGRAM_ACCOUNT_ID}/messages`,
      {
        recipient: { id: senderId },
        message:   { text: part },
      },
      {
        headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` },
      }
    );
  }
  console.log(`✅ Respuesta enviada a ${senderId} (${parts.length} parte${parts.length > 1 ? "s" : ""})`);
}

// ── Health check ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("🌙 OsteoJuaco v2.0 — Tool Use activo.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 OsteoJuaco v2.0 corriendo en puerto ${PORT}`);
});
