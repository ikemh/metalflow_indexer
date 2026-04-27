# Serviço Indexador de Arquivos DXF

## Visão Geral

Serviço Node.js que executa localmente no **Windows do cliente** em modo **estritamente read-only**, escaneando pastas de arquivos DXF e sincronizando metadados com o backend ERP Metalflow.

**Porta**: 4000  
**Tecnologias**: Node.js (vanilla), Express, Python (thumbnail generation)  
**Execução**: Serviço do Windows (Task Scheduler) ou systemd (Linux)

## Funcionalidades

- **Descoberta de pastas de clientes** — Lista subdiretórios de primeiro nível nos roots configurados
- **Escaneamento recursivo de arquivos DXF** — Identifica, nomeia e extrai metadados (tamanho, data, caminho relativo)
- **Geração de thumbnails** — Renderiza visualizações PNG de arquivos DXF via Python (ezdxf + matplotlib)
- **Sincronização com backend** — Envia metadados e thumbnails para o backend ERP via API REST
- **GUI web embarcada** — Interface de administração local para status, configuração, logs e trigger manual
- **Timer automático** — Ciclos de sincronização em intervalo configurável (padrão 15 min)
- **Retry com backoff** — Tolerância a falhas de rede com retry progressivo (2s, 5s, 15s)
- **Safe Delete Validation** — Deleções no backend só ocorrem quando o scan é completo (`isCompleteScan = true`)
- **Leve e autônomo** — Apenas 3 dependências Node.js (express, form-data)

## Arquitetura

```
┌────────────────────────────────────────────────────────────────────┐
│                 Windows Local — Serviço Indexador                   │
│                                                                    │
│  ┌──────────────┐   File System   ┌──────────────────────────┐    │
│  │   Scanner    │ ──────────────► │ Pastas Windows           │    │
│  │  (lib/)      │ ◄────────────── │ • Z:\Clientes            │    │
│  │              │    Read-only    │ • Z:\Clientes pedido     │    │
│  │              │                 │   parcial                │    │
│  │   Sync       │                 └──────────────────────────┘    │
│  │  (lib/)      │                                                │
│  │              │   ┌──────────────┐                             │
│  │  Thumbgen    │   │  ./thumbs/   │  Cache local de            │
│  │  (Python)    │──►│  (PNG files) │  thumbnails gerados        │
│  └──────┬───────┘   └──────────────┘                             │
│         │                                                        │
│         │ HTTPS (API Key)                                        │
│         ▼                                                        │
│  ┌──────────────┐  Web GUI (localhost:4000)                      │
│  │  Server.js   │  Dashboard · Roots · Pastas · Config · Logs   │
│  └──────────────┘                                                │
│         │                                                        │
│         ▼ HTTPS (API Key)                                        │
│  ┌────────────────────────────┐                                  │
│  │ Backend ERP (VPS)          │                                  │
│  │ POST /indexer/sync         │                                  │
│  │ POST /indexer/thumbs       │                                  │
│  └────────────────────────────┘                                  │
└────────────────────────────────────────────────────────────────────┘
```

### Fluxo de Sincronização

```
1. A cada N minutos (configurável), inicia ciclo de sync
2. Verifica saúde do backend (GET /)
3. Para cada root configurado:
   a. Verifica acessibilidade do caminho
   b. Descobre pastas de clientes (subdiretórios)
   c. Escaneia recursivamente arquivos .dxf
   d. Gera thumbnails para novos arquivos (cache em ./thumbs/)
   e. Envia thumbnails não cacheados para o backend
   f. Envia lote de metadados para o backend (POST /indexer/sync)
4. Atualiza estado e logs locais
```

## Estrutura de Diretórios

```
indexador_servidor/
├── server.js                 # Servidor HTTP Express + lógica de sync
├── lib/
│   ├── config.js             # Leitura/escrita de config.json
│   ├── scanner.js            # Escaneamento de pastas e arquivos DXF
│   ├── sync.js               # Comunicação HTTP com backend (retry)
│   └── thumbgen.js           # Geração de thumbnails via Python
├── public/
│   └── index.html            # GUI web (dashboard, roots, config, logs)
├── dxf-thumb                 # Script Python de renderização DXF → PNG
├── config.example.json       # Exemplo de configuração
├── package.json              # Dependências Node.js
├── requirements.txt          # Dependências Python
├── install-windows.bat       # Script de instalação no Windows
├── uninstall-windows.bat     # Remoção da tarefa agendada
├── start.bat                 # Início manual no Windows
├── dxf-indexer.service       # Unit file systemd (Linux)
├── thumbs/                   # Cache de thumbnails (gerado, gitignored)
└── config.json               # Config ativa (gitignored)
```

## Componentes

### server.js — Servidor Express + Orquestrador

