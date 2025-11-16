# IPTV Channel Tester

Ferramenta para testar todos os canais IPTV e gerar relatórios automáticos.

## Como usar

1. **Executar o teste:**
   ```bash
   npm test
   ```

2. **Aguardar o resultado:**
   - O script testa 5 canais de cada vez (para não sobrecarregar o servidor)
   - Mostra progresso em tempo real no terminal
   - Gera 2 relatórios automaticamente:
     - `channel-test-report.html` - Relatório visual (abrir no browser)
     - `channel-test-report.json` - Dados em JSON para análise

## O que o teste faz

✓ **Valida cada canal:**
- Testa se o URL responde (timeout: 10 segundos)
- Verifica se o M3U8 é válido
- Conta quantas variantes/qualidades existem
- Identifica o codec usado (H.264/AVC ou HEVC/H.265)
- Mede tempo de resposta
- Marca canais Full HD automaticamente

✓ **Gera relatório detalhado com:**
- Resumo geral (total, working, failed, filtered)
- Lista de canais funcionais com métricas
- Lista de canais com falha e motivo do erro
- Lista de canais Full HD filtrados
- Destaque visual de codecs HEVC (incompatíveis com maioria dos browsers)

## Configuração

Editar `test-channels.js` se necessário:

```javascript
const TIMEOUT = 10000;           // Timeout por canal (ms)
const CONCURRENT_TESTS = 5;      // Canais testados simultaneamente
const MIN_PLAYLIST_SIZE = 50;    // Tamanho mínimo do M3U8 (bytes)
```

## Exemplo de output

```
IPTV Channel Validator
======================

Found 150 channels

Testing batch 1/30
✓ RTP 1 HD - 234ms - 3 variants
✓ SIC HD - 189ms - 2 variants
✗ Canal XYZ - TIMEOUT
...

======================
SUMMARY
======================
Total channels: 150
Working: 120 (80%)
Failed: 30 (20%)
Filtered (Full HD): 45 (30%)
```

## Relatório HTML

Abre `channel-test-report.html` no browser para ver:
- Tabelas interativas ordenáveis
- Codecs destacados por cor (HEVC em vermelho, H.264 em verde)
- Filtro de canais Full HD
- Tempos de resposta
- Erros detalhados

## Notas

- Os relatórios **não** são commitados ao git (estão em `.gitignore`)
- Execute localmente para testar a sua subscrição IPTV
- Útil para debug e para identificar canais problemáticos
- Identifica automaticamente canais HEVC que não funcionam no browser
