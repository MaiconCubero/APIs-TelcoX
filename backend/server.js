const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "LibphoneX API Gateway running 🚀", author: "Maicon Cubero" });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeBRNumber(phone) {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length > 11) digits = digits.slice(2);
  return digits; // Ex: "11912345678"
}

function isBrazilianNumber(phone, abstractData) {
  if (abstractData?.country?.code === "BR") return true;
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length > 11) return true;
  if (!phone.startsWith("+") && (digits.length === 10 || digits.length === 11)) return true;
  return false;
}

/**
 * Consulta portabilidade ABR Telecom com estratégia de dois endpoints:
 *
 * 1. POST /consultaHistoricoRecenteCtg  → histórico completo
 *    body: application/x-www-form-urlencoded  →  numero=XXXXXXXXXXX
 *
 * 2. GET /consultaCtg?numero=XXXXXXXXXXX  → situação atual (fallback)
 *
 * O site às vezes retorna HTML quando não há sessão válida (CAPTCHA).
 * Nesse caso logamos o aviso e lançamos erro descritivo.
 */
async function fetchPortability(brNumber) {
  const BASE = "https://consultanumero.abrtelecom.com.br/consultanumero/consulta";

  const commonHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    Origin: "https://consultanumero.abrtelecom.com.br",
    Referer: "https://consultanumero.abrtelecom.com.br/",
  };

  // ── Endpoint 1: POST histórico ──────────────────────────────────────────────
  let histStatus = null;
  try {
    const histRes = await fetch(`${BASE}/consultaHistoricoRecenteCtg`, {
      method: "POST",
      headers: {
        ...commonHeaders,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: `numero=${encodeURIComponent(brNumber)}`,
    });
    histStatus = histRes.status;

    if (histRes.ok) {
      const text = await histRes.text();
      const trimmed = text.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        return JSON.parse(trimmed);
      }
      // HTML retornado = CAPTCHA ou manutenção
      console.warn("[ABR] Endpoint histórico retornou HTML (provável CAPTCHA/manutenção)");
    }
  } catch (e) {
    console.warn("[ABR] Erro no endpoint histórico:", e.message);
  }

  // ── Endpoint 2: GET situação atual ─────────────────────────────────────────
  let ctgStatus = null;
  try {
    const ctgRes = await fetch(
      `${BASE}/consultaCtg?numero=${encodeURIComponent(brNumber)}`,
      { method: "GET", headers: commonHeaders }
    );
    ctgStatus = ctgRes.status;

    if (ctgRes.ok) {
      const text = await ctgRes.text();
      const trimmed = text.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        const parsed = JSON.parse(trimmed);
        // Normaliza para o formato esperado pelo parser
        return Array.isArray(parsed)
          ? { prestadoraAtual: parsed[0] || null, historicoPortabilidade: [] }
          : parsed;
      }
    }
  } catch (e) {
    console.warn("[ABR] Erro no endpoint situação atual:", e.message);
  }

  throw new Error(
    `ABR Telecom indisponível (hist:${histStatus ?? "err"} / ctg:${ctgStatus ?? "err"}). ` +
      "O serviço pode estar em manutenção ou exigindo CAPTCHA."
  );
}

function parsePortabilityResponse(raw) {
  if (!raw) return null;

  const current =
    raw.prestadoraAtual || raw.operadoraAtual || raw.prestadora || null;

  const history =
    raw.historicoPortabilidade || raw.historico || raw.portabilidades || [];

  return {
    currentCarrier: current
      ? {
          name:  current.nome || current.nomeFantasia || current.sigla || "—",
          cnpj:  current.cnpj  || null,
          sigla: current.sigla || null,
        }
      : null,
    portabilityHistory: Array.isArray(history)
      ? history.map((h) => ({
          date: h.dataPortabilidade || h.data || h.dtPortabilidade || "—",
          from: {
            name:  (h.prestadoraOrigem  || h.operadoraOrigem  || {}).nome  || (h.prestadoraOrigem  || h.operadoraOrigem  || {}).sigla || "—",
            sigla: (h.prestadoraOrigem  || h.operadoraOrigem  || {}).sigla || null,
          },
          to: {
            name:  (h.prestadoraDestino || h.operadoraDestino || {}).nome  || (h.prestadoraDestino || h.operadoraDestino || {}).sigla || "—",
            sigla: (h.prestadoraDestino || h.operadoraDestino || {}).sigla || null,
          },
        }))
      : [],
    rawResponse: raw,
  };
}

// ─── Dialing guide ────────────────────────────────────────────────────────────

