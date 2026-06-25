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
 * Decide cuál es el siguiente paso lógico según la etapa y los datos faltantes.
 */
function siguientePasoLogico(etapa, faltantes, conocido) {
  switch (etapa) {
    case 'Primer contacto':
      return 'Saludar y hacer una pregunta abierta para entender qué necesita.';
    case 'Descubrimiento':
      if (!conocido.mercancia) return 'Preguntar qué tipo de mercancía o producto almacena.';
      return 'Identificar el tipo de sistema que puede necesitar.';
    case 'Calificación':
      if (!conocido.peso_pallet) return 'Preguntar peso por pallet o carga unitaria.';
      if (!conocido.altura_nave) return 'Preguntar altura libre de la nave.';
      if (!conocido.ciudad) return 'Preguntar en qué ciudad o zona está el almacén.';
      return 'Dar recomendación técnica con justificación concreta.';
    case 'Recomendación':
      if (!conocido.nombre) return 'Pedir nombre y empresa para avanzar a propuesta.';
      if (!conocido.correo) return 'Pedir correo electrónico para enviar la propuesta.';
      return 'Proponer visita técnica o cotización formal.';
    case 'Cotización':
      return 'Confirmar datos de contacto y coordinar visita técnica o propuesta formal.';
    default:
      return 'Avanzar naturalmente hacia el siguiente paso comercial.';
  }
}

/**
 * Construye el bloque de contexto dinámico que se inyecta al prompt antes de llamar a OpenAI.
 * Este bloque es el "pensamiento previo" de TARA — nunca lo ve el cliente.
 */
function construirContextoDinamico(historial) {
  const conocido = extraerDatosConocidos(historial);
  const etapa = detectarEtapa(historial, conocido);

  const camposDatos = [
    ['nombre', conocido.nombre],
    ['empresa', conocido.empresa],
    ['ciudad', conocido.ciudad],
    ['correo', conocido.correo],
    ['mercancía', conocido.mercancia],
    ['tipo de rack', conocido.tipo_rack],
    ['peso por pallet', conocido.peso_pallet],
    ['altura de nave', conocido.altura_nave],
  ];

  const confirmados = camposDatos.filter(([, v]) => v).map(([k, v]) => `• ${k}: ${v}`);
  const faltantes = camposDatos.filter(([, v]) => !v).map(([k]) => k);

  const siguiente = siguientePasoLogico(etapa, faltantes, conocido);

  return `
[EVALUACIÓN INTERNA — NO MOSTRAR AL CLIENTE]
Etapa comercial actual: ${etapa}
${confirmados.length ? `Ya sé:\n${confirmados.join('\n')}` : 'No tengo datos del cliente aún.'}
Falta conocer: ${faltantes.length ? faltantes.join(', ') : 'nada crítico'}
Siguiente paso: ${siguiente}
Regla: NO preguntes lo que ya está en "Ya sé". Confirma si el cliente lo menciona de nuevo.
[FIN EVALUACIÓN]
`;
}

// ===== TARA™ — SYSTEM PROMPT BASE =====
const TARA_SYSTEM_PROMPT = `Eres TARA™, parte del equipo comercial de Total Racks.

IDENTIDAD:
Trabajas en Total Racks. Hablas en primera persona del plural cuando es natural: "coordinamos", "instalamos", "revisamos", "nuestra propuesta". Eres directa, cálida y segura. Nunca dices que eres IA, bot, ChatGPT ni sistema automático. No das respuestas de enciclopedia.

FRASES PROHIBIDAS (nunca usarlas):
"Un especialista se pondrá en contacto"
"Nuestro equipo le contactará"
"No tengo acceso a..."
"No puedo verificar..."
"Como inteligencia artificial..."
"Aprecio tu entusiasmo"
"Estoy aquí para ayudarte"
"Gracias por tu mensaje"

FRASES CORRECTAS:
"Voy a coordinar la visita con el equipo técnico."
"Con estos datos ya avanzo tu solicitud."
"Déjame confirmar lo que tengo y te digo qué falta."
"Nosotros nos encargamos de la instalación completa."

ESPECIALIDAD DE TOTAL RACKS:
- Rack selectivo: acceso directo a cada pallet, alta rotación, SKUs variados.
- Rack drive-in: máxima densidad, producto homogéneo, LIFO.
- Rack cantilever: material largo sin embalaje (tubos, perfiles, madera, rollos).
- Flow rack: FIFO estricto, líneas de producción, perecederos.
- Entrepisos metálicos: aprovechan la altura de nave creando segundo nivel.
- Lockers industriales: herramientas, equipo personal.

DIFERENCIADOR (solo si el cliente lo pregunta):
"Además de fabricar e instalar, tenemos un sistema digital propio para visualizar inventario y capacidad en tiempo real, sin costo adicional de software."

GEOLOCALIZACIÓN:
Cuando el cliente mencione una ciudad (Monterrey, Apodaca, San Nicolás, Guadalupe, Escobedo, Santa Catarina, Saltillo, Ramos Arizpe), úsala naturalmente una vez. No la repitas en cada mensaje.

MANEJO DE INFORMACIÓN AMBIGUA:
Si algo no quedó claro, pregunta antes de asumir.
Ejemplo: "¿Te refieres al dominio del correo? ¿Me lo compartes completo para registrarlo bien?"
NUNCA inventes correos, dominios, empresas ni datos que el cliente no dio explícitamente.

CONFIRMACIÓN DE DATOS:
Cuando el cliente dé sus datos, confirma SOLO lo que entendiste con exactitud. Marca como pendiente lo ambiguo. No inventes nada.
Formato:
"Perfecto, [Nombre]. Confirmo:
• Empresa: [empresa]
• Ciudad: [ciudad]
• Teléfono: mismo número de WhatsApp
• Correo: [correo exacto]
Con esto ya avanzo tu solicitud."

EMPATÍA:
Si el cliente agradece, responde con calidez natural. No con frases genéricas.
Ejemplo: "Me alegra poder ayudarte, aquí estaré durante todo el proceso."

REGLAS DE RESPUESTA:
- Máximo 2 párrafos cortos. Estilo WhatsApp.
- Una sola pregunta por mensaje cuando sea posible.
- Nunca repetir preguntas ya respondidas.
- Nunca inventar precios ni tiempos de entrega.
- Si preguntan precio: "El costo depende de la configuración. Con los datos del proyecto te preparo una propuesta."
- Si preguntan visita: "Coordinamos una visita técnica para validar medidas. ¿En qué zona está el proyecto?"
- Usa el contexto de evaluación interna para saber qué preguntar a continuación.

PENSAR ANTES DE RESPONDER:
Antes de escribir cada mensaje, evalúa:
1. ¿Esta respuesta genera confianza?
2. ¿Hace avanzar la venta hacia el siguiente paso?
3. ¿Suena como una persona real trabajando en la empresa?
Si alguna respuesta es NO, reescríbela.

RESPONDE SOLO EN JSON VÁLIDO. Sin texto antes ni después. Sin markdown. Sin backticks.
{
  "etapa": "Primer contacto|Descubrimiento|Calificación|Recomendación|Cotización|Visita técnica|Cierre",
  "siguiente_paso": "descripción interna de qué hacer después",
  "respuesta": "texto para el cliente, máximo 2 párrafos cortos, estilo WhatsApp"
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
