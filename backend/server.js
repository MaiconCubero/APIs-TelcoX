const express  = require("express");
const cors     = require("cors");
const fetch    = require("node-fetch");
require("dotenv").config();

// ─── libphonenumber setup ────────────────────────────────────────────────────
const { PhoneNumberUtil, PhoneNumberFormat, PhoneNumberType } = require("google-libphonenumber");
const phoneUtil = PhoneNumberUtil.getInstance();

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "LibphoneX API Gateway 🚀", version: "2.2", author: "Maicon Cubero" });
});

// ─── libphonenumber helpers ───────────────────────────────────────────────────

/**
 * Analisa um número via google-libphonenumber e devolve um objeto
 * compatível com o formato que o frontend já espera (mesmo shape da AbstractAPI).
 */
function analyzeWithLibphone(rawPhone) {
  try {
    // Tenta parsear com região BR como hint se não tiver +
    const hint  = rawPhone.startsWith("+") ? undefined : "BR";
    const parsed = phoneUtil.parse(rawPhone, hint);

    const valid      = phoneUtil.isValidNumber(parsed);
    const region     = phoneUtil.getRegionCodeForNumber(parsed);
    const countryCode = parsed.getCountryCode();
    const numType    = phoneUtil.getNumberType(parsed);

    // Mapeia PhoneNumberType → string igual à AbstractAPI
    const typeMap = {
      [PhoneNumberType.MOBILE]:           "mobile",
      [PhoneNumberType.FIXED_LINE]:       "landline",
      [PhoneNumberType.FIXED_LINE_OR_MOBILE]: "mobile",
      [PhoneNumberType.VOIP]:             "voip",
      [PhoneNumberType.TOLL_FREE]:        "landline",
      [PhoneNumberType.PREMIUM_RATE]:     "landline",
      [PhoneNumberType.SHARED_COST]:      "landline",
      [PhoneNumberType.PERSONAL_NUMBER]:  "mobile",
      [PhoneNumberType.PAGER]:            "mobile",
      [PhoneNumberType.UAN]:              "landline",
      [PhoneNumberType.VOICEMAIL]:        "voip",
      [PhoneNumberType.UNKNOWN]:          "unknown",
    };

    const type = typeMap[numType] ?? "unknown";

    const intlFormat   = phoneUtil.format(parsed, PhoneNumberFormat.INTERNATIONAL);
    const localFormat  = phoneUtil.format(parsed, PhoneNumberFormat.NATIONAL);
    const e164Format   = phoneUtil.format(parsed, PhoneNumberFormat.E164);

    // Nome do país a partir da região
    const regionNames = new Intl.DisplayNames(["pt-BR"], { type: "region" });
    const countryName = region ? (regionNames.of(region) || region) : "Desconhecido";

    return {
      valid,
      type,
      format: {
        international: intlFormat,
        local:         localFormat,
        e164:          e164Format,
      },
      country: {
        code:   region     || null,
        name:   countryName,
        prefix: countryCode || null,
      },
      carrier:  null,   // libphonenumber não tem dados de operadora
      _source:  "libphonenumber",
    };
  } catch (err) {
    // Número não parseável
    return {
      valid:   false,
      type:    "unknown",
      format:  { international: null, local: null, e164: null },
      country: { code: null, name: null, prefix: null },
      carrier: null,
      _source: "libphonenumber",
      _parseError: err.message,
    };
  }
}

// ─── Numverify (carrier fallback) ─────────────────────────────────────────────

/**
 * Consulta Numverify apenas para obter a operadora.
 * Endpoint: http://apilayer.net/api/validate (free tier usa HTTP)
 * Env var:  NUMVERIFY_API_KEY
 */
async function fetchCarrierFromNumverify(e164Phone) {
  const key = process.env.NUMVERIFY_API_KEY;
  if (!key) return null;

  try {
    // Numverify aceita o número sem o +
    const number = e164Phone.replace("+", "");
    const url    = `https://apilayer.net/api/validate?access_key=${key}&number=${encodeURIComponent(number)}&format=1`;

    const res  = await fetch(url, { timeout: 6000 });
    if (!res.ok) return null;

    const data = await res.json();

    // data.carrier é a string da operadora; data.success falso = chave inválida
    if (data.success === false) {
      console.warn("[Numverify] API retornou erro:", data.error?.info);
      return null;
    }

    return data.carrier || null;
  } catch (err) {
    console.warn("[Numverify] Falha:", err.message);
    return null;
  }
}

// ─── Dialing guide ────────────────────────────────────────────────────────────

function buildDialingGuide(libData, rawPhone) {
  // Só mostra se o destino NÃO for Brasil
  if (!libData?.country?.code || libData.country.code === "BR") return null;

  const ddi = libData.country.prefix;
  if (!ddi) return null;

  const ddiStr = String(ddi);
  // Pega número sem DDI e sem +
  let digits = (libData.format?.e164 || rawPhone).replace(/\D/g, "");
  if (digits.startsWith(ddiStr)) digits = digits.slice(ddiStr.length);

  const intlFormat = libData.format?.international || `+${ddiStr}${digits}`;

  const carriers = [
    { sigla: "Embratel", code: "14" },
    { sigla: "Claro",    code: "21" },
    { sigla: "TIM",      code: "41" },
    { sigla: "Vivo",     code: "15" },
    { sigla: "Oi",       code: "31" },
  ];

  return {
    destinationCountry:  libData.country.name,
    destinationDDI:      ddiStr,
    destinationNumber:   digits,
    internationalFormat: intlFormat,
    dialingOptions: carriers.map((c) => ({
      carrier:     c.sigla,
      carrierCode: c.code,
      dialString:  `0${c.code}+${ddiStr}${digits}`,
      description: `Discar via ${c.sigla} (operadora ${c.code})`,
    })),
    note: "No Brasil, a discagem internacional usa 0 + código da operadora de longa distância + DDI + número. Planos corporativos podem ter CSP fixo na central — consulte o administrador.",
  };
}