function buildDialingGuide(abstractData, rawPhone) {
  if (!abstractData?.country?.code || abstractData.country.code === "BR") return null;

  const ddi = abstractData.country.prefix || abstractData.country.calling_code || null;
  if (!ddi) return null;

  let digits = rawPhone.replace(/\D/g, "");
  const ddiStr = String(ddi);
  if (digits.startsWith(ddiStr)) digits = digits.slice(ddiStr.length);

  const intlFormat = abstractData.format?.international || `+${ddi}${digits}`;

  const carriers = [
    { sigla: "Embratel", code: "14" },
    { sigla: "Claro",    code: "21" },
    { sigla: "TIM",      code: "41" },
    { sigla: "Vivo",     code: "15" },
    { sigla: "Oi",       code: "31" },
  ];

  return {
    destinationCountry:  abstractData.country.name,
    destinationDDI:      ddiStr,
    destinationNumber:   digits,
    internationalFormat: intlFormat,
    dialingOptions: carriers.map((c) => ({
      carrier:     c.sigla,
      carrierCode: c.code,
      dialString:  `0${c.code}+${ddiStr}${digits}`,
      description: `Discar via ${c.sigla} (operadora ${c.code})`,
    })),
    note: "No Brasil, a discagem internacional usa o prefixo 0 + código da operadora de longa distância + DDI + número. Planos corporativos podem ter CSP fixo — consulte o administrador.",
  };
}

// ─── Troubleshooting hints ────────────────────────────────────────────────────

function generateTroubleshootingHints(data, rawInput, portability) {
  const hints = [];

  if (!data.valid) {
    hints.push({
      severity:   "error",
      code:       "INVALID_NUMBER",
      message:    "Número inválido segundo a base da operadora.",
      suggestion: "Verifique o DDI e a quantidade de dígitos. Celulares BR têm 11 dígitos (com 9), fixos têm 10.",
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

  if (portability?.portabilityHistory?.length > 0) {
    const histLen = portability.portabilityHistory.length;
    hints.push({
      severity:   "info",
      code:       "PORTABILITY_DETECTED",
      message:    `Número portado ${histLen}x. Operadora atual: ${portability.currentCarrier?.name || "—"}.`,
      suggestion: "Verifique se as rotas estão atualizadas para a operadora vigente.",
    });

    const lastPort = portability.portabilityHistory[0];
    if (lastPort?.date && lastPort.date !== "—") {
      const daysDiff = Math.round((Date.now() - new Date(lastPort.date).getTime()) / 86400000);
      if (!isNaN(daysDiff) && daysDiff >= 0 && daysDiff < 30) {
        hints.push({
          severity:   "warning",
          code:       "RECENT_PORTABILITY",
          message:    `Portabilidade realizada há ${daysDiff} dia(s) — muito recente.`,
          suggestion: "Bases de roteamento podem não estar totalmente propagadas. Aguarde 24-48h ou acione o NOC.",
        });
      }
    }
  }

  if (hints.length === 0 || hints.every((h) => h.severity === "info")) {
    hints.push({
      severity:   "success",
      code:       "ALL_CLEAR",
      message:    "Número aparentemente válido e sem anomalias detectadas.",
      suggestion: "Se ainda assim houver falha de discagem, verifique o CDR na plataforma de telefonia.",
    });
  }

  return hints;
}

// ─── Main endpoint ────────────────────────────────────────────────────────────

app.get("/api/validate", async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: "Parâmetro 'phone' é obrigatório." });

  const API_KEY = process.env.ABSTRACT_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: "API Key não configurada no servidor." });

  try {
    // 1️⃣ Abstract API
    const abstractRes = await fetch(
      `https://phoneintelligence.abstractapi.com/v1/?api_key=${API_KEY}&phone=${encodeURIComponent(phone)}`
    );

    if (!abstractRes.ok) {
      const txt = await abstractRes.text();
      return res.status(abstractRes.status).json({ error: `Erro na AbstractAPI: ${txt}` });
    }

    const abstractData = await abstractRes.json();

    // 2️⃣ ABR Telecom portability (apenas BR)
    let portability      = null;
    let portabilityError = null;

    if (isBrazilianNumber(phone, abstractData)) {
      try {
        const brNumber = normalizeBRNumber(phone);
        console.log(`[ABR] Consultando: ${brNumber}`);
        const rawPort = await fetchPortability(brNumber);
        portability   = parsePortabilityResponse(rawPort);
        console.log(`[ABR] Operadora: ${portability?.currentCarrier?.name || "N/A"}`);
      } catch (err) {
        console.error("[ABR] Erro:", err.message);
        portabilityError = err.message;
      }
    }

    // 3️⃣ Guia de discagem (destinos não-BR)
    const dialingGuide = buildDialingGuide(abstractData, phone);

    // 4️⃣ Hints
    const troubleshooting = generateTroubleshootingHints(abstractData, phone, portability);

    // 5️⃣ Merge operadora: ABR > Abstract
    const carrier =
      portability?.currentCarrier?.name || abstractData.carrier || "Desconhecida";

    return res.json({
      ...abstractData,
      carrier,
      portability: portability
        ? { currentCarrier: portability.currentCarrier, portabilityHistory: portability.portabilityHistory, source: "ABR Telecom" }
        : portabilityError
        ? { error: portabilityError, source: "ABR Telecom" }
        : null,
      dialingGuide,
      troubleshooting,
      _meta: { author: "Maicon Cubero", version: "2.1" },
    });

  } catch (err) {
    console.error("Erro no /api/validate:", err);
    return res.status(500).json({ error: "Falha ao consultar a API externa." });
  }
});

app.listen(PORT, () => {
  console.log(`LibphoneX v2.1 · porta ${PORT} · by Maicon Cubero`);
});
