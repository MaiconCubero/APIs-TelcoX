#  LibPhoneX — Telecom Troubleshoot Gateway 📠

**LibPhoneX** é uma API gratuita e de código aberto projetada para resolver um problema comum enfrentado por equipes de suporte de telefonia fixa e móvel: **clientes com dificuldades em discagens internacionais**.

Em vez de depender de verificadores complexos ou formatos de código confusos, a LibPhoneX oferece uma maneira simples e direta de validar números e obter o formato de discagem correto para diferentes origens (fixo, móvel, central telefônica).

##  Propósito

A API nasceu da necessidade real de centralizar e simplificar a validação de números internacionais. Ela combina múltiplas fontes confiáveis (libphonenumber e Abstract) em uma única interface amigável, permitindo que qualquer pessoa — desde agentes de suporte até desenvolvedores — verifique rapidamente se um número é válido e como ele deve ser discado corretamente.

##  Funcionalidades

- **Validação de números internacionais** com base em padrões globais.
- **Correção automática de formato**: aceita números nos formatos `+DDI` ou `00DDI` (ex: `+5511...` ou `005511...`).
- **Suporte a números locais** (Brasil) sem DDI.
- **Diagnóstico de discagem** informando o formato correto para:
  - Origem **móvel**
  - Origem **fixa**
  - **Central telefônica** (PABX)
- **Transparência de dados**: indica claramente a fonte da informação (libphonenumber e Abstract).
- **Interface web simples** para testes manuais.
- **API RESTful** disponível para integração com sistemas de suporte, CRMs ou automações.

## 🔧 Como Usar

### Acesse o Gateway Online
A API está disponível publicamente em:  
[https://maiconcubero.github.io/APIs-TelcoX/](https://maiconcubero.github.io/APIs-TelcoX/)

### Interface Web
1. Digite o número no campo `PHONE` usando `+` ou `00` como código de saída internacional.
2. Clique para analisar.
3. O sistema retornará:
   - Validação do número
   - Formatação internacional recomendada
   - Modos de discagem para fixo, móvel e central

### Uso via API (exemplo com cURL)
```bash
curl -X GET "https://maiconcubero.github.io/APIs-TelcoX/api/validate?number=+5511999999999"
````

🧠 Fontes de Dados
A LibPhoneX consolida informações das seguintes fontes confiáveis:

libphonenumber – Biblioteca do Google para validação e formatação de números internacionais.

Abstract – API de verificação de telefones e identificação de operadora.

A transparência sobre a origem dos dados ajuda usuários e desenvolvedores a entenderem a confiabilidade das informações fornecidas.


## 🤝 Contribuições
Sugestões, melhorias e relatos de problemas são bem-vindos. A ideia é manter a ferramenta útil e acessível para quem lida diariamente com chamadas internacionais e suporte técnico.

Desenvolvido com foco em resolver um problema real de forma simples e transparente.<br>
📍 https://maiconcubero.github.io/APIs-TelcoX/
