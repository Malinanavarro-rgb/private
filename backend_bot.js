// ===================================
// TOTAL RACKS — BOT WHATSAPP BUSINESS
// Node.js + Express + Meta API + OpenAI
// ===================================

const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { PDFDocument, rgb } = require('pdf-lib');
const fs = require('fs');
const dotenv = require('dotenv');
const OpenAI = require('openai');

dotenv.config();

const app = express();
app.use(express.json());

// ===== CONFIGURACIÓN =====
const WHATSAPP_BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_ACCOUNT_ID;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE = '+528142850036';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: { 'Accept-Encoding': 'identity' },
});

const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ===== MEMORIA EN PROCESO =====
const proyectos = new Map();
const cotizaciones = new Map();
const conversaciones = new Map(); // clienteId → [{role, content}]

// ===== MODELOS =====
class Proyecto {
  constructor(cliente_id, datos) {
    this.id = Date.now().toString();
    this.cliente_id = cliente_id;
    this.tipo_sistema = datos.tipo_sistema;
    this.ubicacion = datos.ubicacion;
    this.material = datos.material;
    this.medidas = datos.medidas;
    this.niveles = datos.niveles;
    this.peso_tarima = datos.peso_tarima;
    this.estado = 'pendiente';
    this.fecha_creacion = new Date();
    this.fecha_cita = null;
    this.vendedor = 'Alina Navarro';
  }

  calcularPosiciones() {
    const { alto, ancho, profundo } = this.medidas;
    return Math.floor((alto / 2) * (ancho / 1.2) * (profundo / 1.2) * this.niveles);
  }

  calcularCosto() {
    return this.calcularPosiciones() * 1560;
  }

  toJSON() {
    return {
      id: this.id,
      cliente_id: this.cliente_id,
      tipo_sistema: this.tipo_sistema,
      ubicacion: this.ubicacion,
      material: this.material,
      medidas: this.medidas,
      niveles: this.niveles,
      peso_tarima: this.peso_tarima,
      posiciones: this.calcularPosiciones(),
      costo_total: this.calcularCosto(),
      estado: this.estado,
      fecha_creacion: this.fecha_creacion,
      fecha_cita: this.fecha_cita,
      vendedor: this.vendedor,
    };
  }
}

// ============================================================
// BEHAVIOR LAYER — EVALUACIÓN DE CONTEXTO PRE-RESPUESTA
// ============================================================

/**
 * Extrae datos conocidos del cliente escaneando el historial de la conversación.
 * Simple y rápido — OpenAI hace la interpretación profunda.
 */
function extraerDatosConocidos(historial) {
  const textos = historial.map(m => m.content).join('\n');

  const conocido = {};

  // Nombre
  const nombre = textos.match(/(?:soy|me llamo|mi nombre es)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+){0,2})/i);
  if (nombre) conocido.nombre = nombre[1].trim();

  // Empresa
  const empresa = textos.match(/(?:empresa|compañía|negocio|de|trabajo en)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ0-9 &.,-]{2,30}?)(?:\.|,|\n|$)/i);
  if (empresa) conocido.empresa = empresa[1].trim();

  // Correo
  const correo = textos.match(/[\w.+%-]+@[\w-]+\.[a-zA-Z]{2,}/);
  if (correo) conocido.correo = correo[0];

  // Ciudad
  const ciudades = ['monterrey', 'apodaca', 'san nicolás', 'guadalupe', 'escobedo', 'santa catarina', 'saltillo', 'ramos arizpe', 'san pedro'];
  for (const c of ciudades) {
    if (textos.toLowerCase().includes(c)) { conocido.ciudad = c; break; }
  }

  // Tipo de rack
  const tiposRack = ['selectivo', 'drive-in', 'drive in', 'cantilever', 'flow rack', 'entrepiso', 'locker'];
  for (const r of tiposRack) {
    if (textos.toLowerCase().includes(r)) { conocido.tipo_rack = r; break; }
  }

  // Peso por pallet
  const peso = textos.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilos?|ton(?:eladas?)?)\b/i);
  if (peso) conocido.peso_pallet = peso[0];

  // Altura de nave
  const altura = textos.match(/(\d+(?:\.\d+)?)\s*(?:m|mts?|metros?)\s*(?:de\s+)?(?:altura|alto|libre)/i);
  if (altura) conocido.altura_nave = altura[0];

  // Mercancía
  const mercancia = textos.match(/(?:almacenamos?|guardamos?|tenemos?|producto|mercancía)\s+([a-záéíóúñA-ZÁÉÍÓÚÑ ,]{3,40}?)(?:\.|,|\n|$)/i);
  if (mercancia) conocido.mercancia = mercancia[1].trim();

  return conocido;
}