// ─── Troubleshooting hints ────────────────────────────────────────────────────

function generateTroubleshootingHints(data, rawInput) {
  const hints = [];

  if (!data.valid) {
    hints.push({
      severity:   "error",
      code:       "INVALID_NUMBER",
      message:    "Número inválido segundo a base libphonenumber.",
      suggestion: "Verifique o DDI e a quantidade de dígitos. Celulares BR têm 11 dígitos (com 9), fixos têm 10.",
    });
  }

  if (data._parseError) {
    hints.push({
      severity:   "error",
      code:       "PARSE_ERROR",
      message:    "Não foi possível interpretar o número.",
      suggestion: `Erro interno: ${data._parseError}. Tente incluir o DDI completo com +.`,
    });
  }

  if (!rawInput.startsWith("+")) {
    hints.push({
      severity:   "warning",
      code:       "MISSING_PLUS_PREFIX",
      message:    "O número não começa com '+'.",
      suggestion: "Números internacionais devem iniciar com '+' seguido do DDI (ex: +55 para Brasil).",
    });
  }

  if (data.type === "unknown") {
    hints.push({
      severity:   "warning",
      code:       "UNKNOWN_LINE_TYPE",
      message:    "Tipo de linha desconhecido.",
      suggestion: "Pode ser VoIP não registrado ou número inativo. Confirme com o cliente.",
    });
  }

  if (data.type === "landline") {
    hints.push({
      severity:   "info",
      code:       "LANDLINE_DETECTED",
      message:    "Telefone fixo detectado.",
      suggestion: "Rotas VoIP puras podem falhar para fixos em alguns países. Verifique suporte PSTN.",
    });
  }

  if (data.format?.international && data.format.international !== rawInput.replace(/\s/g, "")) {
    hints.push({
      severity:   "info",
      code:       "FORMAT_MISMATCH",
      message:    "Formato digitado difere do padrão E.164.",
      suggestion: `Use o formato: ${data.format.international}`,
    });
  }

  const restricted = ["CN", "RU", "IR", "CU", "KP"];
  if (data.country?.code && restricted.includes(data.country.code)) {
    hints.push({
      severity:   "warning",
      code:       "RESTRICTED_COUNTRY",
      message:    `País ${data.country.name} pode ter restrições de roteamento internacional.`,
      suggestion: "Verifique se a rota de saída possui acordo de interconexão com operadoras locais.",
    });
  }

  if (!data.carrier) {
    hints.push({
      severity:   "info",
      code:       "CARRIER_UNKNOWN",
      message:    "Operadora não identificada.",
      suggestion: "Numverify não retornou dados de operadora. Consulte o CDR ou plataforma de telefonia.",
    });
  }

  if (hints.length === 0 || hints.every((h) => h.severity === "info")) {
    hints.push({
      severity:   "success",
      code:       "ALL_CLEAR",
      message:    "Número válido e sem anomalias detectadas.",
      suggestion: "Se ainda assim houver falha de discagem, verifique o CDR na plataforma de telefonia.",
    });
  }

  return hints;
}

// ─── Main endpoint ────────────────────────────────────────────────────────────

app.get("/api/validate", async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: "Parâmetro 'phone' é obrigatório." });

  try {
    // 1️⃣ libphonenumber — análise local, zero latência
    const libData = analyzeWithLibphone(phone);
    console.log(`[libphone] ${phone} → valid:${libData.valid} type:${libData.type} region:${libData.country?.code}`);

    // 2️⃣ Numverify — apenas para operadora (fallback se libphone não tiver)
    let carrier      = null;
    let carrierSource = null;

    if (libData.valid && libData.format?.e164) {
      console.log(`[Numverify] Buscando operadora para ${libData.format.e164}...`);
      carrier = await fetchCarrierFromNumverify(libData.format.e164);
      if (carrier) {
        carrierSource = "Numverify";
        console.log(`[Numverify] Operadora: ${carrier}`);
      } else {
        console.log("[Numverify] Sem resultado de operadora.");
      }
    }

    libData.carrier = carrier;

    // 3️⃣ Guia de discagem (destinos não-BR)
    const dialingGuide = buildDialingGuide(libData, phone);

    // 4️⃣ Troubleshooting hints
    const troubleshooting = generateTroubleshootingHints(libData, phone);

    return res.json({
      // Campos principais (shape idêntico ao que o frontend já consume)
      valid:   libData.valid,
      type:    libData.type,
      format:  libData.format,
      country: libData.country,
      carrier: carrier || "Desconhecida",

      // Dados extras
      dialingGuide,
      troubleshooting,

      _meta: {
        author:       "Maicon Cubero",
        version:      "2.2",
        phoneSource:  "libphonenumber",
        carrierSource: carrierSource || (libData.valid ? "Numverify (sem retorno)" : "N/A"),
      },
    });

  } catch (err) {
    console.error("Erro no /api/validate:", err);
    return res.status(500).json({ error: "Erro interno no servidor." });
  }
});

app.listen(PORT, () => {
  console.log(`LibphoneX v2.2 · porta ${PORT} · by Maicon Cubero`);
});
