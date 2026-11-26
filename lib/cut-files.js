"use strict";

/**
 * A pasta OK viva: onde está cada arquivo que o ERP mandou para `_CORTES`, e
 * o arquivo de item já separado sai de `OK\` para `OK\HIST\`.
 *
 * O Arthur programa movendo o arquivo da raiz do material para `OK\` — é o
 * sinal de "programado" que o viewer do Diosef usava, e que o tablet da
 * fábrica usa para mostrar só o que já pode estar na pilha. Depois de separar,
 * era o Diosef quem movia o arquivo para `OK\HIST\`, à mão; com a saída dele,
 * quem move é este laço, quando o operador confirma o item no tablet (e
 * devolve para `OK\` se o item for desfeito).
 *
 * Regras de segurança:
 * - só olha e move dentro de `cutsRoot`, e só arquivo que o ERP listou (nome
 *   simples, pasta de material simples);
 * - só move entre `OK\` e `OK\HIST\` — a raiz é do Arthur, nunca é tocada;
 * - nunca sobrescreve: se o destino já tem um arquivo com o nome, não move e
 *   conta o erro ao ERP;
 * - `rename` no mesmo disco: o arquivo não é copiado, não há meio-arquivo.
 *   Arquivo aberto (CypCut/AlmaCAM) falha com EBUSY e é tentado de novo na
 *   volta seguinte.
 */

const fs = require("fs/promises");
const path = require("path");
const { isInside, isPlainName, post, exists } = require("./cut-sends");

const INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** Onde o arquivo está agora: OK, HIST, RAIZ ou AUSENTE. */
async function locate(folder, fileName) {
  if (await exists(path.join(folder, "OK", fileName))) return "OK";
  if (await exists(path.join(folder, "OK", "HIST", fileName))) return "HIST";
  if (await exists(path.join(folder, fileName))) return "RAIZ";
  return "AUSENTE";
}

/**
 * Olha um arquivo e, se o ERP quer em outro lugar (entre OK e HIST), move.
 * Devolve `{ id, location, error? }` — o lugar depois de mover.
 */
async function reconcileOne(file, config) {
  const base = { id: file.id };
  try {
    if (!isPlainName(file.materialFolder) || !isPlainName(file.fileName)) {
      throw new Error("nome de pasta ou arquivo inválido");
    }
    const folder = path.join(config.cutsRoot, file.materialFolder);
    if (!isInside(folder, config.cutsRoot)) throw new Error("fora de _CORTES");

    const location = await locate(folder, file.fileName);
    const ok = path.join(folder, "OK", file.fileName);
    const hist = path.join(folder, "OK", "HIST", file.fileName);

    let from = null;
    let to = null;
    if (file.wantHist && location === "OK") [from, to] = [ok, hist];
    if (!file.wantHist && location === "HIST") [from, to] = [hist, ok];
    if (!from) return { ...base, location };

    if (await exists(to)) {
      return {
        ...base,
        location,
        error: `já existe um arquivo com esse nome em ${file.wantHist ? "OK\\HIST" : "OK"}`,
      };
    }
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
    return { ...base, location: file.wantHist ? "HIST" : "OK", moved: true };
  } catch (e) {
    const msg = String((e && e.message) || e);
    let location = "AUSENTE";
    if (isPlainName(file.materialFolder) && isPlainName(file.fileName)) {
      try {
        location = await locate(path.join(config.cutsRoot, file.materialFolder), file.fileName);
      } catch {}
    }
    return { ...base, location, error: msg.slice(0, 900) };
  }
}

function startCutFileWatch({ readConfig, log }) {
  let stopped = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Erro repetido não enche o log: só quando muda.
  const lastError = new Map();

  (async () => {
    // Deixa o laço de envio subir primeiro.
    await sleep(15_000);
    while (!stopped) {
      try {
        const config = await readConfig();
        if (config.cutsRoot && config.erpApiUrl && config.apiKey) {
          const { files } = await post(config, "/indexer/cut-sends/files/watch", {}, REQUEST_TIMEOUT_MS);
          const results = [];
          for (const file of files || []) {
            const r = await reconcileOne(file, config);
            if (r.moved) {
              log("info", `[ok] ${file.materialFolder}\\${r.location === "HIST" ? "OK -> OK\\HIST" : "OK\\HIST -> OK"}: ${file.fileName}`);
            }
            if (r.error && lastError.get(file.id) !== r.error) {
              log("warn", `[ok] ${file.materialFolder}\\${file.fileName}: ${r.error}`);
            }
            if (r.error) lastError.set(file.id, r.error);
            else lastError.delete(file.id);
            results.push({ id: r.id, location: r.location, error: r.error || null });
          }
          if (results.length) {
            await post(config, "/indexer/cut-sends/files/locations", { files: results }, REQUEST_TIMEOUT_MS);
          }
        }
      } catch (e) {
        log("warn", `[ok] vigia da pasta OK: ${e.message}`);
      }
      await sleep(INTERVAL_MS);
    }
  })();

  return () => {
    stopped = true;
  };
}

module.exports = { startCutFileWatch, reconcileOne, locate };