/**
 * Determina la etapa comercial basándose en lo que ya sabe TARA.
 */
function detectarEtapa(historial, conocido) {
  const turnos = Math.floor(historial.length / 2);
  const textos = historial.map(m => m.content).join('\n').toLowerCase();

  const quiereCotizacion = /cotiz|presupuesto|precio|cuánto cuesta|cuanto cuesta|propuesta/.test(textos);
  const quiereVisita = /visita|cita|vayan|vengan|ir a ver|revisar in situ/.test(textos);
  const tieneContacto = !!(conocido.nombre && (conocido.empresa || conocido.correo));
  const tieneTecnico = !!(conocido.tipo_rack || conocido.peso_pallet || conocido.altura_nave || conocido.mercancia);

  if (tieneContacto && (quiereCotizacion || quiereVisita)) return 'Cotización';
  if (quiereCotizacion || quiereVisita) return 'Recomendación';
  if (tieneTecnico) return 'Calificación';
  if (turnos >= 1) return 'Descubrimiento';
  return 'Primer contacto';
}

/**
 * Decide cuál es el siguiente paso lógico, incluyendo el POR QUÉ de cada pregunta.
 * Esto va dentro del contexto dinámico para que TARA justifique naturalmente cada pregunta.
 */
function siguientePasoLogico(etapa, faltantes, conocido) {
  switch (etapa) {
    case 'Primer contacto':
      return 'Hacer una pregunta abierta sobre la operación del negocio, no sobre el rack. Entender el problema antes de hablar de soluciones.';
    case 'Descubrimiento':
      if (!conocido.mercancia) return 'Preguntar qué tipo de mercancía manejan. Razón: el producto define si se necesita acceso individual (selectivo), densidad máxima (drive-in) o material especial (cantilever).';
      return 'Ya tienes la mercancía. Ahora entender la operación: ¿es FIFO, LIFO, alta rotación? Eso determina el sistema.';
    case 'Calificación':
      if (!conocido.peso_pallet) return 'Preguntar el peso por pallet. Razón: define la capacidad de carga de los largueros y la estructura. Sin este dato no se puede dimensionar correctamente.';
      if (!conocido.altura_nave) return 'Preguntar altura libre de la nave. Razón: determina cuántos niveles de almacenamiento son posibles y el aprovechamiento vertical del espacio.';
      if (!conocido.ciudad) return 'Preguntar la ubicación del proyecto. Razón: para coordinar visita técnica y evaluar si aplica la zona de atención.';
      return 'Ya tienes suficiente información técnica. Dar una recomendación concreta con justificación, luego proponer visita o cotización.';
    case 'Recomendación':
      if (!conocido.nombre) return 'Pedir nombre y empresa de forma natural, como parte del avance a la propuesta. No como formulario.';
      if (!conocido.correo) return 'Pedir correo para enviar la propuesta formal. Confirmarlo explícitamente para evitar errores.';
      return 'Tienes todo. Proponer visita técnica para validar medidas antes de la propuesta definitiva.';
    case 'Cotización':
      return 'Confirmar datos de contacto completos y coordinar fecha de visita técnica o envío de propuesta.';
    default:
      return 'Avanzar al siguiente paso comercial con criterio de consultora, no de formulario.';
  }
}

/**
 * Construye el bloque de contexto dinámico que se inyecta al prompt antes de llamar a OpenAI.
 * Incluye diagnóstico del negocio, no solo checklist de datos.
 * Este bloque es el "pensamiento previo" de TARA — nunca lo ve el cliente.
 */
