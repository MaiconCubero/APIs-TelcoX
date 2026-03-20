const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "LibphoneX API Gateway running 🚀" });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normaliza um número brasileiro para consulta na ABR Telecom:
 * Remove tudo que não é dígito e garante 10 ou 11 dígitos (sem DDI).
 */
function normalizeBRNumber(phone) {
  // Remove tudo que não for dígito
  let digits = phone.replace(/\D/g, "");

  // Remove DDI 55 se presente
  if (digits.startsWith("55") && digits.length > 11) {
    digits = digits.slice(2);
  }

  return digits; // Ex: "11912345678"
}

/**
 * Detecta se o número de entrada é brasileiro (DDI 55 explícito ou 10-11 dígitos sem DDI).
 */
function isBrazilianNumber(phone, abstractData) {
  if (abstractData?.country?.code === "BR") return true;
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("55")) return true;
  if (digits.length === 10 || digits.length === 11) return true;
  return false;
}

/**
 * Consulta o histórico de portabilidade na ABR Telecom.
 * Endpoint oficial: POST https://consultanumero.abrtelecom.com.br/consultanumero/consulta/consultaHistoricoRecenteCtg
 * Body: application/x-www-form-urlencoded  →  numero=XXXXXXXXXXX
 */
async function fetchPortability(brNumber) {
  const url =
    "https://consultanumero.abrtelecom.com.br/consultanumero/consulta/consultaHistoricoRecenteCtg";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      // Simula browser para evitar bloqueio por User-Agent
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      Origin: "https://consultanumero.abrtelecom.com.br",
      Referer: "https://consultanumero.abrtelecom.com.br/",
    },
    body: `numero=${encodeURIComponent(brNumber)}`,
    timeout: 8000,
  });

  if (!response.ok) {
    throw new Error(`ABR Telecom retornou status ${response.status}`);
  }

  const data = await response.json();
  return data;
}

/**
 * Formata a resposta bruta da ABR Telecom num objeto amigável.
 * A API retorna algo como:
 * {
 *   numeroConsultado: "11912345678",
 *   prestadoraAtual: { nome: "Claro", cnpj: "...", sigla: "CLA" },
 *   historicoPortabilidade: [
 *     { dataPortabilidade: "2023-05-10", prestadoraOrigem: {...}, prestadoraDestino: {...} },
 *     ...
 *   ]
 * }
 */
function parsePortabilityResponse(raw) {
  if (!raw) return null;

  // Campos podem variar ligeiramente — tentamos as variações conhecidas
  const current =
    raw.prestadoraAtual ||
    raw.operadoraAtual ||
    raw.prestadora ||
    null;

  const history =
    raw.historicoPortabilidade ||
    raw.historico ||
    raw.portabilidades ||
    [];

  return {
    currentCarrier: current
      ? {
          name: current.nome || current.nomeFantasia || current.sigla || "—",
          cnpj: current.cnpj || null,
          sigla: current.sigla || null,
        }
      : null,
    portabilityHistory: Array.isArray(history)
      ? history.map((h) => ({
          date: h.dataPortabilidade || h.data || h.dtPortabilidade || "—",
          from: {
            name:
              (h.prestadoraOrigem || h.operadoraOrigem || {}).nome ||
              (h.prestadoraOrigem || h.operadoraOrigem || {}).sigla ||
              "—",
            sigla:
              (h.prestadoraOrigem || h.operadoraOrigem || {}).sigla || null,
          },
          to: {
            name:
              (h.prestadoraDestino || h.operadoraDestino || {}).nome ||
              (h.prestadoraDestino || h.operadoraDestino || {}).sigla ||
              "—",
            sigla:
              (h.prestadoraDestino || h.operadoraDestino || {}).sigla || null,
          },
        }))
      : [],
    rawResponse: raw,
  };
}

