"use strict";

/**
 * Envio para corte do varejo: o ERP decide que DXF vai para qual pasta de
 * `_CORTES` e com que nome; aqui só se copia.
 *
 * Substitui o anexador (Flask no PC do Diosef, protótipo de 2026): ele lia um
 * JSON baixado do card e copiava com `shutil.copy2`, que sobrescrevia. Aqui:
 *   - nunca sobrescreve: nome igual e conteúdo igual = JA_EXISTIA; conteúdo
 *     diferente = grava com " (2)";
 *   - confere o md5 da cópia contra a origem;
 *   - só copia DE dentro das raízes conhecidas (catálogo e pastas de clientes)
 *     e só PARA dentro de `cutsRoot` — o ERP não consegue mandar copiar nada
 *     de outro lugar do disco.
 *
 * O laço é separado do sync de pastas de propósito: erro aqui (rota que ainda
 * não subiu na VPS, ERP fora) não conta no circuit breaker que para o sync dos
 * clientes. `cutsRoot` vazio = desligado.
 */

const fs = require("fs/promises");
const { constants: fsc, createReadStream } = require("fs");
const path = require("path");
const crypto = require("crypto");

const CLAIM_TIMEOUT_MS = 45_000; // o ERP segura a pergunta ~25 s
const RESULT_TIMEOUT_MS = 30_000;
const BACKOFF_MIN_MS = 30_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const MAX_SUFFIX = 50;

function md5File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("md5");
    createReadStream(file)
      .on("error", reject)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex").toUpperCase()));
  });
}