function construirContextoDinamico(historial) {
  const conocido = extraerDatosConocidos(historial);
  const etapa = detectarEtapa(historial, conocido);
  const turnos = Math.floor(historial.length / 2);

  const camposDatos = [
    ['nombre', conocido.nombre, null],
    ['empresa', conocido.empresa, null],
    ['ciudad', conocido.ciudad, null],
    ['correo', conocido.correo, null],
    ['mercancía', conocido.mercancia, 'define el tipo de sistema (selectivo vs drive-in vs cantilever)'],
    ['peso por pallet', conocido.peso_pallet, 'dimensiona la capacidad de carga de la estructura'],
    ['altura de nave', conocido.altura_nave, 'determina cuántos niveles son posibles'],
  ];

  const confirmados = camposDatos.filter(([, v]) => v).map(([k, v]) => `• ${k}: ${v}`);
  const faltantesCriticos = camposDatos
    .filter(([, v, razon]) => !v && razon)
    .map(([k, , razon]) => `• ${k} → ${razon}`);

  const siguiente = siguientePasoLogico(etapa, camposDatos.filter(([, v]) => !v).map(([k]) => k), conocido);

  // Señal de diagnóstico: si ya hay mercancía, inferir posible sistema
  let hipotesisSistema = '';
  if (conocido.mercancia) {
    const m = conocido.mercancia.toLowerCase();
    if (/tubo|perfil|madera|rollo|barra|lamina/.test(m)) hipotesisSistema = 'Posible: rack cantilever (material largo sin embalaje)';
    else if (/caja|pallet|tarima|producto|refaccion|electr/.test(m)) hipotesisSistema = 'Posible: rack selectivo (acceso individual, múltiples SKUs)';
    else if (/homogen|granel|bodega llena|mismo producto/.test(m)) hipotesisSistema = 'Posible: rack drive-in (máxima densidad, producto homogéneo)';
  }

  return `
[EVALUACIÓN INTERNA DE TARA — NO INCLUIR EN LA RESPUESTA AL CLIENTE]
Turno de conversación: ${turnos}
Etapa comercial: ${etapa}
${confirmados.length ? `Lo que ya sé del cliente:\n${confirmados.join('\n')}` : 'Aún no tengo datos del cliente.'}
${faltantesCriticos.length ? `\nDatos técnicos pendientes (con su razón):\n${faltantesCriticos.join('\n')}` : ''}
${hipotesisSistema ? `\nHipótesis de sistema: ${hipotesisSistema}` : ''}
\nSiguiente paso: ${siguiente}
\nRegla crítica: NO preguntes lo que ya está en "Lo que ya sé". Si el cliente lo repite, confírmalo. Justifica cada pregunta técnica con su razón de negocio.
[FIN EVALUACIÓN]
`;
}

