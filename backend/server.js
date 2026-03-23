const express  = require("express");
const cors     = require("cors");
const fetch    = require("node-fetch");
require("dotenv").config();

// ─── libphonenumber ──────────────────────────────────────────────────────────
const { PhoneNumberUtil, PhoneNumberFormat, PhoneNumberType } = require("google-libphonenumber");
const phoneUtil = PhoneNumberUtil.getInstance();

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ status: "LibphoneX API Gateway 🚀", version: "2.3", author: "Maicon Cubero" });
});

// ─── Mapa de nomes de países (fallback para Intl.DisplayNames) ────────────────
// Usado quando o Node não suporta pt-BR em Intl.DisplayNames
const COUNTRY_NAMES = {
  BR:"Brasil",US:"Estados Unidos",AR:"Argentina",CL:"Chile",CO:"Colômbia",
  PE:"Peru",UY:"Uruguai",PY:"Paraguai",BO:"Bolívia",EC:"Equador",VE:"Venezuela",
  MX:"México",PT:"Portugal",ES:"Espanha",FR:"França",DE:"Alemanha",IT:"Itália",
  GB:"Reino Unido",NL:"Países Baixos",BE:"Bélgica",CH:"Suíça",AT:"Áustria",
  SE:"Suécia",NO:"Noruega",DK:"Dinamarca",FI:"Finlândia",PL:"Polônia",
  RU:"Rússia",CN:"China",JP:"Japão",KR:"Coreia do Sul",IN:"Índia",
  AU:"Austrália",NZ:"Nova Zelândia",ZA:"África do Sul",NG:"Nigéria",
  EG:"Egito",MA:"Marrocos",KE:"Quênia",IL:"Israel",TR:"Turquia",
  SA:"Arábia Saudita",AE:"Emirados Árabes",IR:"Irã",PK:"Paquistão",
  ID:"Indonésia",MY:"Malásia",SG:"Singapura",TH:"Tailândia",PH:"Filipinas",
  HK:"Hong Kong",TW:"Taiwan",MO:"Macau",CA:"Canadá",CU:"Cuba",
  GT:"Guatemala",SV:"El Salvador",HN:"Honduras",NI:"Nicarágua",
  CR:"Costa Rica",PA:"Panamá",DO:"República Dominicana",
  RO:"Romênia",HU:"Hungria",GR:"Grécia",CZ:"República Tcheca",
  SK:"Eslováquia",HR:"Croácia",RS:"Sérvia",UA:"Ucrânia",LT:"Lituânia",
  LV:"Letônia",EE:"Estônia",LU:"Luxemburgo",IE:"Irlanda",IS:"Islândia",
  BG:"Bulgária",DZ:"Argélia",TN:"Tunísia",LY:"Líbia",GM:"Gâmbia",
  SN:"Senegal",MM:"Mianmar",LK:"Sri Lanka",AF:"Afeganistão",
};

function getCountryName(regionCode) {
  if (!regionCode) return "Desconhecido";
  try {
    const names = new Intl.DisplayNames(["pt-BR"], { type: "region" });
    const name  = names.of(regionCode);
    // Às vezes retorna o próprio código quando não tem tradução
    if (name && name !== regionCode) return name;
  } catch (_) { /* Intl não disponível ou sem suporte pt-BR */ }
  return COUNTRY_NAMES[regionCode] || regionCode;
}

// ─── libphonenumber: análise principal ───────────────────────────────────────

