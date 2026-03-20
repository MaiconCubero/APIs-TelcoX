const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({   origin: '*',   methods: ['GET', 'POST'],   allowedHeaders: ['Content-Type'] }));
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "LibphoneX API Gateway running 🚀" });
});

// Phone validation endpoint
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
    const url = `https://phoneintelligence.abstractapi.com/v1/?api_key=${API_KEY}&phone=${encodeURIComponent(phone)}`;
    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: `Erro na AbstractAPI: ${errorText}` });
    }

    const data = await response.json();

    // Enrich with troubleshooting hints
    return res.json(data);
    
  } catch (err) {
    console.error("Erro ao chamar AbstractAPI:", err);
    return res.status(500).json({ error: "Falha ao consultar a API externa." });
  }
});

function generateTroubleshootingHints(data, rawInput) {
  const hints = [];

  if (!data.valid) {
    hints.push({
      severity: "error",
      code: "INVALID_NUMBER",
      message: "Número inválido segundo a base da operadora.",
      suggestion: "Verifique se o DDI está correto e se o número possui a quantidade certa de dígitos.",
    });
  }

  // Missing + prefix
  if (!rawInput.startsWith("+")) {
    hints.push({
      severity: "warning",
      code: "MISSING_PLUS_PREFIX",
      message: "O número não começa com '+'.",
      suggestion: "Números internacionais devem iniciar com '+' seguido do DDI (ex: +55 para Brasil).",
    });
  }

  // Type checks
  if (data.type === "unknown") {
    hints.push({
      severity: "warning",
      code: "UNKNOWN_LINE_TYPE",
      message: "Tipo de linha desconhecido.",
      suggestion: "Pode ser um número VoIP não registrado ou inativo. Confirme com o cliente se o número existe.",
    });
  }

  if (data.type === "landline") {
    hints.push({
      severity: "info",
      code: "LANDLINE_DETECTED",
      message: "Número de telefone fixo detectado.",
      suggestion: "Certifique-se de que a rota de discagem suporta PSTN. Rotas VoIP puras podem falhar para fixos em alguns países.",
    });
  }

  if (data.format && data.format.international && data.format.local) {
    if (data.format.international !== rawInput.replace(/\s/g, "")) {
      hints.push({
        severity: "info",
        code: "FORMAT_MISMATCH",
        message: `Formato digitado difere do padrão internacional.`,
        suggestion: `Use o formato: ${data.format.international}`,
      });
    }
  }

  // Country-specific hints
  if (data.country && data.country.code) {
    const country = data.country.code;
    if (["CN", "RU", "IR", "CU", "KP"].includes(country)) {
      hints.push({
        severity: "warning",
        code: "RESTRICTED_COUNTRY",
        message: `País ${data.country.name} pode ter restrições de roteamento internacional.`,
        suggestion: "Verifique se a rota de saída possui acordo de interconexão com operadoras locais.",
      });
    }
  }

  if (hints.length === 0) {
    hints.push({
      severity: "success",
      code: "ALL_CLEAR",
      message: "Número aparentemente válido e sem anomalias detectadas.",
      suggestion: "Se ainda assim houver falha de discagem, verifique o CDR na plataforma de telefonia.",
    });
  }

  return hints;
}

app.listen(PORT, () => {
  console.log(`LibphoneX backend rodando na porta ${PORT}`);
});