// ===== TARA™ — SYSTEM PROMPT v3 — CONSULTORA COMERCIAL =====
const TARA_SYSTEM_PROMPT = `Eres TARA™, consultora comercial especializada en soluciones de almacenamiento industrial. Trabajas en Total Racks, empresa que fabrica e instala sistemas de racks en el noreste de México.

MENTALIDAD FUNDAMENTAL:
TARA no vende racks. TARA diagnostica necesidades de almacenamiento. Los racks son la consecuencia del diagnóstico, no el punto de partida.

Piensas como una ingeniera comercial con experiencia en cientos de proyectos de bodegas industriales. Antes de cada respuesta te preguntas:
1. ¿Qué problema real está tratando de resolver este negocio?
2. ¿Por qué necesito este dato y cómo afecta la solución?
3. ¿Esta respuesta demuestra experiencia real o parece un formulario?
4. ¿Estoy avanzando hacia una solución concreta?

Si alguna respuesta es NO, reescribes.

IDENTIDAD:
Trabajas EN Total Racks. Usas "nosotros", "coordinamos", "instalamos", "nuestra propuesta". No eres externa ni intermediaria.
Nunca dices que eres IA, bot, ChatGPT ni asistente virtual.
Nunca usas: "No tengo acceso a...", "No puedo verificar...", "Como inteligencia artificial...", "Aprecio tu entusiasmo", "Estoy aquí para ayudarte", "Gracias por tu mensaje", "Un especialista se pondrá en contacto".

CÓMO PREGUNTAR:
Cada pregunta lleva su razón. No cuestionarios. Consultoría.

MAL → "¿Cuánto pesa el pallet?"
BIEN → "Para dimensionar correctamente la estructura, ¿aproximadamente cuánto pesa cada pallet?"

MAL → "¿Qué altura tiene la nave?"
BIEN → "La altura libre de la nave determina cuántos niveles podemos aprovechar. ¿Cuántos metros tiene?"

MAL → "¿Qué producto almacena?"
BIEN → "¿Qué tipo de mercancía manejas? Con eso entiendo si necesitamos acceso individual por SKU o densidad máxima."

MAL → "¿Cuántas posiciones necesitas?"
BIEN → "Para estimar la capacidad, ¿tienes una idea del volumen que necesitas mover o almacenar por día?"

CÓMO DEMOSTRAR EXPERIENCIA:
Conecta los datos del cliente con la lógica de la solución.

Ejemplo — cliente con muchos SKUs:
"Con 300 SKUs distintos, lo que mejor funciona es rack selectivo. Te da acceso directo a cada posición sin mover otra carga. La altura de la nave y el peso por caja son lo que necesito para dimensionarlo bien."

Ejemplo — cliente que ya vio otros proveedores:
"Bien hecho, comparar siempre ayuda. Lo que importa es que el sistema se adapte a la operación real, no solo al espacio. Dos proyectos con cargas similares pueden requerir soluciones distintas según la rotación y el flujo de mercancía. ¿Qué opciones te presentaron?"

Ejemplo — cliente que pide precio antes de dar datos:
"El costo depende de la configuración. Con el peso de la carga, la altura de la nave y las dimensiones del almacén puedo orientarte con un estimado y, si cuadra, preparamos una propuesta formal."

PROACTIVIDAD:
Cuando tengas suficiente información técnica, no esperes que el cliente pida el siguiente paso. Proponlo tú.
"Con estos datos ya puedo orientarte con una solución inicial. Si estás de acuerdo, coordinamos una visita técnica para validar medidas antes de la propuesta."

SISTEMAS QUE MANEJAMOS:
- Rack selectivo: acceso directo, alta rotación, múltiples SKUs.
- Rack drive-in / drive-through: máxima densidad, producto homogéneo, LIFO o FIFO.
- Rack cantilever: material largo sin embalaje — tubos, perfiles, madera, rollos.
- Flow rack: FIFO estricto, líneas de producción, perecederos, alta rotación.
- Entrepisos metálicos: aprovechan la altura vertical creando un segundo nivel operativo.
- Lockers industriales: herramientas, equipo personal, valuables.

DIFERENCIADOR (solo si el cliente pregunta o es relevante):
"Además de fabricar e instalar, tenemos un sistema digital propio para visualizar inventario y capacidad en tiempo real — sin costo adicional de software."

GEOLOCALIZACIÓN:
Si el cliente menciona ciudad o zona (Monterrey, Apodaca, San Nicolás, Guadalupe, Escobedo, Santa Catarina, Saltillo, Ramos Arizpe), úsala una vez de forma natural. No la repitas en cada mensaje.

INFORMACIÓN AMBIGUA:
Si algo no quedó claro, pregunta antes de asumir.
"¿Te refieres al dominio del correo? ¿Me lo compartes completo para registrarlo correctamente?"
NUNCA inventes correos, dominios, empresas ni ningún dato que el cliente no dio de forma explícita.

CONFIRMACIÓN DE DATOS:
Cuando el cliente dé sus datos de contacto, confirma exactamente lo que entendiste. Marca como pendiente lo ambiguo.
"Perfecto, [Nombre]. Confirmo:
• Empresa: [empresa]
• Ciudad: [ciudad]
• Teléfono: mismo número de WhatsApp
• Correo: [correo exacto]
Con esto ya avanzo tu solicitud para coordinar visita y propuesta."

EMPATÍA:
Si el cliente agradece, responde con calidez real, no frase genérica.
"Me alegra, aquí estaré durante todo el proceso."

REGLAS DE FORMATO:
- Máximo 2 párrafos cortos. Estilo WhatsApp natural.
- Una pregunta por mensaje cuando sea posible.
- Nunca repetir preguntas ya respondidas.
- Nunca inventar precios ni tiempos de entrega.

RESPONDE SOLO EN JSON VÁLIDO. Sin texto antes ni después. Sin markdown. Sin backticks.
{
  "etapa": "Primer contacto|Descubrimiento|Calificación|Recomendación|Cotización|Cierre",
  "siguiente_paso": "qué hará TARA en el próximo mensaje si el cliente responde",
  "respuesta": "mensaje para el cliente, máximo 2 párrafos, estilo WhatsApp"
}`;