function analyzeWithLibphone(rawPhone) {
  try {
    const hint   = rawPhone.startsWith("+") ? undefined : "BR";
    const parsed = phoneUtil.parse(rawPhone, hint);

    const valid       = phoneUtil.isValidNumber(parsed);
    const region      = phoneUtil.getRegionCodeForNumber(parsed);
    const countryCode = parsed.getCountryCode();
    const numType     = phoneUtil.getNumberType(parsed);

    const typeMap = {
      [PhoneNumberType.MOBILE]:               "mobile",
      [PhoneNumberType.FIXED_LINE]:           "landline",
      [PhoneNumberType.FIXED_LINE_OR_MOBILE]: "mobile",
      [PhoneNumberType.VOIP]:                 "voip",
      [PhoneNumberType.TOLL_FREE]:            "landline",
      [PhoneNumberType.PREMIUM_RATE]:         "landline",
      [PhoneNumberType.SHARED_COST]:          "landline",
      [PhoneNumberType.PERSONAL_NUMBER]:      "mobile",
      [PhoneNumberType.PAGER]:                "mobile",
      [PhoneNumberType.UAN]:                  "landline",
      [PhoneNumberType.VOICEMAIL]:            "voip",
      [PhoneNumberType.UNKNOWN]:              "unknown",
    };

    return {
      valid,
      type:    typeMap[numType] ?? "unknown",
      format: {
        international: phoneUtil.format(parsed, PhoneNumberFormat.INTERNATIONAL),
        local:         phoneUtil.format(parsed, PhoneNumberFormat.NATIONAL),
        e164:          phoneUtil.format(parsed, PhoneNumberFormat.E164),
      },
      country: {
        code:   region        || null,
        name:   getCountryName(region),
        prefix: countryCode   || null,
      },
      carrier:  null,
      _source:  "libphonenumber",
    };

  } catch (err) {
    console.warn("[libphone] Parse error:", err.message);
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

function normalizePhoneQuery(rawPhone) {
  if (rawPhone == null) return "";

  const original = String(rawPhone);
  const trimmed  = original.trim();

  if (/^00\d/.test(trimmed)) {
    return `+${trimmed.slice(2)}`;
  }

  // Requisições manuais como ?phone=+5511... chegam ao Express com o "+"
  // convertido em espaço. Se detectarmos esse caso, restauramos o prefixo.
  if (/^\d{8,15}$/.test(trimmed) && /^\s+\d/.test(original)) {
    return `+${trimmed}`;
  }

  return trimmed;
}

// ─── Abstract: busca operadora ───────────────────────────────────────────────
//
//
// A chave do Abstract fica somente no backend/proxy (Render), evitando expor
// o segredo no frontend hospedado no GitHub Pages.
// Env var: ABSTRACT_API_KEY
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCarrierFromAbstract(e164Phone) {
  const key = process.env.ABSTRACT_API_KEY;
  if (!key) {
       console.log("[Abstract] ABSTRACT_API_KEY não configurada — pulando.");
    return {
      carrier: null,
      status:  "missing_api_key",
      detail:  "ABSTRACT_API_KEY não configurada no backend.",
    };
  }
  const normalizedPhone = e164Phone.replace(/\D/g, "");
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 7000);
   const url        = `https://phonevalidation.abstractapi.com/v1/?api_key=${encodeURIComponent(key)}&phone=${encodeURIComponent(normalizedPhone)}`;
   const url        = `https://phonevalidation.abstractapi.com/v1/?api_key=${encodeURIComponent(key)}&phone=${encodeURIComponent(e164Phone)}`;

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[Abstract] HTTP ${res.status}`);
      return {
        carrier: null,
        status:  "http_error",
        detail:  `HTTP ${res.status}`,
      };
    }

    const data = await res.json();

    if (data.error) {
      console.warn("[Abstract] Erro da API:", data.error?.message || data.error);
      return {
        carrier: null,
        status:  "api_error",
        detail:  data.error?.message || String(data.error),
      };
    }
    // O Abstract já retornou carrier em formatos diferentes ao longo do tempo:
    // mantemos compatibilidade com payloads novos (phone_carrier.name)
    // e legados (carrier).
    const carrierName =
      data.phone_carrier?.name ||
      data.carrier ||
      null;

    if (carrierName && carrierName.trim() !== "") {
      return {
        carrier: carrierName.trim(),
        status:  "ok",
        detail:  null,
      };
    }

    return {
      carrier: null,
      status:  "no_carrier_returned",
      detail:  "Abstract respondeu sem preencher o campo de operadora.",
    };

  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
         console.warn("[Abstract] Timeout após 7s");
      return {
        carrier: null,
        status:  "timeout",
        detail:  "Timeout após 7s",
      };
    } else {
         console.warn("[Abstract] Erro de rede:", err.message);
      return {
        carrier: null,
        status:  "network_error",
        detail:  err.message,
      };
    }
    return null;
  }
}

// ─── Guia de discagem internacional ──────────────────────────────────────────

function buildDialingGuide(libData, rawPhone) {
  if (!libData?.country?.code || libData.country.code === "BR") return null;

  const ddi = libData.country.prefix;
  if (!ddi) return null;

  const ddiStr = String(ddi);
  let digits   = (libData.format?.e164 || rawPhone).replace(/\D/g, "");
  if (digits.startsWith(ddiStr)) digits = digits.slice(ddiStr.length);

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
    internationalFormat: libData.format?.international || `+${ddiStr}${digits}`,
    dialingOptions: carriers.map((c) => ({
      carrier:     c.sigla,
      carrierCode: c.code,
      dialString:  `0${c.code}+${ddiStr}${digits}`,
    })),
    note: "No Brasil, a discagem internacional usa 0 + código da operadora de longa distância + DDI + número. Planos corporativos podem ter CSP fixo na central — consulte o administrador.",
  };
}

// ─── Troubleshooting hints ────────────────────────────────────────────────────

function generateTroubleshootingHints(data, rawInput) {
  const hints = [];

  if (data._parseError) {
    hints.push({
      severity:   "error",
      code:       "PARSE_ERROR",
      message:    "Não foi possível interpretar o número.",
      suggestion: `Detalhe: ${data._parseError}. Inclua o DDI completo com + (ex: +55 11 9...).`,
    });
    return hints; // Não adianta continuar se não parseou
  }

  if (!data.valid) {
    hints.push({
      severity:   "error",
      code:       "INVALID_NUMBER",
      message:    "Número inválido segundo libphonenumber.",
      suggestion: "Celulares BR: 11 dígitos com 9 (ex: +55 11 91234-5678). Fixos: 10 dígitos.",
    });
  }

  if (!rawInput.startsWith("+")) {
    hints.push({
      severity:   "warning",
      code:       "MISSING_PLUS_PREFIX",
      message:    "O número não começa com '+'.",
      suggestion: "Use + seguido do DDI (ex: +55 para Brasil, +1 para EUA).",
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
      suggestion: "Rotas VoIP puras podem falhar para fixos. Verifique suporte PSTN na rota.",
    });
  }

  if (data.format?.international && data.format.international !== rawInput.replace(/\s/g, "")) {
    hints.push({
      severity:   "info",
      code:       "FORMAT_MISMATCH",
      message:    "Formato digitado difere do padrão E.164.",
      suggestion: `Use: ${data.format.international}`,
    });
  }

  const restricted = ["CN", "RU", "IR", "CU", "KP"];
  if (data.country?.code && restricted.includes(data.country.code)) {
    hints.push({
      severity:   "warning",
      code:       "RESTRICTED_COUNTRY",
      message:    `${data.country.name} pode ter restrições de roteamento internacional.`,
      suggestion: "Verifique se a rota possui acordo de interconexão com operadoras locais.",
    });
  }

  if (!data.carrier) {
        const carrierStatus = data.carrierLookupStatus || "no_carrier_returned";
    const carrierDetail = data.carrierLookupDetail ? ` Detalhe: ${data.carrierLookupDetail}.` : "";

    const statusMap = {
      missing_api_key: {
        message:    "Operadora não consultada: chave do Abstract ausente.",
        suggestion: "Configure ABSTRACT_API_KEY no Render para habilitar a busca de operadora.",
      },
      http_error: {
        message:    "Falha HTTP ao consultar a operadora no Abstract.",
        suggestion: `Verifique a conectividade do Render e a resposta da API do Abstract.${carrierDetail}`,
      },
      api_error: {
        message:    "Abstract recusou ou rejeitou a consulta da operadora.",
        suggestion: `Verifique a validade da chave, cota da conta e parâmetros enviados.${carrierDetail}`,
      },
      timeout: {
        message:    "Consulta da operadora expirou no Abstract.",
        suggestion: `Tente novamente e valide a latência de saída do Render.${carrierDetail}`,
      },
      network_error: {
        message:    "Erro de rede ao consultar a operadora no Abstract.",
        suggestion: `Verifique DNS/egress do Render para o domínio do Abstract.${carrierDetail}`,
      },
      no_carrier_returned: {
        message:    "Operadora não identificada via Abstract.",
        suggestion: `O número foi validado, mas o Abstract não retornou carrier para ele.${carrierDetail}`,
      },
    };

    const fallback = statusMap[carrierStatus] || statusMap.no_carrier_returned;
    hints.push({
      severity:   "info",
      code:       "CARRIER_UNKNOWN",
      message:    fallback.message,
      suggestion: fallback.suggestion,
    });
  }

  if (hints.length === 0 || hints.every((h) => h.severity === "info")) {
    hints.push({
      severity:   "success",
      code:       "ALL_CLEAR",
      message:    "Número válido e sem anomalias detectadas.",
      suggestion: "Se ainda houver falha de discagem, verifique o CDR na plataforma.",
    });
  }

  return hints;
}

// ─── Endpoint principal ───────────────────────────────────────────────────────

  const rawPhone = req.query.phone;
  const phone    = normalizePhoneQuery(rawPhone);;
  if (!phone) {
    return res.status(400).json({ error: "Parâmetro 'phone' é obrigatório." });
  }

  try {
    // 1️⃣ libphonenumber — local, zero latência, zero dependência externa
    const libData = analyzeWithLibphone(phone);
    console.log(`[libphone] ${phone} → valid:${libData.valid} | type:${libData.type} | region:${libData.country?.code} | e164:${libData.format?.e164}`);

    // 2️⃣ Abstract — somente se número válido e E.164 disponível
    let carrierLookupStatus = "not_attempted";
    let carrierLookupDetail = null;

    if (libData.valid && libData.format?.e164) {
      const carrierLookup = await fetchCarrierFromAbstract(libData.format.e164);
      carrier = carrierLookup.carrier;
      carrierLookupStatus = carrierLookup.status;
      carrierLookupDetail = carrierLookup.detail;
      carrierSource = carrier ? "Abstract" : "Abstract (sem retorno)";
      console.log(`[carrier] ${carrierSource}: "${carrier}"`);
    }

    // 3️⃣ Guia de discagem (apenas destinos não-BR)
    const dialingGuide = buildDialingGuide(libData, phone);

    // 4️⃣ Hints de troubleshooting
      const troubleshooting = generateTroubleshootingHints({
      ...libData,
      carrier,
      carrierLookupStatus,
      carrierLookupDetail,
    }, phone);

    return res.json({
      valid:   libData.valid,
      type:    libData.type,
      format:  libData.format,
      country: libData.country,
      carrier: carrier || "Desconhecida",
      dialingGuide,
      troubleshooting,
      _meta: {
        author:        "Maicon Cubero",
        version:       "2.3",
        phoneSource:   "libphonenumber",
        carrierSource,
                carrierLookupStatus,
        carrierLookupDetail,
        normalizedQueryPhone: phone,
      },
    });

  } catch (err) {
    console.error("[/api/validate] Erro inesperado:", err);
    return res.status(500).json({ error: "Erro interno no servidor.", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`LibphoneX v2.3 · porta ${PORT} · by Maicon Cubero`);
});
