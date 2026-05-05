// ─────────────────────────────────────────────────────────────
// ASISTENTE R.E.S.T. — Servidor puente Instagram ↔ Claude IA
// © Joaquín Adi A. — Todos los derechos reservados
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

// ── Memoria de conversaciones y estado de reservas ───────────
const conversations  = {};
const bookingState   = {}; // estado del flujo de reserva por usuario

// ── Headers Wix ───────────────────────────────────────────────
const wixHeaders = {
  "Authorization": WIX_API_KEY,
  "wix-site-id":   WIX_SITE_ID,
  "Content-Type":  "application/json",
};

// ── Obtener horarios disponibles de Wix ──────────────────────
async function getAvailableSlots(serviceId) {
  try {
    const now   = new Date();
    const start = now.toISOString();
    const end   = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(); // próximos 7 días

    const response = await axios.post(
      "https://www.wixapis.com/bookings/v2/query-availability",
      {
        query: {
          filter: {
            serviceId: [serviceId],
            startDate: start,
            endDate:   end,
          },
        },
      },
      { headers: wixHeaders }
    );

    const slots = response.data?.availabilityEntries || [];
    return slots
      .filter(s => s.bookable && s.openSpots > 0)
      .slice(0, 5) // máximo 5 horarios
      .map(s => ({
        id:    s.slot?.startDate,
        start: s.slot?.startDate,
        label: formatSlotDate(s.slot?.startDate),
      }));
  } catch (error) {
    console.error("❌ Error Wix slots:", error.response?.data || error.message);
    return [];
  }
}

// ── Crear reserva en Wix ──────────────────────────────────────
async function createWixBooking(serviceId, slotStart, name, email) {
  try {
    const response = await axios.post(
      "https://www.wixapis.com/bookings/v2/bookings",
      {
        booking: {
          selectedPaymentOption: "OFFLINE",
          contactDetails: {
            firstName: name.split(" ")[0],
            lastName:  name.split(" ").slice(1).join(" ") || ".",
            email:     email,
          },
          slots: [{
            serviceId: serviceId,
            startDate: slotStart,
          }],
        },
      },
      { headers: wixHeaders }
    );
    return response.data?.booking?.id || null;
  } catch (error) {
    console.error("❌ Error Wix booking:", error.response?.data || error.message);
    return null;
  }
}

// ── Formatear fecha legible ───────────────────────────────────
function formatSlotDate(isoDate) {
  if (!isoDate) return "Horario disponible";
  const d = new Date(isoDate);
  const days = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
  const months = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  const day  = days[d.getDay()];
  const date = d.getDate();
  const month = months[d.getMonth()];
  const hour = d.getHours().toString().padStart(2,"0");
  const min  = d.getMinutes().toString().padStart(2,"0");
  return `${day} ${date} de ${month} a las ${hour}:${min}`;
}

// ── Detectar intención de reserva ─────────────────────────────
function detectBookingIntent(text) {
  const t = text.toLowerCase();
  if (/reserv|agend|cit|hora|turno|quiero ir|quiero asistir|quiero consulta/.test(t)) {
    if (/kinesio/.test(t))  return "kinesiologia";
    if (/osteo/.test(t))    return "osteopatia";
    if (/postur/.test(t))   return "posturologia";
    if (/motion|balance/.test(t)) return "motion";
    return "ask"; // preguntar qué servicio
  }
  return null;
}