// ===== PARSE SEGURO DE JSON =====
function safeParseJSON(contenido) {
  try {
    return JSON.parse(contenido);
  } catch (_) {}

  try {
    const inicio = contenido.indexOf('{');
    const fin = contenido.lastIndexOf('}');
    if (inicio !== -1 && fin > inicio) {
      return JSON.parse(contenido.substring(inicio, fin + 1));
    }
  } catch (_) {}

  const texto = contenido.trim();
  if (texto.length > 5) return { respuesta: texto };
  return { respuesta: 'Cuéntame más sobre tu proyecto.' };
}

// ===== HISTORIAL EN MEMORIA =====
function agregarAlHistorial(clienteId, role, contenido) {
  if (!conversaciones.has(clienteId)) conversaciones.set(clienteId, []);
  const historial = conversaciones.get(clienteId);
  historial.push({ role, content: contenido });
  if (historial.length > 20) historial.splice(0, historial.length - 20);
}

function obtenerHistorial(clienteId) {
  return conversaciones.get(clienteId) || [];
}

// ===== TARA™ — GENERAR RESPUESTA =====
async function generarRespuestaTara(clienteId, mensajeCliente) {
  try {
    const historial = obtenerHistorial(clienteId);

    // Behavior Layer: evaluar contexto antes de llamar a OpenAI
    const contextoDinamico = construirContextoDinamico(historial);
    const systemConContexto = TARA_SYSTEM_PROMPT + '\n\n' + contextoDinamico;

    const mensajes = [
      { role: 'system', content: systemConContexto },
      ...historial,
      { role: 'user', content: mensajeCliente },
    ];

    console.log(`\n📊 Behavior Layer [${clienteId}]:`);
    console.log(contextoDinamico.trim());

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: mensajes,
      temperature: 0.65,
      max_tokens: 600,
      response_format: { type: 'json_object' },
    });

    const crudo = response.choices[0].message.content.trim();
    const parsed = safeParseJSON(crudo);

    // Log pensamiento interno de TARA
    if (parsed.etapa) console.log(`🧠 Etapa: ${parsed.etapa} | Siguiente: ${parsed.siguiente_paso}`);

    const respuesta = parsed.respuesta || 'Cuéntame más sobre tu proyecto.';

    agregarAlHistorial(clienteId, 'user', mensajeCliente);
    agregarAlHistorial(clienteId, 'assistant', respuesta);

    console.log(`✅ TARA → ${clienteId}: ${respuesta.substring(0, 100)}...`);
    return respuesta;
  } catch (error) {
    console.error('❌ Error OpenAI:', error.message);
    return '¿En qué puedo ayudarte con tu proyecto de almacenamiento?';
  }
}

// ===== WEBHOOK META — VERIFICACIÓN =====
app.get('/webhook', (req, res) => {
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (token === process.env.WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Invalid token');
  }
});

// ===== WEBHOOK META — RECIBIR MENSAJES =====
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object) {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.value.messages) {
            for (const message of change.value.messages) {
              if (message.text?.body) {
                const clienteId = message.from;
                const texto = message.text.body;
                console.log(`\n📱 Mensaje de ${clienteId}: "${texto}"`);
                const respuesta = await generarRespuestaTara(clienteId, texto);
                await enviarMensajeWhatsApp(clienteId, respuesta);
              }
            }
          }
        }
      }
      res.status(200).send('EVENT_RECEIVED');
    } else {
      res.status(404).send('Not found');
    }
  } catch (error) {
    console.error('Error en webhook:', error);
    res.status(500).send('Error');
  }
});

// ===== ENVIAR MENSAJE WHATSAPP =====
async function enviarMensajeWhatsApp(numeroDestino, mensaje) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${WHATSAPP_BUSINESS_ACCOUNT_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: numeroDestino,
        type: 'text',
        text: { body: mensaje },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`✓ Mensaje enviado a ${numeroDestino}`);
    return response.data;
  } catch (error) {
    console.error('Error enviando mensaje:', error.response?.data || error.message);
  }
}

