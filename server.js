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
// Caché de slots CRUDOS. Clave: slot_id que ve Claude. Valor: objeto slot tal cual
// lo devolvió Wix + la zona horaria de la respuesta. Esto evita que Claude reconstruya
// fechas a mano (causa histórica de SLOT_NOT_AVAILABLE).
const slotCache = {};

function cacheSlot(serviceKey, index, rawSlot, timeZone) {
  const id = `${serviceKey}_${index}`;
  slotCache[id] = { rawSlot, timeZone, serviceKey, cachedAt: Date.now() };
  return id;
}

// Limpia slots cacheados de más de 2 horas
function purgeSlotCache() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(slotCache)) {
    if (entry.cachedAt < cutoff) delete slotCache[id];
  }
}

async function getAvailableSlots(serviceId, serviceKey) {
  try {
    purgeSlotCache();

    const now = new Date();
    // Wix Time Slots V2 usa fechas locales + timeZone (no ISO UTC)
    const fromLocal = now.toISOString().split(".")[0];
    const toDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
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

    const timeZone = response.data?.timeZone || "America/Santiago";
    const slots = (response.data?.timeSlots || response.data?.availabilityEntries || [])
      .filter(s => s.bookable !== false);

    console.log(`📅 Slots crudos recibidos: ${slots.length} (tz=${timeZone})`);

    const shown = slots.slice(0, 6);
    return shown.map((raw, i) => {
      const id = cacheSlot(serviceKey, i, raw, timeZone);
      return {
        slot_id: id,
        horario: formatSlotDate(raw.localStartDate),
      };
    });
  } catch (error) {
    console.error("❌ Error Wix slots:", error.response?.status, error.response?.data || error.message);
    return { error: "No se pudo consultar disponibilidad. Sugiere al paciente agendar en www.sakros.cl" };
  }
}

// ── Revalidar/enriquecer un slot con Get Availability Time Slot ───
// La lista (List Availability Time Slots) NO devuelve availableResources poblado.
// El endpoint Get sí trae el slot completo con resource, que es obligatorio para reservar.
async function enrichSlot(serviceId, rawSlot, timeZone) {
  const candidates = [
    "https://www.wixapis.com/_api/service-availability/v2/time-slot",
    "https://www.wixapis.com/_api/service-availability/v2/time-slots/get",
    "https://www.wixapis.com/bookings/v2/availability/time-slots/get",
  ];

  for (const url of candidates) {
    try {
      const resp = await axios.post(
        url,
        {
          serviceId: serviceId,
          localStartDate: rawSlot.localStartDate,
          localEndDate: rawSlot.localEndDate,
          timeZone: timeZone,
        },
        { headers: wixHeaders }
      );
      const full = resp.data?.timeSlot || resp.data?.availabilityEntry || resp.data?.slot;
      if (full) {
        console.log(`🔎 Slot enriquecido vía ${url.split("wixapis.com")[1]} — recursos: ${(full.availableResources || []).length}`);
        return full;
      }
    } catch (err) {
      console.log(`⚠️ Get slot ${url.split("wixapis.com")[1]}: ${err.response?.status || err.message}`);
    }
  }
  console.log("ℹ️ No se pudo enriquecer el slot, se usa el de la lista");
  return rawSlot;
}

// ── Caché de recursos (staff) ─────────────────────────────────
let resourceCache = null;
let resourceCacheTime = 0;