/** Caminho comparável: absoluto, separador do SO, sem diferença de caixa no Windows. */
function norm(p) {
  const r = path.resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

function isInside(child, root) {
  if (!root) return false;
  const c = norm(child);
  const r = norm(root);
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** Nome de pasta/arquivo simples: sem separador, sem "..", sem caractere proibido. */
function isPlainName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length < 250 &&
    !/[\\/:*?"<>|\x00-\x1f]/.test(name) &&
    name !== "." &&
    name !== ".."
  );
}

function withSuffix(fileName, n) {
  const ext = path.extname(fileName);
  return `${fileName.slice(0, fileName.length - ext.length)} (${n})${ext}`;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Origem permitida: CATALOGO relativo ao catálogo; CLIENTE dentro de uma raiz. */
function resolveSource(file, config) {
  if (file.sourceKind === "CATALOGO") {
    if (!config.catalogRoot) throw new Error("catálogo não configurado no indexador");
    const p = path.join(config.catalogRoot, file.sourcePath);
    if (!isInside(p, config.catalogRoot)) throw new Error("origem fora do catálogo");
    return p;
  }
  if (file.sourceKind === "CLIENTE") {
    const p = path.resolve(file.sourcePath);
    const ok = (config.roots || []).some((r) => isInside(p, r.path));
    if (!ok) throw new Error("origem fora das pastas de clientes");
    if (isInside(p, config.cutsRoot)) throw new Error("origem dentro de _CORTES");
    return p;
  }
  throw new Error(`tipo de origem desconhecido: ${file.sourceKind}`);
}

async function copyOne(file, config) {
  const base = { fileId: file.id };
  try {
    if (!isPlainName(file.materialFolder)) throw new Error("pasta de material inválida");
    if (!isPlainName(file.fileName)) throw new Error("nome de arquivo inválido");

    const source = resolveSource(file, config);
    const stat = await fs.stat(source).catch(() => null);
    if (!stat || !stat.isFile()) throw new Error(`origem não existe: ${source}`);

    // Como o anexador: a pasta do material tem de existir (é o Arthur quem as
    // organiza). Material novo pede pasta criada à mão, não por engano.
    const folder = path.join(config.cutsRoot, file.materialFolder);
    const fstat = await fs.stat(folder).catch(() => null);
    if (!fstat || !fstat.isDirectory()) throw new Error(`pasta não existe: ${folder}`);

    const sourceMd5 = await md5File(source);
    for (let n = 1; n <= MAX_SUFFIX; n++) {
      const name = n === 1 ? file.fileName : withSuffix(file.fileName, n);
      const target = path.join(folder, name);
      if (!isInside(target, config.cutsRoot)) throw new Error("destino fora de _CORTES");

      if (await exists(target)) {
        if ((await md5File(target)) === sourceMd5) {
          return { ...base, status: "JA_EXISTIA", writtenFileName: name, md5: sourceMd5 };
        }
        continue; // outro arquivo com esse nome: tenta " (2)", " (3)"...
      }
      try {
        await fs.copyFile(source, target, fsc.COPYFILE_EXCL);
      } catch (e) {
        if (e && e.code === "EEXIST") continue; // alguém gravou no meio-tempo
        throw e;
      }
      const written = await md5File(target);
      if (written !== sourceMd5) {
        await fs.unlink(target).catch(() => {});
        throw new Error("cópia não confere com a origem (md5)");
      }
      return { ...base, status: "COPIADO", writtenFileName: name, md5: written };
    }
    throw new Error(`já existem ${MAX_SUFFIX} arquivos com esse nome`);
  } catch (e) {
    return { ...base, status: "ERRO", error: String((e && e.message) || e).slice(0, 900) };
  }
}

async function post(config, urlPath, body, timeoutMs) {
  const base = String(config.erpApiUrl || "").replace(/\/+$/, "");
  const res = await fetch(`${base}${urlPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Laço: pergunta ao ERP (que segura a pergunta até ter envio), copia,
 * devolve. Relê a config a cada volta — ligar/desligar não pede reinício.
 */
function startCutSendLoop({ readConfig, log }) {
  let stopped = false;
  let backoff = BACKOFF_MIN_MS;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    let announced = null;
    while (!stopped) {
      let config;
      try {
        config = await readConfig();
      } catch (e) {
        log("error", `[cut] config ilegível: ${e.message}`);
        await sleep(BACKOFF_MAX_MS);
        continue;
      }
      const enabled = !!(config.cutsRoot && config.erpApiUrl && config.apiKey);
      if (announced !== enabled) {
        log("info", `[cut] Envio para corte: ${enabled ? config.cutsRoot : "(desligado)"}`);
        announced = enabled;
      }
      if (!enabled) {
        await sleep(60_000);
        continue;
      }

      try {
        const { job } = await post(config, "/indexer/cut-sends/claim", {}, CLAIM_TIMEOUT_MS);
        backoff = BACKOFF_MIN_MS;
        if (!job) continue;

        log("info", `[cut] Envio ${job.sendId}: ${job.files.length} arquivo(s)`);
        const results = [];
        for (const file of job.files) {
          const r = await copyOne(file, config);
          results.push(r);
          log(
            r.status === "ERRO" ? "warn" : "info",
            `[cut]   ${r.status} ${file.materialFolder}\\${r.writtenFileName || file.fileName}${r.error ? ` — ${r.error}` : ""}`,
          );
        }
        // O resultado não pode se perder: a cópia já aconteceu.
        for (let attempt = 1; ; attempt++) {
          try {
            const out = await post(
              config,
              `/indexer/cut-sends/${encodeURIComponent(job.sendId)}/result`,
              { results },
              RESULT_TIMEOUT_MS,
            );
            log("info", `[cut] Envio ${job.sendId}: ${out.status} (${out.ok}/${out.total})`);
            break;
          } catch (e) {
            log("warn", `[cut] resultado do envio ${job.sendId} não entregue (${attempt}): ${e.message}`);
            if (attempt >= 10) break; // o ERP devolve o envio à fila depois de 10 min
            await sleep(Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * attempt));
          }
        }
      } catch (e) {
        log("warn", `[cut] ERP indisponível para envio de corte: ${e.message} — nova tentativa em ${Math.round(backoff / 1000)} s`);
        await sleep(backoff);
        backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
      }
    }
  })();

  return () => {
    stopped = true;
  };
}

module.exports = { startCutSendLoop, copyOne, isInside, isPlainName, withSuffix, post, exists };