// ===== API INTERNA — PROYECTOS =====
app.post('/api/proyectos', async (req, res) => {
  try {
    const { cliente_id, cliente_nombre, cliente_email, cliente_telefono, ...datosProyecto } = req.body;
    const proyecto = new Proyecto(cliente_id, datosProyecto);
    proyectos.set(proyecto.id, { ...proyecto.toJSON(), cliente_nombre, cliente_email, cliente_telefono });

    const pdfPath = await generarPDF(proyecto.toJSON(), cliente_nombre, cliente_email);

    await emailTransporter.sendMail({
      from: process.env.EMAIL_USER,
      to: 'alina.navarro@totalracks.com.mx',
      subject: `📋 Nueva cotización pendiente - ${cliente_nombre}`,
      html: `
        <h2>Nueva Cotización Pendiente</h2>
        <p><strong>Cliente:</strong> ${cliente_nombre}</p>
        <p><strong>Email:</strong> ${cliente_email}</p>
        <p><strong>Sistema:</strong> ${datosProyecto.tipo_sistema}</p>
        <p><strong>Ubicación:</strong> ${datosProyecto.ubicacion}</p>
        <p><strong>Costo Estimado:</strong> $${proyecto.calcularCosto().toLocaleString('es-MX')}</p>
        <p><strong>Posiciones:</strong> ${proyecto.calcularPosiciones()}</p>
        <br>
        <a href="${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}/dashboard">Ver en Dashboard</a>
      `,
      attachments: [{ path: pdfPath }],
    });

    await enviarMensajeWhatsApp(
      cliente_telefono,
      `✅ Listo, ya tenemos tu proyecto.\n\nRevisamos:\n• ${datosProyecto.tipo_sistema}\n• ${proyecto.calcularPosiciones()} posiciones\n\nTe contactamos para coordinar el siguiente paso.`
    );

    res.json({ success: true, proyecto_id: proyecto.id, posiciones: proyecto.calcularPosiciones(), costo_total: proyecto.calcularCosto() });
  } catch (error) {
    console.error('Error creando proyecto:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/proyectos/pendientes', (req, res) => {
  const pendientes = Array.from(proyectos.values()).filter(p => p.estado === 'pendiente');
  res.json(pendientes);
});

app.post('/api/proyectos/:id/agendar-cita', async (req, res) => {
  try {
    const { id } = req.params;
    const { fecha, hora } = req.body;
    const proyecto = proyectos.get(id);
    if (!proyecto) return res.status(404).json({ error: 'Proyecto no encontrado' });

    proyecto.fecha_cita = `${fecha} ${hora}`;
    proyecto.estado = 'cotizacion_enviada';

    await enviarMensajeWhatsApp(
      proyecto.cliente_telefono,
      `¡Todo listo!\n\n📅 Visita técnica confirmada:\n${fecha} a las ${hora}\n👤 Con: Alina Navarro\n\nCualquier duda me avisas.`
    );

    res.json({ success: true, proyecto });
  } catch (error) {
    console.error('Error agendando cita:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== GENERADOR DE PDF =====
async function generarPDF(proyecto, clienteNombre, clienteEmail) {
  const pdfPath = `./cotizaciones/COT_${proyecto.id}.pdf`;
  console.log(`📄 PDF generado: ${pdfPath}`);
  return pdfPath;
}

// ===== ARCHIVOS ESTÁTICOS =====
app.use(express.static('public'));

app.get('/dashboard', (req, res) => {
  res.sendFile(__dirname + '/dashboard_vendedor.html');
});

app.get('/generador-pdf', (req, res) => {
  res.sendFile(__dirname + '/generador_cotizacion_pdf.html');
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', bot: 'TARA™ Behavior Layer v1', timestamp: new Date().toISOString() });
});

// ===== INICIAR SERVIDOR =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║   TARA™ — Behavior Layer v1               ║
║   ✓ Puerto: ${PORT}                           ║
║   ✓ Webhook: POST /webhook                ║
║   ✓ Dashboard: GET /dashboard             ║
║   ✓ Generador PDF: GET /generador-pdf     ║
╚════════════════════════════════════════════╝
  `);
});

module.exports = app;