async function getResourceByScheduleId(scheduleId) {
  // Cache de 1 hora — los recursos no cambian seguido
  if (resourceCache && Date.now() - resourceCacheTime < 3600000) {
    const cached = resourceCache.find(r => r.scheduleIds?.includes(scheduleId) || r.scheduleId === scheduleId);
    if (cached) return cached.id || cached._id;
  }

  // Intentar varios endpoints de Resources API (Wix cambia URLs frecuentemente)
  const endpoints = [
    "https://www.wixapis.com/_api/bookings-resources/v2/resources/query",
    "https://www.wixapis.com/bookings/v2/resources/query",
  ];

  for (const url of endpoints) {
    try {
      const response = await axios.post(url, { query: {} }, { headers: wixHeaders });
      const resources = response.data?.resources || [];
      console.log(`📋 Resources encontrados (${url.split("/").pop()}):`, resources.length);
      
      if (resources.length > 0) {
        console.log("🔍 Primer resource:", JSON.stringify(resources[0]));
        resourceCache = resources;
        resourceCacheTime = Date.now();
        
        const match = resources.find(r => 
          r.scheduleIds?.includes(scheduleId) || 
          r.scheduleId === scheduleId ||
          r.schedules?.some(s => s.id === scheduleId || s.scheduleId === scheduleId)
        );
        if (match) {
          console.log(`✅ Resource match: ${match.id || match._id} para scheduleId ${scheduleId}`);
          return match.id || match._id;
        }
      }
    } catch (err) {
      console.log(`⚠️ Resources endpoint ${url.split("wixapis.com")[1]} falló:`, err.response?.status || err.message);
    }
  }

  // Fallback: intentar listar staff members
  try {
    const response = await axios.post(
      "https://www.wixapis.com/_api/bookings-staff-members/v1/staff-members/query",
      { query: {} },
      { headers: wixHeaders }
    );
    const staff = response.data?.staffMembers || [];
    console.log(`📋 Staff members encontrados:`, staff.length);
    if (staff.length > 0) {
      console.log("🔍 Primer staff:", JSON.stringify(staff[0]));
      // Si solo hay un staff member, es el correcto
      if (staff.length === 1) return staff[0].id || staff[0]._id;
    }
  } catch (err) {
    console.log("⚠️ Staff members endpoint falló:", err.response?.status || err.message);
  }

  console.log("❌ No se encontró resource para scheduleId:", scheduleId);
  return null;
}