// ── Manejar flujo de reserva ──────────────────────────────────
async function handleBookingFlow(senderId, text) {
  const state = bookingState[senderId];

  // PASO 2: usuario eligió servicio
  if (state?.step === "select_service") {
    const t = text.toLowerCase();
    let service = null;
    if (/1|kinesio/.test(t))  service = "kinesiologia";
    if (/2|osteo/.test(t))    service = "osteopatia";
    if (/3|postur/.test(t))   service = "posturologia";
    if (/4|motion|balance/.test(t)) service = "motion";

    if (!service) {
      return "Por favor responde con el número del servicio:\n1️⃣ Kinesiología\n2️⃣ Osteopatía\n3️⃣ Posturología Clínica\n4️⃣ Motion and Balance";
    }

    const serviceNames = {
      kinesiologia: "Kinesiología",
      osteopatia:   "Osteopatía",
      posturologia: "Posturología Clínica",
      motion:       "Motion and Balance",
    };

    const slots = await getAvailableSlots(WIX_SERVICES[service]);
    if (!slots.length) {
      delete bookingState[senderId];
      return `No encontré horarios disponibles para ${serviceNames[service]} en los próximos 7 días. Te recomiendo revisar directamente en www.sakros.cl 🙏`;
    }

    bookingState[senderId] = { step: "select_slot", service, slots };
    const slotList = slots.map((s, i) => `${i+1}️⃣ ${s.label}`).join("\n");
    return `Horarios disponibles para ${serviceNames[service]}:\n\n${slotList}\n\n¿Cuál prefieres? Responde con el número.`;
  }

  // PASO 3: usuario eligió horario
  if (state?.step === "select_slot") {
    const num = parseInt(text.trim()) - 1;
    if (isNaN(num) || num < 0 || num >= state.slots.length) {
      return `Por favor responde con un número del 1 al ${state.slots.length}.`;
    }
    bookingState[senderId] = { ...state, step: "get_name", selectedSlot: state.slots[num] };
    return `Perfecto, seleccionaste *${state.slots[num].label}*. ¿Cuál es tu nombre completo?`;
  }

  // PASO 4: recibir nombre
  if (state?.step === "get_name") {
    if (text.trim().length < 3) return "Por favor escribe tu nombre completo.";
    bookingState[senderId] = { ...state, step: "get_email", name: text.trim() };
    return `Gracias, ${text.split(" ")[0]}. ¿Cuál es tu correo electrónico?`;
  }

  // PASO 5: recibir email y crear reserva
  if (state?.step === "get_email") {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(text.trim())) {
      return "Por favor ingresa un correo válido (ej: nombre@email.com).";
    }

    const email = text.trim();
    const { service, selectedSlot, name } = state;
    const bookingId = await createWixBooking(WIX_SERVICES[service], selectedSlot.start, name, email);

    delete bookingState[senderId];

    if (bookingId) {
      return `✅ ¡Reserva confirmada, ${name.split(" ")[0]}!\n\n📅 ${selectedSlot.label}\n📧 Recibirás confirmación en ${email}\n\nNos vemos en Sakros 🙌`;
    } else {
      return `Hubo un problema al confirmar tu reserva. Por favor agenda directamente en www.sakros.cl o escríbenos. Disculpa los inconvenientes 🙏`;
    }
  }

  return null;
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
- Osteópata Clínico
- Kinesiólogo
- Magíster en Terapia Manual Ortopédica
- Máster en Functional Training
- Máster en Psiconeuroinmunología Clínica (PNI)
- Docente EOM Internacional
- Creó el Método R.E.S.T. tras años de atención clínica y su propia batalla con el insomnio luego de ser diagnosticado con diabetes
- Mencionar su historia personal solo cuando sea relevante y después de entender la situación — nunca en el primer mensaje

## FRASES CENTRALES
"No es falta de sueño, es falta de señales que informen calma a nuestro cerebro."
"El sueño no se fuerza. Aparece cuando te sientes seguro."

## QUÉ SUCEDE CUANDO NO DUERMES
- A nivel cerebral: peor juicio, amígdala reactiva, sistema glinfático reducido, menor plasticidad, más sensibilidad al dolor
- A nivel muscular: menos síntesis proteica (GH/IGF-1), más catabolismo, peor rendimiento neuromuscular, riesgo de fibromialgia
- En el intestino: cortisol altera microbiota, aumentan bacterias proinflamatorias, disminuyen neurotransmisores de calma
- Enfermedades asociadas: diabetes, hipertensión, obesidad, depresión, ansiedad, Alzheimer, Parkinson, fibromialgia, enfermedad cardiovascular

## LOS 4 PILARES DEL MÉTODO R.E.S.T.
R - Ritmo Circadiano + Sleep Drive: sincronizar el reloj biológico con luz matinal, horarios fijos y movimiento físico
E - Eje Intestino-Cerebro: restaurar microbiota para que el nervio vago envíe señales de calma
S - Sistema Nervioso: activar el parasimpático con respiración, entorno y señales de seguridad
T - Timing + Ritmos Ultradianos: respetar ciclos de 90 min durante el día

## TIPOS DE DOLOR
1. Nociceptivo: lesiones, esguinces, tendinopatía — dolor útil, no reposo absoluto, usar PEACE & LOVE
2. Neuropático: ciática, túnel carpiano, hernias — ardor, hormigueo, adormecimiento — requiere evaluación presencial
3. Nociplástico: fibromialgia, dolor persistente, cefaleas — sistema nervioso hipersensible — se trata regulando el sistema nervioso y el sueño

