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

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: { 'Accept-Encoding': 'identity' },
});

// Email
const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ===== BASE DE DATOS EN MEMORIA =====
const proyectos = new Map();
const cotizaciones = new Map();

// Historial de conversaciones por cliente (últimos 10 mensajes)
const conversaciones = new Map();

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
    const posiciones = this.calcularPosiciones();
    const costoPorPosicion = 1560;
    return posiciones * costoPorPosicion;
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

// ===== TARA™ — SYSTEM PROMPT =====
const TARA_SYSTEM_PROMPT = `Eres TARA™, asesora comercial y operativa de Total Racks, empresa especializada en racks industriales y sistemas de almacenaje en el noreste de México.

IDENTIDAD:
Hablas como una persona real con experiencia en almacenamiento industrial y ventas técnicas. Eres directa, cálida, consultiva y segura. Nunca dices que eres una IA, un chatbot, ChatGPT ni modelo de lenguaje. No suenas robótica. No das respuestas de enciclopedia.

ESPECIALIDAD DE TOTAL RACKS:
- Rack selectivo: acceso directo a cada pallet, alta rotación, SKUs variados.
- Rack drive-in: máxima densidad, producto homogéneo, LIFO.
- Rack cantilever: material largo sin embalaje (tubos, perfiles, madera, rollos).
- Flow rack / rack dinámico: FIFO estricto, líneas de producción, perecederos.
- Entrepisos metálicos: aprovechan la altura de la nave creando un segundo nivel.
- Lockers industriales: herramientas, equipo personal, valuables.

DIFERENCIADOR (solo mencionarlo cuando el cliente pregunte o sea relevante):
"Además de fabricar e instalar racks, nuestro plus es que podemos integrar un sistema digital propio para que tengas visibilidad de capacidad e inventario en tiempo real, sin pagar software adicional."

CLIENTE IDEAL: empresas con bodega (500 m² o más), gerentes de operaciones, logística, compras o almacén, ubicadas en Nuevo León, Monterrey, zona metropolitana, Saltillo o Ramos Arizpe.

GEOLOCALIZACIÓN:
Si el cliente menciona una ciudad o zona, úsala naturalmente en la respuesta.
Ejemplos: Monterrey, San Nicolás, Apodaca, Guadalupe, Escobedo, Santa Catarina, Saltillo, Ramos Arizpe.
Ejemplo: "Perfecto, si el proyecto está en Apodaca podemos coordinar una visita técnica dentro de la zona metropolitana."

PROCESO COMERCIAL — en este orden:
1. Entender qué necesita el cliente (nunca vender antes de entender).
2. Recopilar datos técnicos de forma natural (UNO O DOS POR MENSAJE):
   - Qué mercancía almacena
   - Peso por pallet o carga
   - Medidas del producto o tarima
   - Altura libre de la nave
   - Dimensiones del almacén (largo x ancho)
   - Cantidad de posiciones estimadas
   - Ciudad / ubicación
   - Urgencia del proyecto
3. Recomendar el sistema con justificación técnica concreta.
4. Avanzar hacia: cotización formal, visita técnica o llamada con un especialista.
5. Si ya tiene suficiente información, pedir datos de contacto:
   - Nombre completo
   - Empresa
   - Correo electrónico
   - Teléfono

REGLAS CRÍTICAS:
- Máximo 4 párrafos cortos por respuesta. Estilo WhatsApp natural.
- Máximo UNA o DOS preguntas por mensaje. No hagas listas de 7 preguntas.
- Nunca repitas preguntas que ya fueron respondidas en el historial.
- Cuando tengas suficiente información, da la recomendación. No sigas pidiendo más datos.
- Nunca inventes precios ni tiempos exactos de entrega.
- Si preguntan precio: "El costo depende de la configuración. Con los datos del proyecto puedo preparar una propuesta formal."
- Si preguntan visita técnica: "Sí, podemos coordinar una visita para validar medidas y necesidades. Normalmente se revisa según ubicación y alcance del proyecto."
- Si el cliente dice algo emocional o informal, responder con naturalidad y humor ligero si aplica.
- No decir: "Aprecio tu entusiasmo", "Estoy aquí para ayudarte", "Gracias por tu mensaje", "Como IA...", "Depende." sin explicar.
- Siempre busca avanzar al siguiente paso comercial.

RESPONDE SOLO EN JSON VÁLIDO. Sin texto antes ni después. Sin markdown. Sin backticks.
{
  "respuesta": "tu respuesta natural aquí, estilo WhatsApp, máximo 4 párrafos cortos"
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

  // Si OpenAI respondió texto plano, usarlo directamente
  const texto = contenido.trim();
  if (texto.length > 5) return { respuesta: texto };

  return { respuesta: '¿En qué puedo ayudarte con tu proyecto?' };
}

// ===== GESTIÓN DE HISTORIAL =====
function agregarAlHistorial(clienteId, role, contenido) {
  if (!conversaciones.has(clienteId)) {
    conversaciones.set(clienteId, []);
  }
  const historial = conversaciones.get(clienteId);
  historial.push({ role, content: contenido });
  // Mantener solo los últimos 10 intercambios (20 mensajes)
  if (historial.length > 20) historial.splice(0, historial.length - 20);
}

function obtenerHistorial(clienteId) {
  return conversaciones.get(clienteId) || [];
}

// ===== TARA™ — GENERAR RESPUESTA CON OPENAI =====
async function generarRespuestaTara(clienteId, mensajeCliente) {
  try {
    const historial = obtenerHistorial(clienteId);

    const mensajes = [
      { role: 'system', content: TARA_SYSTEM_PROMPT },
      ...historial,
      { role: 'user', content: mensajeCliente },
    ];

    console.log(`📤 OpenAI [${clienteId}]: historial=${historial.length / 2} turns`);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: mensajes,
      temperature: 0.65,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    });

    const crudo = response.choices[0].message.content.trim();
    console.log(`📥 OpenAI raw: ${crudo.substring(0, 150)}`);

    const parsed = safeParseJSON(crudo);
    const respuesta = parsed.respuesta || '¿En qué puedo ayudarte con tu proyecto?';

    // Guardar en historial
    agregarAlHistorial(clienteId, 'user', mensajeCliente);
    agregarAlHistorial(clienteId, 'assistant', respuesta);

    console.log(`✅ TARA responde a ${clienteId}: ${respuesta.substring(0, 80)}...`);
    return respuesta;
  } catch (error) {
    console.error('❌ Error OpenAI:', error.message);
    return '¿En qué puedo ayudarte con tu proyecto de almacenamiento?';
  }
}

// ===== WEBHOOK META — VERIFICACIÓN =====
app.get('/webhook', (req, res) => {
  const verify_token = process.env.WEBHOOK_VERIFY_TOKEN;
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (token === verify_token) {
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
    proyectos.set(proyecto.id, {
      ...proyecto.toJSON(),
      cliente_nombre,
      cliente_email,
      cliente_telefono,
    });

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
      `✅ Recibimos tu proyecto.\n\nNuestro equipo está revisando:\n• ${datosProyecto.tipo_sistema}\n• ${proyecto.calcularPosiciones()} posiciones\n\nPronto te contactamos para el siguiente paso.`
    );

    res.json({
      success: true,
      proyecto_id: proyecto.id,
      posiciones: proyecto.calcularPosiciones(),
      costo_total: proyecto.calcularCosto(),
    });
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
      `🎉 ¡Tu proyecto está listo!\n\n📅 Cita confirmada:\n${fecha} a las ${hora}\n👤 Con: Alina Navarro\n\n¿Preguntas? Aquí estamos.`
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
app.use(require('express').static('public'));

app.get('/dashboard', (req, res) => {
  res.sendFile(__dirname + '/dashboard_vendedor.html');
});

app.get('/generador-pdf', (req, res) => {
  res.sendFile(__dirname + '/generador_cotizacion_pdf.html');
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', bot: 'TARA™', timestamp: new Date().toISOString() });
});

// ===== INICIAR SERVIDOR =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║   TARA™ — TOTAL RACKS BOT                 ║
║   ✓ Puerto: ${PORT}                           ║
║   ✓ Webhook: POST /webhook                ║
║   ✓ Dashboard: GET /dashboard             ║
║   ✓ Generador PDF: GET /generador-pdf     ║
╚════════════════════════════════════════════╝
  `);
});

module.exports = app;