- **Endpoints da API REST** (porta 4000)
- **Timer de sincronização** — Executa `runSyncCycle()` em intervalo configurável
- **Buffer circular de logs** — 200 entradas, acessível via API
- **Tratamento de sinais** — Graceful shutdown em SIGTERM/SIGINT
- **Ciclo de inicialização** — Executa sync ao iniciar, depois agenda periodicamente

### lib/scanner.js — Escaneamento de Arquivos

**Princípios**:
- **Read-only**: Nunca cria, deleta, renomeia ou modifica arquivos no filesystem do cliente
- **Apenas .dxf**: Filtra exclusivamente arquivos com extensão `.dxf`
- **IDs estáveis**: Gera SHA1 hash de `sourceType::customerFolder::relativePath` para identificar unicamente cada arquivo
- **Normalização**: Converte separadores de path para `/`, normaliza Unicode (NFKC)

**Funções**:
| Função | Descrição |
|--------|-----------|
| `discoverCustomers(rootPath)` | Lista subdiretórios de primeiro nível (cada um = um cliente) |
| `scanFolder(folderPath, sourceType, customerFolder)` | Escaneia recursivamente, retorna arquivos + warnings |
| `isRootAccessible(rootPath)` | Verifica se o caminho do root está acessível |
| `normalizeRootPath(rootPath)` | Normaliza separadores e remove trailing slash |

### lib/sync.js — Comunicação com Backend

- **Retry com backoff progressivo**: 2s → 5s → 15s (3 tentativas)
- **Health check**: `GET /` com timeout de 5s antes do sync
- **Upload de thumbnails**: Multipart/form-data via `form-data` (Node.js nativo)
- **Batch sync**: `POST /indexer/sync` com lote de arquivos
- **Timeout de rede**: 30s para sync, 60s para upload de thumbnail

### lib/thumbgen.js — Geração de Thumbnails

- Executa script Python (`dxf-thumb`) como subprocesso
- Cache em `thumbs/<fileId>.png` — não regenera thumbnails existentes
- Concorrência configurável (padrão: 4 workers simultâneos)
- Timeout de 30s por thumbnail

### dxf-thumb — Script Python de Renderização

Renderiza arquivos DXF como imagens PNG para visualização no frontend.

**Dependências Python**: `ezdxf`, `matplotlib`, `Pillow`

**Características**:
- Tenta modelspace primeiro; se vazio, tenta paperspace layouts
- Gera placeholder branco para desenhos vazios (exit 0, sem erro)
- Crop automático para conteúdo visível
- Margem interna configurável (6%)
- Otimização PNG (`optimize=True`)

**Exit codes**:
| Código | Significado |
|--------|-------------|
| 0 | Sucesso (incluindo placeholder para desenho vazio) |
| 1 | Argumentos inválidos |
| 2 | Arquivo não encontrado |
| 3 | Falha ao renderizar (DXF inválido / dependências ausentes) |

### GUI Web (public/index.html)

Interface de administração dark mode com abas:

| Aba | Descrição |
|-----|-----------|
| **Dashboard** | Status (ocioso/executando/erro), último sync, duração, ciclos, roots, pastas descobertas |
| **Roots** | Gerenciamento de caminhos de origem e tipo (ATACADO/VAREJO) |
| **Pastas** | Pastas de clientes descobertas no último ciclo com detalhes (tipo, arquivos, scan completo) |
| **Config** | URL do backend, API Key, intervalo de sync, concorrência de thumbnails |
| **Logs** | Visualização de logs com filtro por nível (info/warn/error) |

**Atualização automática**: Dashboard faz polling a cada 5 segundos.

## Endpoints da API

### Status e Controle

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/health` | Health check do serviço |
| `GET` | `/api/status` | Estado atual (running, lastSync, ciclos, pastas descobertas) |
| `POST` | `/api/sync` | Dispara ciclo de sincronização manual |
| `GET` | `/api/logs?level=info\|warn\|error` | Logs recentes (últimas 100 entradas) |

### Configuração

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/api/config` | Configurações atuais (sem API Key) |
| `PATCH` | `/api/config` | Atualiza configurações (erpApiUrl, apiKey, syncIntervalMinutes, thumbConcurrency) |

