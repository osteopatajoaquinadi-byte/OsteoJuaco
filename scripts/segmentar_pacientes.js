/**
 * ─────────────────────────────────────────────────────────────
 * SEGMENTACIÓN DE PACIENTES DESDE WIX BOOKINGS
 * Script standalone — NO forma parte del bot de Instagram.
 * © Joaquín Adi A. — Clínica Sakros
 * ─────────────────────────────────────────────────────────────
 *
 * Qué hace:
 *   Lee TODAS las reservas de Wix Bookings, agrupa por paciente,
 *   calcula la fecha de su última cita y su total de visitas, y
 *   los clasifica en segmentos. Genera un archivo CSV.
 *
 * Es SOLO LECTURA. No modifica nada en Wix. No envía mensajes.
 *
 * ─────────────────────────────────────────────────────────────
 * CÓMO EJECUTARLO (desde la Terminal del Mac):
 *
 *   1. Descarga este archivo a una carpeta, por ejemplo el Escritorio.
 *   2. Abre la Terminal (Aplicaciones → Utilidades → Terminal).
 *   3. Ve a la carpeta donde está el script, por ejemplo:
 *          cd ~/Desktop
 *   4. Instala la única dependencia (solo la primera vez):
 *          npm install axios
 *   5. Ejecuta el script pegando tu WIX_API_KEY:
 *          WIX_API_KEY="tu_api_key_aqui" node segmentar_pacientes.js
 *
 *   Al terminar, se genera el archivo:  pacientes_segmentados.csv
 *   en la misma carpeta. Ábrelo con Excel o Numbers.
 * ─────────────────────────────────────────────────────────────
 */

const axios = require("axios");
const fs = require("fs");

// ── Configuración ─────────────────────────────────────────────
const WIX_API_KEY = process.env.WIX_API_KEY;
const WIX_SITE_ID = process.env.WIX_SITE_ID || "2f4dc72c-c9c9-4384-a02f-83ce0e798113";

// Umbrales de segmentación (en días). Ajustables.
const DIAS_ACTIVO   = 90;   // última cita ≤ 90 días
const DIAS_RIESGO   = 180;  // última cita entre 90 y 180 días

if (!WIX_API_KEY) {
  console.error("\n❌ Falta la WIX_API_KEY.");
  console.error('   Ejecuta así:  WIX_API_KEY="tu_key" node segmentar_pacientes.js\n');
  process.exit(1);
}

const wixHeaders = {
  "Authorization": WIX_API_KEY,
  "wix-site-id":   WIX_SITE_ID,
  "Content-Type":  "application/json",
};

// ── Traer TODAS las reservas (paginado, máx 100 por página) ───
async function traerTodasLasReservas() {
  const todas = [];
  let cursor = null;
  let pagina = 0;

  do {
    pagina++;
    const query = {
      query: {
        sort: [{ fieldName: "createdDate", order: "DESC" }],
        cursorPaging: { limit: 100, ...(cursor && { cursor }) },
      },
    };

    let resp;
    try {
      resp = await axios.post(
        "https://www.wixapis.com/bookings/v2/bookings/query",
        query,
        { headers: wixHeaders }
      );
    } catch (err) {
      // Fallback al endpoint alternativo de lectura
      resp = await axios.post(
        "https://www.wixapis.com/_api/bookings-reader-service/v2/bookings/query",
        query,
        { headers: wixHeaders }
      );
    }

    const bookings = resp.data.bookings || resp.data.extendedBookings || [];
    todas.push(...bookings);
    cursor = resp.data.pagingMetadata && resp.data.pagingMetadata.cursors
      ? resp.data.pagingMetadata.cursors.next
      : null;

    process.stdout.write(`\r📥 Reservas leídas: ${todas.length} (página ${pagina})   `);
  } while (cursor);

  console.log("");
  return todas;
}