/**
 * Gera dicas de discagem internacional para usuário brasileiro.
 * Regras:
 *  - DDR de saída BR: 0 + operadora (14=Embratel, 15=Vivo, 21=Claro, 23=TIM, etc.)
 *  - Formato: 0 + XX + DDI + Número
 *  Retorna as principais opções de discagem.
 */
function buildDialingGuide(abstractData, rawPhone) {
  if (!abstractData?.country?.code || abstractData.country.code === "BR") {
    return null;
  }

  const ddi = abstractData.country.prefix || abstractData.country.calling_code || null;
  if (!ddi) return null;

  // Normaliza o número destino (sem DDI, sem +)
  let digits = rawPhone.replace(/\D/g, "");
  const ddiStr = String(ddi);
  if (digits.startsWith(ddiStr)) digits = digits.slice(ddiStr.length);
  if (digits.startsWith("55")) digits = digits.slice(2); // remove BR por acidente

  const intlFormat = abstractData.format?.international || `+${ddi}${digits}`;

  const carriers = [
    { sigla: "Embratel", code: "14" },
    { sigla: "Claro",    code: "21" },
    { sigla: "TIM",      code: "41" },
    { sigla: "Vivo",     code: "15" },
    { sigla: "Oi",       code: "31" },
  ];

  return {
    destinationCountry: abstractData.country.name,
    destinationDDI: ddiStr,
    destinationNumber: digits,
    internationalFormat: intlFormat,
    // Discagem direta internacional do Brasil
    dialingOptions: carriers.map((c) => ({
      carrier: c.sigla,
      carrierCode: c.code,
      dialString: `0${c.code}+${ddiStr}${digits}`,
      description: `Discar via ${c.sigla} (operadora ${c.code})`,
    })),
    note:
      "No Brasil, a discagem internacional usa o prefixo 00 ou 0 + código da operadora de longa distância + DDI + número. Alguns planos corporativos podem ter CSP fixo configurado na central.",
  };
}

// ─── Troubleshooting hints ────────────────────────────────────────────────────

function generateTroubleshootingHints(data, rawInput, portability) {
  const hints = [];

  if (!data.valid) {
    hints.push({
      severity: "error",
      code: "INVALID_NUMBER",
      message: "Número inválido segundo a base da operadora.",
      suggestion:
        "Verifique se o DDI está correto e se o número possui a quantidade certa de dígitos.",
    });
  }

  if (!rawInput.startsWith("+")) {
    hints.push({
      severity: "warning",
      code: "MISSING_PLUS_PREFIX",
      message: "O número não começa com '+'.",
      suggestion:
        "Números internacionais devem iniciar com '+' seguido do DDI (ex: +55 para Brasil).",
    });
  }

  if (data.type === "unknown") {
    hints.push({
      severity: "warning",
      code: "UNKNOWN_LINE_TYPE",
      message: "Tipo de linha desconhecido.",
      suggestion:
        "Pode ser um número VoIP não registrado ou inativo. Confirme com o cliente se o número existe.",
    });
  }

  if (data.type === "landline") {
    hints.push({
      severity: "info",
      code: "LANDLINE_DETECTED",
      message: "Número de telefone fixo detectado.",
      suggestion:
        "Certifique-se de que a rota de discagem suporta PSTN. Rotas VoIP puras podem falhar para fixos em alguns países.",
    });
  }

  if (
    data.format?.international &&
    data.format.international !== rawInput.replace(/\s/g, "")
  ) {
    hints.push({
      severity: "info",
      code: "FORMAT_MISMATCH",
      message: "Formato digitado difere do padrão internacional.",
      suggestion: `Use o formato: ${data.format.international}`,
    });
  }

  if (data.country?.code) {
    const restricted = ["CN", "RU", "IR", "CU", "KP"];
    if (restricted.includes(data.country.code)) {
      hints.push({
        severity: "warning",
        code: "RESTRICTED_COUNTRY",
        message: `País ${data.country.name} pode ter restrições de roteamento internacional.`,
        suggestion:
          "Verifique se a rota de saída possui acordo de interconexão com operadoras locais.",
      });
    }
  }

  // Portabilidade hints
  if (portability) {
    const histLen = portability.portabilityHistory?.length || 0;
    if (histLen > 0) {
      hints.push({
        severity: "info",
        code: "PORTABILITY_DETECTED",
        message: `Número portado ${histLen}x. Operadora atual: ${portability.currentCarrier?.name || "—"}.`,
        suggestion:
          "Verifique se as rotas estão atualizadas para a operadora atual. Portabilidade recente pode causar falhas temporárias de entrega.",
      });
    }
    const lastPort = portability.portabilityHistory?.[0];
    if (lastPort) {
      const daysDiff = Math.round(
        (Date.now() - new Date(lastPort.date).getTime()) / 86400000
      );
      if (!isNaN(daysDiff) && daysDiff < 30) {
        hints.push({
          severity: "warning",
          code: "RECENT_PORTABILITY",
          message: `Portabilidade realizada há ${daysDiff} dia(s) — muito recente.`,
          suggestion:
            "Bases de roteamento podem não estar totalmente propagadas. Se houver falha, aguarde 24-48h ou acione o NOC.",
        });
      }
    }
  }

  if (hints.length === 0 || hints.every((h) => h.severity === "info")) {
    hints.push({
      severity: "success",
      code: "ALL_CLEAR",
      message: "Número aparentemente válido e sem anomalias detectadas.",
      suggestion:
        "Se ainda assim houver falha de discagem, verifique o CDR na plataforma de telefonia.",
    });
  }

  return hints;
}