## PROTOCOLO PEACE & LOVE (lesiones agudas)
PEACE (primeras 48-72h): Protection (evitar dolor sin reposo absoluto), Elevation (elevar sobre el corazón), Avoid anti-inflammatories (solo si dolor >7-8), Compression (vendaje), Education (entender la lesión)
LOVE (después): Load (carga progresiva), Optimism (actitud positiva), Vascularisation (cardio sin dolor), Exercise (rehabilitación activa)

## VENTA TEMPORALMENTE DESACTIVADA — MUY IMPORTANTE
El Método R.E.S.T. NO está disponible para la venta en este momento.
- NO menciones el precio
- NO envíes el link de Hotmart
- NO ofrezcas el ebook ni la plataforma
- Si alguien pregunta por el método, di: "Estamos preparando el lanzamiento oficial muy pronto — si quieres ser de los primeros en enterarte, escríbeme aquí y te aviso en cuanto esté disponible 🌙"
- Tu rol ahora es SOLO orientar, educar y derivar a los servicios de Sakros

## RESERVAS EN SAKROS — MUY IMPORTANTE
Cuando el usuario quiera agendar o reservar una consulta, el sistema de reservas está integrado directamente en este chat.
NO derives a sakros.cl para reservar — el bot puede agendar directamente.
Cuando detectes intención de reserva, di: "¡Perfecto! Puedo ayudarte a agendar ahora mismo. ¿Qué servicio necesitas?"

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
      const senderId = event.sender?.id;
      const text     = event.message?.text;

      if (!senderId || !text || event.message?.is_echo) continue;

      console.log(`📩 Mensaje de ${senderId}: ${text}`);

      try {
        // Inicializar historial
        if (!conversations[senderId]) conversations[senderId] = [];

        // ── Flujo de reserva activo ───────────────────────────
        if (bookingState[senderId]) {
          const bookingReply = await handleBookingFlow(senderId, text);
          if (bookingReply) {
            await sendInstagramMessage(senderId, bookingReply);
            continue;
          }
        }

        // ── Detectar intención de reserva ─────────────────────
        const intent = detectBookingIntent(text);
        if (intent === "ask") {
          bookingState[senderId] = { step: "select_service" };
          await sendInstagramMessage(senderId,
            "¡Con gusto te ayudo a agendar! ¿Qué servicio necesitas?\n\n1️⃣ Kinesiología\n2️⃣ Osteopatía\n3️⃣ Posturología Clínica\n4️⃣ Motion and Balance"
          );
          continue;
        }

        if (intent && intent !== "ask") {
          const slots = await getAvailableSlots(WIX_SERVICES[intent]);
          if (slots.length) {
            bookingState[senderId] = { step: "select_slot", service: intent, slots };
            const serviceNames = {
              kinesiologia: "Kinesiología",
              osteopatia:   "Osteopatía",
              posturologia: "Posturología Clínica",
              motion:       "Motion and Balance",
            };
            const slotList = slots.map((s, i) => `${i+1}️⃣ ${s.label}`).join("\n");
            await sendInstagramMessage(senderId,
              `Horarios disponibles para ${serviceNames[intent]}:\n\n${slotList}\n\n¿Cuál prefieres?`
            );
            continue;
          }
        }

        // ── Respuesta normal con Claude ───────────────────────
        conversations[senderId].push({ role: "user", content: text });

        if (conversations[senderId].length > 20) {
          conversations[senderId] = conversations[senderId].slice(-20);
        }

        const response = await axios.post(
          "https://api.anthropic.com/v1/messages",
          {
            model:      "claude-sonnet-4-5",
            max_tokens: 500,
            system:     SYSTEM_PROMPT,
            messages:   conversations[senderId],
          },
          {
            headers: {
              "x-api-key":         ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
              "content-type":      "application/json",
            },
          }
        );

        const reply = response.data.content?.[0]?.text;
        if (!reply) continue;

        conversations[senderId].push({ role: "assistant", content: reply });
        await sendInstagramMessage(senderId, reply);

      } catch (error) {
        console.error("❌ Error:", error.response?.data || error.message);
      }
    }
  }
});

// ── Función para enviar mensaje a Instagram ───────────────────
async function sendInstagramMessage(senderId, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${INSTAGRAM_ACCOUNT_ID}/messages`,
    {
      recipient: { id: senderId },
      message:   { text },
    },
    {
      params: { access_token: PAGE_ACCESS_TOKEN },
    }
  );
  console.log(`✅ Respuesta enviada a ${senderId}`);
}

// ── Health check ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("🌙 OsteoJuaco activo y funcionando.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