// ── Extraer datos del paciente de una reserva ─────────────────
function datosPaciente(booking) {
  const b = booking.booking || booking;
  const c = b.contactDetails || {};
  const nombre = [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || "(sin nombre)";
  const email = c.email || "";
  const telefono = c.phone || "";
  const contactId = c.contactId || "";

  // Fecha de la cita: probar varias rutas según la estructura de Wix
  const slot = (b.bookedEntity && b.bookedEntity.slot) || {};
  const fechaStr = slot.startDate || b.startDate || b.createdDate || null;
  const fecha = fechaStr ? new Date(fechaStr) : null;

  // Clave de identidad: email > teléfono > contactId > nombre
  const clave = (email || telefono || contactId || nombre).toLowerCase();

  return { clave, nombre, email, telefono, contactId, fecha };
}

// ── Clasificar por segmento según días desde la última cita ───
function clasificar(diasDesdeUltima, totalVisitas) {
  if (totalVisitas === 1 && diasDesdeUltima > DIAS_ACTIVO) return "Una sola visita";
  if (diasDesdeUltima <= DIAS_ACTIVO) return "Activo";
  if (diasDesdeUltima <= DIAS_RIESGO) return "En riesgo";
  return "Inactivo";
}

// ── Escapar campo para CSV ────────────────────────────────────
function csvEscape(v) {
  const s = String(v == null ? "" : v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ── Main ──────────────────────────────────────────────────────
(async () => {
  console.log("\n🔍 Consultando Wix Bookings (solo lectura)...\n");

  let reservas;
  try {
    reservas = await traerTodasLasReservas();
  } catch (err) {
    console.error("\n❌ Error consultando Wix:", err.response ? JSON.stringify(err.response.data) : err.message);
    console.error("   Verifica que la WIX_API_KEY sea correcta y tenga permisos de lectura de Bookings.\n");
    process.exit(1);
  }

  if (reservas.length === 0) {
    console.log("⚠️ No se encontraron reservas. Revisa la API key o si hay bookings registrados.");
    process.exit(0);
  }

  // Agrupar por paciente
  const pacientes = {};
  for (const r of reservas) {
    const d = datosPaciente(r);
    if (!d.clave) continue;

    if (!pacientes[d.clave]) {
      pacientes[d.clave] = {
        nombre: d.nombre, email: d.email, telefono: d.telefono,
        contactId: d.contactId, ultimaCita: d.fecha, totalVisitas: 0,
      };
    }
    const p = pacientes[d.clave];
    p.totalVisitas++;
    // Guardar el nombre/teléfono más completo que aparezca
    if (!p.telefono && d.telefono) p.telefono = d.telefono;
    if (!p.email && d.email) p.email = d.email;
    if (d.fecha && (!p.ultimaCita || d.fecha > p.ultimaCita)) p.ultimaCita = d.fecha;
  }

  // Clasificar
  const ahora = new Date();
  const filas = [];
  const conteo = { "Activo": 0, "En riesgo": 0, "Inactivo": 0, "Una sola visita": 0 };

  for (const clave in pacientes) {
    const p = pacientes[clave];
    const dias = p.ultimaCita
      ? Math.floor((ahora - p.ultimaCita) / (1000 * 60 * 60 * 24))
      : 99999;
    const segmento = clasificar(dias, p.totalVisitas);
    conteo[segmento]++;

    filas.push({
      nombre: p.nombre,
      telefono: p.telefono,
      email: p.email,
      ultimaCita: p.ultimaCita ? p.ultimaCita.toISOString().split("T")[0] : "",
      diasDesdeUltima: dias === 99999 ? "" : dias,
      totalVisitas: p.totalVisitas,
      segmento: segmento,
    });
  }

  // Ordenar: primero los inactivos/en riesgo (más útiles para recaptación)
  const orden = { "En riesgo": 0, "Inactivo": 1, "Una sola visita": 2, "Activo": 3 };
  filas.sort((a, b) => (orden[a.segmento] - orden[b.segmento]) || (b.totalVisitas - a.totalVisitas));

  // Escribir CSV
  const cabecera = ["Nombre", "Telefono", "Email", "Ultima cita", "Dias desde ultima", "Total visitas", "Segmento"];
  const lineas = [cabecera.join(",")];
  for (const f of filas) {
    lineas.push([
      csvEscape(f.nombre), csvEscape(f.telefono), csvEscape(f.email),
      csvEscape(f.ultimaCita), csvEscape(f.diasDesdeUltima),
      csvEscape(f.totalVisitas), csvEscape(f.segmento),
    ].join(","));
  }

  const nombreArchivo = "pacientes_segmentados.csv";
  // BOM para que Excel abra bien los acentos
  fs.writeFileSync(nombreArchivo, "\uFEFF" + lineas.join("\n"), "utf8");

  // Resumen en pantalla
  console.log("\n✅ Listo. Resumen:\n");
  console.log(`   🟢 Activos (≤ ${DIAS_ACTIVO} días):        ${conteo["Activo"]}`);
  console.log(`   🟡 En riesgo (${DIAS_ACTIVO}-${DIAS_RIESGO} días):   ${conteo["En riesgo"]}`);
  console.log(`   🔴 Inactivos (> ${DIAS_RIESGO} días):      ${conteo["Inactivo"]}`);
  console.log(`   ⚪ Una sola visita:            ${conteo["Una sola visita"]}`);
  console.log(`   ──────────────────────────────`);
  console.log(`   Total pacientes únicos:       ${filas.length}`);
  console.log(`   Total reservas procesadas:    ${reservas.length}`);
  console.log(`\n📄 Archivo generado: ${nombreArchivo}`);
  console.log("   Ábrelo con Excel o Numbers.\n");
})();