// ── Crear reserva en Wix ──────────────────────────────────────
async function createWixBooking(slotId, name, email, phone) {
  const entry = slotCache[slotId];
  if (!entry) {
    console.error(`❌ slot_id desconocido o expirado: ${slotId}`);
    return {
      success: false,
      error: "Ese horario ya no está en memoria. Vuelve a consultar disponibilidad y pide al paciente que elija de nuevo.",
    };
  }

  const { rawSlot, timeZone, serviceKey } = entry;
  const serviceId = WIX_SERVICES[serviceKey];

  // Revalidar el slot y traer el recurso (staff), que la lista no devuelve poblado
  const full = await enrichSlot(serviceId, rawSlot, timeZone);

  // Wix devuelve locationType "BUSINESS" en disponibilidad pero exige "OWNER_BUSINESS" al reservar
  const LOCATION_TYPE_MAP = {
    BUSINESS: "OWNER_BUSINESS",
    OWNER_BUSINESS: "OWNER_BUSINESS",
    CUSTOM: "CUSTOM",
    OWNER_CUSTOM: "OWNER_CUSTOM",
  };

  const rawLocation = full.location || rawSlot.location || null;
  const location = rawLocation
    ? { ...rawLocation, locationType: LOCATION_TYPE_MAP[rawLocation.locationType] || "OWNER_BUSINESS" }
    : { locationType: "OWNER_BUSINESS" };

  // Recurso: preferir el del slot enriquecido; si no, resolverlo por scheduleId
  let resource = full.availableResources?.[0] || rawSlot.availableResources?.[0] || null;
  const scheduleId = full.scheduleId || rawSlot.scheduleId || null;

  if (!resource && scheduleId) {
    const resolvedId = await getResourceByScheduleId(scheduleId);
    if (resolvedId) resource = { _id: resolvedId, id: resolvedId };
  }

  const slot = {
    serviceId,
    startDate: full.localStartDate || rawSlot.localStartDate,
    endDate: full.localEndDate || rawSlot.localEndDate,
    timezone: timeZone,
    location,
    ...(scheduleId && { scheduleId }),
    ...(resource && {
      resource: {
        ...(resource._id && { _id: resource._id }),
        ...(resource.id && { id: resource.id }),
        ...(resource.scheduleId && { scheduleId: resource.scheduleId }),
        ...(resource.name && { name: resource.name }),
      },
    }),
  };

  const bookingBody = {
    booking: {
      bookedEntity: { slot },
      contactDetails: {
        firstName: name.split(" ")[0],
        lastName: name.split(" ").slice(1).join(" ") || ".",
        ...(email && { email }),
        ...(phone && { phone }),
      },
      numberOfParticipants: 1,
      selectedPaymentOption: "OFFLINE",
    },
    options: {
      flowControlSettings: {
        skipAvailabilityValidation: true,
        skipBusinessConfirmation: true,
        skipSelectedPaymentOptionValidation: true,
      },
    },
  };

  console.log("📤 Wix booking request:", JSON.stringify(bookingBody));

  try {
    const response = await axios.post(
      "https://www.wixapis.com/_api/bookings-service/v2/bookings",
      bookingBody,
      { headers: wixHeaders }
    );

    const booking = response.data?.booking || {};
    const bookingId = booking.id || booking._id || "confirmado";
    const status = booking.status || "CREATED";
    console.log(`📋 Reserva creada: ${bookingId} (${status})`);
    return { success: true, bookingId, status };
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;
    console.error("❌ Error Wix booking:", status, JSON.stringify(data || error.message));

    // Diagnóstico legible para Claude
    let hint = "No se pudo crear la reserva.";
    const msg = data?.message || data?.details?.applicationError?.description || "";
    if (/SLOT_NOT_AVAILABLE|No available slot/i.test(msg)) {
      hint = "Ese horario ya fue tomado o el recurso no está disponible.";
    } else if (/permission|unauthorized|forbidden/i.test(msg) || status === 403) {
      hint = "La API key de Wix no tiene permisos suficientes para crear reservas.";
    }

    return {
      success: false,
      error: `${hint} Discúlpate brevemente y sugiere al paciente agendar en www.sakros.cl o llamar a la secretaria al +56945399692.`,
    };
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
    description: "Crea una reserva REAL en Clínica Sakros. Usa esta herramienta SOLO cuando tengas: 1) el slot_id exacto que el paciente eligió (de los que devolvió consultar_disponibilidad), 2) su nombre completo, y 3) su email o teléfono.",
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
          description: "Email del paciente (vacío si solo dio teléfono)",
        },
        telefono: {
          type: "string",
          description: "Teléfono del paciente (vacío si solo dio email)",
        },
      },
      required: ["slot_id", "nombre"],
    },
  },
];