### Roots

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/api/roots` | Lista roots configurados |
| `POST` | `/api/roots` | Adiciona root (`{ path, sourceType }`) |
| `PUT` | `/api/roots/:index` | Atualiza root por índice |
| `DELETE` | `/api/roots/:index` | Remove root por índice |

## Configuração

### config.json

Criado a partir de `config.example.json`:

```json
{
  "erpApiUrl": "https://erp.seudominio.com.br",
  "apiKey": "MESMA_CHAVE_DO_INDEXER_API_KEY_NO_BACKEND",
  "syncIntervalMinutes": 15,
  "thumbConcurrency": 4,
  "roots": [
    {
      "path": "Z:\\Clientes",
      "sourceType": "ATACADO"
    },
    {
      "path": "Z:\\Clientes pedido parcial",
      "sourceType": "VAREJO"
    }
  ],
  "lastSync": null
}
```

| Campo | Descrição |
|-------|-----------|
| `erpApiUrl` | URL base do backend ERP (obrigatório) |
| `apiKey` | Chave de API para autenticação no backend (obrigatório) |
| `syncIntervalMinutes` | Intervalo entre ciclos automáticos (padrão: 15) |
| `thumbConcurrency` | Número de workers simultâneos para geração de thumbnails (padrão: 4) |
| `roots` | Lista de caminhos de pastas raiz com tipo de origem (ATACADO/VAREJO) |
| `lastSync` | Timestamp da última sincronização (gerado automaticamente) |

### Environment Variables

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PORT` | `4000` | Porta do servidor HTTP local |

## Segurança

### API Key Authentication

- Todos os endpoints do indexador que se comunicam com o backend usam `Authorization: Bearer <apiKey>`
- A chave é configurada no `config.json` local e deve ser igual ao `INDEXER_API_KEY` no backend
- Nunca commitada no repositório (`config.json` está no `.gitignore`)

### Read-Only no Filesystem

- O indexador **nunca** cria, deleta, renomeia ou modifica arquivos nas pastas de origem do cliente
- Geração de thumbnails salva em diretório local `./thumbs/`, separado do filesystem de origem
- Verificação de acessibilidade valida apenas leitura (`fs.stat`)

### Safe Delete Protection

- Scans incompletos (com warnings) marcam `isCompleteScan = false`
- O backend não processa deleções quando `isCompleteScan = false`
- Previne perda acidental de dados quando pastas estão temporariamente inacessíveis

### GUI Local

- Acessível apenas em `localhost:4000` (não exposta externamente)
- API Key é exibida como campo password na GUI

## Instalação (Windows)

### Pré-requisitos

