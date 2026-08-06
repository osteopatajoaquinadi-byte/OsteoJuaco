# Segmentación de pacientes desde Wix

Script de **solo lectura** que clasifica a los pacientes de Clínica Sakros según cuándo fue su última cita. No modifica nada en Wix y no envía mensajes.

## Qué genera

Un archivo `pacientes_segmentados.csv` (se abre con Excel o Numbers) con columnas:

| Columna | Descripción |
|---|---|
| Nombre | Nombre del paciente |
| Telefono | Teléfono registrado en la reserva |
| Email | Email registrado |
| Ultima cita | Fecha de su cita más reciente |
| Dias desde ultima | Cuántos días pasaron desde esa cita |
| Total visitas | Cuántas reservas tiene en total |
| Segmento | Activo / En riesgo / Inactivo / Una sola visita |

## Segmentos

| Segmento | Criterio | Uso sugerido |
|---|---|---|
| 🟢 **Activo** | Última cita ≤ 90 días | — |
| 🟡 **En riesgo** | Última cita entre 90 y 180 días | Recaptación prioritaria |
| 🔴 **Inactivo** | Última cita > 180 días | Campaña de reactivación |
| ⚪ **Una sola visita** | 1 cita total y ya pasaron > 90 días | Seguimiento distinto |

Los umbrales (90 y 180 días) se pueden cambiar arriba del script en `DIAS_ACTIVO` y `DIAS_RIESGO`.

## Cómo ejecutarlo (Terminal del Mac)

1. Descarga `segmentar_pacientes.js` a una carpeta, por ejemplo el Escritorio.
2. Abre la Terminal (Aplicaciones → Utilidades → Terminal).
3. Ve a la carpeta:
   ```
   cd ~/Desktop
   ```
4. Instala la dependencia (solo la primera vez):
   ```
   npm install axios
   ```
5. Ejecuta pegando tu API key de Wix:
   ```
   WIX_API_KEY="tu_api_key_aqui" node segmentar_pacientes.js
   ```

Al terminar verás un resumen en pantalla y se creará `pacientes_segmentados.csv` en la misma carpeta.

## Notas

- La API key **no se guarda** en ningún archivo: se pasa solo al momento de ejecutar.
- El script pagina automáticamente, así que trae todas las reservas aunque sean miles.
- La identidad del paciente se agrupa por email; si no hay email, por teléfono.
- **Importante sobre el envío:** este script solo clasifica. Antes de enviar cualquier mensaje de recaptación, recuerda que WhatsApp exige consentimiento previo (opt-in) y que los datos de pacientes son sensibles. Lo recomendable es contactar solo a quienes aceptaron recibir comunicaciones.