// ── Ejecutar tool calls ───────────────────────────────────────
async function executeTool(toolName, toolInput) {
  console.log(`🔧 Tool call: ${toolName}(${JSON.stringify(toolInput)})`);

  if (toolName === "consultar_disponibilidad") {
    const serviceKey = toolInput.servicio;
    const serviceId = WIX_SERVICES[serviceKey];
    if (!serviceId) {
      return JSON.stringify({ error: `Servicio "${serviceKey}" no encontrado` });
    }
    const result = await getAvailableSlots(serviceId, serviceKey);
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
    const result = await createWixBooking(
      toolInput.slot_id,
      toolInput.nombre,
      toolInput.email || "",
      toolInput.telefono || ""
    );
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
const SYSTEM_PROMPT = `Eres OsteoJuaco, asistente virtual de Joaquín Adi A., Osteópata y Kinesiólogo en Clínica Sakros, Viña del Mar.

## PRIMERA INTERACCIÓN
Cuando un usuario te escribe por primera vez o te saluda, preséntate brevemente:
"¡Hola! Soy OsteoJuaco, asistente de Joaquín Adi. ¿En qué puedo ayudarte hoy? 👋"
No menciones el Método R.E.S.T. en la presentación — solo menciónalo si el usuario pregunta por sueño o si es relevante en la conversación.

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

### FLUJO DE AGENDAMIENTO (seguir EXACTAMENTE en este orden)
1. Cuando detectes intención de agendar, usa consultar_disponibilidad con el servicio apropiado
2. La herramienta devuelve una lista de horarios, cada uno con un "slot_id" y un "horario" legible
3. Muestra al paciente SOLO los textos de "horario" (nunca los slot_id, son internos)
4. Cuando el paciente elija uno, pídele nombre completo y email o teléfono
5. Llama a crear_reserva pasando el slot_id EXACTO del horario que eligió
6. Si la reserva es exitosa, confirma con entusiasmo mencionando día y hora
7. Si falla, discúlpate brevemente y sigue la instrucción del mensaje de error

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
        const commentText = (comment.text || "").toLowerCase().trim();
        const commentId = comment.id;
        const commenterId = comment.from?.id;
        const commenterUsername = comment.from?.username || "unknown";

        // Ignorar comentarios propios
        if (commenterId === INSTAGRAM_ACCOUNT_ID) continue;

        console.log(`💬 Comentario de @${commenterUsername}: "${comment.text}"`);

        // Buscar keyword de lead magnet
        for (const [keyword, magnet] of Object.entries(LEAD_MAGNETS)) {
          if (commentText.includes(keyword) && !magnet.disabled) {
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

// ── Lead Magnets — Configuración de keywords y archivos ──────
const GITHUB_ASSETS = "https://raw.githubusercontent.com/osteopatajoaquinadi-byte/OsteoJuaco/main/assets";

const LEAD_MAGNETS = {
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
    dmFollowUp: "Descarga la guía completa en PDF aquí:\n${GITHUB_ASSETS}/errores/errores_sueno.pdf\n\n¿Sabías que el Método R.E.S.T. trabaja estos temas en profundidad? 21 días para recuperar tu sueño desde la raíz → www.metodorest.cl 😊\n\nCualquier duda, estoy aquí 💪",
  },
  ejercicio: {
    images: [`${GITHUB_ASSETS}/ejercicio/ejercicio_page_1.jpg`],
    pdf: `${GITHUB_ASSETS}/ejercicio/ejercicio_respiracion.pdf`,
    commentReply: "¡Te lo envío al DM! 📩",
    dmText: "¡Hola! 🌙 Aquí tienes un ejercicio de respiración 4-7-8 para tu sistema nervioso. Practícalo antes de dormir.",
    dmFollowUp: "Descarga la guía completa en PDF aquí:\n${GITHUB_ASSETS}/ejercicio/ejercicio_respiracion.pdf\n\nEste ejercicio es parte del pilar S (Sistema Nervioso) del Método R.E.S.T. → www.metodorest.cl 😊\n\nCualquier duda, estoy aquí 💪",
  },
  stress: {
    images: [],
    pdf: null,
    commentReply: "¡Te lo envío al DM! 📩",
    dmText: "¡Hola! 🌙 Estamos preparando una guía especial sobre estrés. Por ahora te cuento que el Método R.E.S.T. trabaja directamente la regulación del sistema nervioso — un pilar clave para manejar el estrés crónico.",
    dmFollowUp: "Más info en www.metodorest.cl — cualquier duda, estoy aquí 💪",
    disabled: true,  // Activar cuando tenga archivo
  },
};

// Registro para evitar enviar lead magnets duplicados al mismo usuario
const leadMagnetsSent = {};

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
    await axios.post(
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

  // 1. Responder el comentario públicamente
  await replyToComment(commentId, magnet.commentReply);

  // 2. Enviar imágenes por DM
  if (magnet.images.length > 0) {
    // Primero el texto de bienvenida
    await sendInstagramMessage(commenterId, magnet.dmText);

    // Luego las imágenes
    for (const imgUrl of magnet.images) {
      await sendInstagramImage(commenterId, imgUrl);
    }
  }

  // 3. Enviar follow-up con link de descarga + mención del método
  if (magnet.dmFollowUp) {
    // Pequeña pausa para que las imágenes lleguen primero
    await new Promise(resolve => setTimeout(resolve, 2000));
    await sendInstagramMessage(commenterId, magnet.dmFollowUp);
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