- **Node.js** 18+ ([nodejs.org](https://nodejs.org/))
- **Python** 3.8+ ([python.org](https://www.python.org/))

### Instalação Automática

Execute **como Administrador**:

```batch
install-windows.bat
```

O script:
1. Verifica Node.js e Python
2. Instala dependências Node (`npm install --production`)
3. Instala dependências Python (`pip install -r requirements.txt`)
4. Cria `config.json` a partir de `config.example.json` (se não existir)
5. Registra tarefa **DXF-Indexer** no Agendador de Tarefas do Windows
   - Executa ao iniciar o sistema
   - Usuário: SYSTEM
   - Prioridade: Alta

### Instalação Manual

```batch
npm install --production
pip install -r requirements.txt
copy config.example.json config.json
REM Editar config.json com as configurações corretas
node server.js
```

### Configuração Pós-Instalação

1. Editar `config.json`:
   - `erpApiUrl`: URL do backend na VPS (ex: `https://erp.exemplo.com.br`)
   - `apiKey`: mesma chave configurada em `INDEXER_API_KEY` no backend
   - `roots`: caminhos das pastas de clientes (ex: `Z:\Clientes`)

2. Iniciar o serviço:
   - **Automático**: Reiniciar o Windows (tarefa agendada inicia automaticamente)
   - **Manual**: Executar `start.bat` ou `node server.js`

3. Acessar GUI: [http://localhost:4000](http://localhost:4000)

### Desinstalação

```batch
uninstall-windows.bat
```

Remove a tarefa agendada **DXF-Indexer** do Agendador de Tarefas.

## Instalação (Linux)

### systemd Service

```bash
# Copiar o diretório
cp -r indexador_servidor /opt/indexador

# Instalar dependências
cd /opt/indexador
npm install --production
pip install -r requirements.txt

# Configurar
cp config.example.json config.json
# Editar config.json

# Instalar serviço
sudo cp dxf-indexer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable dxf-indexer
sudo systemctl start dxf-indexer
```

### Nginx Reverse Proxy (Opcional)

Para expor a GUI do indexador externamente com segurança:

```nginx
server {
    listen 443 ssl;
    server_name indexador.exemplo.com.br;

    ssl_certificate /etc/letsencrypt/live/indexador.exemplo.com.br/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/indexador.exemplo.com.br/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
    }
}
```

## Desenvolvimento

### Setup Local

```bash
cd indexador_servidor
npm install
pip install -r requirements.txt
cp config.example.json config.json
# Editar config.json com URL local do backend (ex: http://localhost:3333)
node server.js
```

Acessar: [http://localhost:4000](http://localhost:4000)

### Dependências

**Node.js**:
- `express` 4.19 — Servidor HTTP
- `form-data` 4.0 — Upload de thumbnails multipart

**Python**:
- `ezdxf` — Leitura e renderização de arquivos DXF
- `matplotlib` — Backend de renderização
- `Pillow` — Processamento de imagem (crop, resize, otimização PNG)

### Script Python (dxf-thumb)

Renderiza DXF como PNG com as seguintes características:

- **Lineweight scaling**: 1.8 (linhas mais visíveis em thumbnails pequenos)
- **Min lineweight**: 3.0 (garante legibilidade)
- **Margem interna**: 6% do tamanho do thumbnail
- **Fallback para paperspace**: Se modelspace estiver vazio, tenta layouts
- **Placeholder branco**: Para desenhos vazios, gera imagem branca em vez de erro

Teste manual:
```bash
python3 dxf-thumb /caminho/arquivo.dxf 256 /tmp/out.png
```

## Monitoramento

### Logs

O indexador mantém um buffer circular de 200 entradas de log em memória:

```javascript
// Acessível via API
GET /api/logs          // Todas as entradas
GET /api/logs?level=error  // Apenas erros
```

**Níveis de log**:
- `info` — Ciclos de sync, pastas encontradas, resultados
- `warn` — Pastas inacessíveis, warns de scan, warnings de thumbnail
- `error` — Backend unreachable, sync failures, erros de configuração

### Console

Logs também são enviados para stdout/stderr para coleta via systemd ou arquivo `indexer.log`.

### Status API

```json
GET /api/status

{
  "running": false,
  "lastSync": "2026-04-23T15:30:00.000Z",
  "lastDurationMs": 12500,
  "lastError": null,
  "cycleCount": 42,
  "syncIntervalMinutes": 15,
  "rootCount": 2,
  "discoveredFolders": [
    {
      "folderName": "Cutelaria ABC",
      "sourceType": "ATACADO",
      "rootPath": "Z:/Clientes",
      "fileCount": 15,
      "isCompleteScan": true,
      "lastSeenAt": "2026-04-23T15:30:00.000Z"
    }
  ]
}
```

## Troubleshooting

### Indexador não inicia

1. Verificar Node.js: `node --version`
2. Verificar Python: `python --version`
3. Checar dependências: `npm list` e `pip list`
4. Verificar `config.json` (certifique-se de que existe e tem conteúdo válido)
5. Executar manualmente: `node server.js` e observar erros no console

### Backend unreachable

1. Verificar URL do backend em `config.json`
2. Testar conectividade: `curl https://erp.exemplo.com.br`
3. Verificar se o backend está rodando (systemctl status)
4. Confirmar firewall liberado

### Thumbnails não gerados

1. Verificar Python + dependências: `python -c "import ezdxf; import matplotlib; import PIL"`
2. Testar script manualmente: `python dxf-thumb /caminho/teste.dxf 256 /tmp/teste.png`
3. Verificar permissões de escrita no diretório `thumbs/`
4. Aumentar `thumbConcurrency` ou verificar timeout de 30s por thumbnail

### Sincronização lenta

1. Verificar tamanho das pastas (muitos arquivos DXF podem demorar)
2. Ajustar `syncIntervalMinutes` (aumentar para intervalos maiores)
3. Verificar latência de rede com o backend
4. Ajustar `thumbConcurrency` (mais workers = mais rápido, mas mais CPU)

### Pastas não aparecem

1. Verificar se os roots configurados existem e estão acessíveis
2. Verificar permissões de leitura nas pastas
3. Verificar se é um diretório (não arquivo)
4. Verificar logs no dashboard ou via `GET /api/logs?level=error`

## Boas Práticas

### Operação

- Execute como serviço do sistema (Task Scheduler no Windows, systemd no Linux)
- A GUI local dispensa acesso remoto — toda interação com o backend é via API
- Monitore logs periodicamente para detectar erros de conectividade ou permissão
- Mantenha backups do `config.json` em local seguro

### Atualização

1. Parar o serviço
2. Substituir arquivos do indexador
3. Reinstalar dependências se necessário (`npm install`, `pip install`)
4. Iniciar o serviço

### Segurança

- `config.json` contém API Key — mantenha permissões restritas (apenas leitura para o usuário do serviço)
- A GUI está vinculada a `0.0.0.0:4000` — em produção, configure firewall para aceitar apenas localhost ou use Nginx com autenticação
- O diretório `thumbs/` pode conter representações parciais de projetos — considere acesso restrito

## Links Relacionados

- **[README Root](../README.md)** — Visão geral do sistema ERP Metalflow
- **[README Backend](dbortoli-erp/backend/README.md)** — API NestJS e endpoints de integração (/indexer/sync, /indexer/thumbs)
- **[README Frontend](dbortoli-erp/frontend/README.md)** — Interface web que consome thumbnails nos formulários de pedido

---

**Última Atualização**: Abril 2026  
**Status**: Estável, em produção
