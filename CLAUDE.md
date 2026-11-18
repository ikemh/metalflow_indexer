# CLAUDE.md

Indexador de DXF do ERP Metalflow / D'Bortoli Lâminas. Varre as pastas do
servidor da empresa, gera a miniatura PNG de cada DXF (Python: ezdxf +
matplotlib, `dxf-thumb`) e envia metadados e miniaturas ao backend do ERP
(repo `dbortoli-erp`, módulo `backend/src/indexer`). Comentários, commits e
texto de tela em português; identificadores em inglês.

**Produção não é esta máquina.** Roda no PC servidor da empresa (Windows 11),
em `C:\metalflow_indexer`, como clone deste repo — acesso, receitas e regras na
skill **`servidor-empresa`** (`.claude/skills/servidor-empresa/SKILL.md`).
O `config.json` daqui é cópia de desenvolvimento (aponta para `localhost`), não
o de produção.

Trabalho direto na `main`. Atualizar produção = commit + push aqui, depois
`git pull` lá e reiniciar a tarefa `DXF-Indexer`.

## O que o indexador faz

- **Raízes de clientes** (`roots`, ATACADO/VAREJO): cada subpasta de primeiro
  nível é um cliente; o scan desce recursivo. Vão para `/indexer/sync` e
  `/indexer/folders/reconcile`. O watcher (chokidar, polling) sincroniza só a
  pasta que mudou, ~2 min depois do arquivo salvo (debounce 90 s).
- **Catálogo do site** (`catalogRoot`): só os arquivos da própria pasta, sem
  subpastas (lá ficam cópias antigas). Vai para `/indexer/catalog/sync`, só no
  ciclo periódico. Quem lê o nome do arquivo e decide de que produto é o desenho
  é o ERP (`catalog-file-name.ts`), não o indexador.
- **Miniaturas** sobem por `/indexer/thumbs`; o id é o sha1 estável de
  `sourceType::pasta::caminho` (`CATALOGO::` para o catálogo).
- Sync de pasta e ciclo completo passam pela mesma fila (`enqueueSync`): durante
  um ciclo longo, o arquivo novo do watcher espera.
- `isCompleteScan` só é verdadeiro sem warning de leitura — é o que autoriza o
  ERP a desativar arquivo sumido.

## Testar sem tocar em produção

Não há suíte de testes. O que funcionou para o catálogo: copiar `server.js`,
`lib/`, `public/`, `dxf-thumb` e `package.json` para uma pasta temporária,
`node_modules` por symlink, com um `config.json` próprio (outra porta via
`PORT=4099`, `erpApiUrl` de um backend local de teste com banco descartável).
As pastas reais estão montadas em `/var/mnt/servidor-ts/` (Tailscale + CIFS;
mais lento que o disco local do servidor). Checagem rápida: `node --check`.

## Cuidados

- Rota nova no backend sobe para a VPS **antes** de o indexador chamá-la: 404
  conta no circuit breaker, que para o sync dos clientes junto.
- `config.json`, `thumbs/` e `data/` são ignorados pelo git — um `git pull` em
  produção não os toca. Config nova precisa de default em `lib/config.js`
  (o `readConfig` mescla com `DEFAULT_CONFIG`).
- `absolutePath` do scanner nunca vai ao backend.
