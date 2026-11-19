/**
 * Funcion serverless (Vercel): sube la imagen de un evento y su metadata a IPFS con Pinata.
 * El JWT de Pinata vive en una variable de entorno, NUNCA en el navegador.
 *
 * POST /api/upload  { name, description, image: "data:image/...;base64,...", message, signature }
 * -> { uri: "ipfs://<cid de la metadata>", image: "ipfs://<cid de la imagen>" }
 *
 * Para que nadie mas gaste tu cuenta de Pinata, la peticion va firmada con MetaMask y solo se
 * aceptan las cuentas de ADMIN_ADDRESSES (separadas por coma).
 */
const { verifyMessage } = require("ethers");

const PINATA = "https://api.pinata.cloud/pinning";
const MAX_BYTES = 3 * 1024 * 1024; // Vercel acepta hasta 4.5 MB por peticion
const VIGENCIA_MS = 10 * 60 * 1000;

async function pinata(endpoint, body, jwt) {
  const res = await fetch(`${PINATA}/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) },
    body,
  });
  if (!res.ok) throw new Error(`Pinata respondio ${res.status}: ${await res.text()}`);
  return (await res.json()).IpfsHash;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Usa POST" });

  const jwt = (process.env.PINATA_JWT || "").trim().replace(/^["']|["']$/g, "");
  // Acepta direcciones separadas por coma, punto y coma, espacios o saltos de linea, con o sin comillas
  const admins = ((process.env.ADMIN_ADDRESSES || "").toLowerCase().match(/0x[0-9a-f]{40}/g) || []);
  if (!jwt || admins.length === 0) {
    return res.status(500).json({ error: "Falta configurar PINATA_JWT o ADMIN_ADDRESSES en Vercel (Settings > Environment Variables) y hacer Redeploy" });
  }

  try {
    const { name = "", description = "", image = "", message = "", signature = "" } = req.body || {};

    // 1. Quien firma? El mensaje lleva la hora para que una firma vieja no se reutilice
    const firmante = verifyMessage(message, signature).toLowerCase();
    if (!admins.includes(firmante)) {
      return res.status(403).json({
        error: `La cuenta ${firmante} no esta en ADMIN_ADDRESSES (hay ${admins.length} configurada${admins.length === 1 ? "" : "s"}). ` +
          "Agregala en Vercel > Settings > Environment Variables y haz Redeploy.",
      });
    }
    const hora = Number((message.match(/(\d{13})$/) || [])[1]);
    if (!message.startsWith("BoletoTEC: subir imagen ") || !hora || Math.abs(Date.now() - hora) > VIGENCIA_MS) {
      return res.status(400).json({ error: "Firma vencida, intenta de nuevo" });
    }

    // 2. Imagen (data URL) -> archivo
    const m = image.match(/^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/);
    if (!m) return res.status(400).json({ error: "Imagen invalida (png, jpg, webp o gif)" });
    const bytes = Buffer.from(m[3], "base64");
    if (bytes.length > MAX_BYTES) return res.status(413).json({ error: "Imagen mayor a 3 MB" });

    const form = new FormData();
    form.append("file", new Blob([bytes], { type: m[1] }), `evento.${m[2] === "jpeg" ? "jpg" : m[2]}`);
    form.append("pinataMetadata", JSON.stringify({ name: `BoletoTEC imagen: ${name}`.slice(0, 90) }));
    const imageCid = await pinata("pinFileToIPFS", form, jwt);

    // 3. Metadata estilo ERC-721 (la usan todos los boletos del evento)
    const metadata = { name, description, image: `ipfs://${imageCid}` };
    const metaCid = await pinata(
      "pinJSONToIPFS",
      JSON.stringify({ pinataContent: metadata, pinataMetadata: { name: `BoletoTEC: ${name}`.slice(0, 90) } }),
      jwt
    );

    return res.status(200).json({ uri: `ipfs://${metaCid}`, image: `ipfs://${imageCid}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