// ─── Main endpoint ────────────────────────────────────────────────────────────

app.get("/api/validate", async (req, res) => {
  const { phone } = req.query;

  if (!phone) {
    return res.status(400).json({ error: "Parâmetro 'phone' é obrigatório." });
  }

  const API_KEY = process.env.ABSTRACT_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: "API Key não configurada no servidor." });
  }

  try {
    // 1️⃣ Abstract API
    const abstractUrl = `https://phoneintelligence.abstractapi.com/v1/?api_key=${API_KEY}&phone=${encodeURIComponent(phone)}`;
    const abstractRes = await fetch(abstractUrl);

    if (!abstractRes.ok) {
      const errorText = await abstractRes.text();
      return res
        .status(abstractRes.status)
        .json({ error: `Erro na AbstractAPI: ${errorText}` });
    }

    const abstractData = await abstractRes.json();

    // 2️⃣ ABR Telecom portability (only for BR numbers)
    let portability = null;
    let portabilityError = null;

    if (isBrazilianNumber(phone, abstractData)) {
      try {
        const brNumber = normalizeBRNumber(phone);
        const rawPort = await fetchPortability(brNumber);
        portability = parsePortabilityResponse(rawPort);
      } catch (err) {
        console.error("Portability lookup failed:", err.message);
        portabilityError = err.message;
      }
    }

    // 3️⃣ International dialing guide (for BR users calling abroad)
    const dialingGuide = buildDialingGuide(abstractData, phone);

    // 4️⃣ Troubleshooting hints
    const troubleshooting = generateTroubleshootingHints(abstractData, phone, portability);

    // 5️⃣ Merge carrier: prefer ABR Telecom if available
    const carrier =
      portability?.currentCarrier?.name ||
      abstractData.carrier ||
      "Desconhecida";

    return res.json({
      ...abstractData,
      carrier,
      portability: portability
        ? {
            currentCarrier: portability.currentCarrier,
            portabilityHistory: portability.portabilityHistory,
            source: "ABR Telecom",
          }
        : portabilityError
        ? { error: portabilityError, source: "ABR Telecom" }
        : null,
      dialingGuide,
      troubleshooting,
    });
  } catch (err) {
    console.error("Erro no /api/validate:", err);
    return res.status(500).json({ error: "Falha ao consultar a API externa." });
  }
});

app.listen(PORT, () => {
  console.log(`LibphoneX backend rodando na porta ${PORT}`);
});
