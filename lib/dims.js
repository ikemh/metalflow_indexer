"use strict";

/**
 * Medidas dos DXF (largura × altura da caixa envolvente, em mm).
 *
 * São a escala da miniatura no tablet da fábrica: o viewer do Diosef escrevia
 * "L: 280.0mm | A: 32.5mm" embaixo de cada desenho e era pelo tamanho que se
 * achava a lâmina na pilha. Só o varejo e o catálogo são medidos — é o que a
 * fábrica separa; os ~42 mil DXF do atacado ficam de fora.
 *
 * Medir custa ~0,1 s por arquivo (abrir o DXF é o grosso), então cada medida
 * fica em `data/dims.json`, pela id do arquivo + tamanho + data: só arquivo
 * novo ou alterado é medido de novo. Um processo Python mede o lote todo
 * (`dxf-dims`, caminhos pelo stdin) para não importar o ezdxf a cada arquivo.
 *
 * Falha aqui nunca segura o sync: arquivo sem medida sobe sem medida.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs/promises");

const IS_WIN = process.platform === "win32";
const PYTHON = process.env.INDEXER_PYTHON || (IS_WIN ? "python" : "python3");
const PYTHON_ARGS_PREFIX = (process.env.INDEXER_PYTHON_ARGS || "")
  .split(" ")
  .map((s) => s.trim())
  .filter(Boolean);

const DXF_DIMS = path.join(__dirname, "..", "dxf-dims");
const CACHE_PATH = path.join(__dirname, "..", "data", "dims.json");
/** Sem resposta por este tempo, o arquivo da vez é dado como travado. */
const STALL_MS = 60_000;

/** Fontes medidas. A versão entra na chave da assinatura da pasta: trocar
 * força um sync completo de cada pasta medida, que é como as medidas chegam
 * a arquivos já indexados (o sync pula pasta que não mudou). */
const MEASURED = new Set(["VAREJO", "CATALOGO"]);
const DIMS_VERSION = "dims1";

let cache = null;

async function loadCache() {
  if (cache) return cache;
  try {
    cache = new Map(Object.entries(JSON.parse(await fs.readFile(CACHE_PATH, "utf8"))));
  } catch {
    cache = new Map();
  }
  return cache;
}

async function saveCache() {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  const tmp = `${CACHE_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(cache)), "utf8");
  await fs.rename(tmp, CACHE_PATH);
}

function isDxf(file) {
  return /\.dxf$/i.test(file.fileName || "");
}

function stamp(file) {
  return `${file.sizeBytes}|${file.lastModifiedAt}`;
}

/**
 * Roda o `dxf-dims` sobre os caminhos. Resolve com Map caminho → resultado.
 * Nunca rejeita: o que não respondeu simplesmente não está no Map.
 */
function measureBatch(paths, log) {
  return new Promise((resolve) => {
    const results = new Map();
    let buf = "";
    let stallTimer = null;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (stallTimer) clearTimeout(stallTimer);
      resolve(results);
    };

    let proc;
    try {
      proc = spawn(PYTHON, [...PYTHON_ARGS_PREFIX, DXF_DIMS], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
    } catch (err) {
      log("warn", `[dims] não iniciou: ${err.message}`);
      finish();
      return;
    }

    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        // O arquivo seguinte ao último respondido é o travado: marca como
        // erro para não travar de novo no próximo ciclo.
        const stuck = paths[results.size];
        if (stuck) results.set(stuck, { error: "tempo esgotado" });
        log("warn", `[dims] travou em ${stuck ? path.basename(stuck) : "?"}; resto fica para o próximo ciclo`);
        try {
          proc.kill();
        } catch {}
        finish();
      }, STALL_MS);
    };

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          if (r && typeof r.path === "string") results.set(r.path, r);
        } catch {}
      }
      armStall();
    });
    proc.stderr.on("data", () => {});
    proc.on("error", (err) => {
      log("warn", `[dims] erro do processo: ${err.message}`);
      finish();
    });
    proc.on("close", finish);
    proc.stdin.on("error", () => {});

    armStall();
    proc.stdin.end(paths.join("\n") + "\n", "utf8");
  });
}

/**
 * Preenche `widthMm`/`heightMm` nos arquivos (in place) e devolve quantos
 * foram medidos agora. Fonte fora de MEASURED não é tocada.
 */
async function attachDims(files, sourceType, log = () => {}) {
  if (!MEASURED.has(sourceType)) return { measured: 0, failed: 0 };
  const c = await loadCache();

  const pending = [];
  for (const f of files) {
    if (!isDxf(f) || !f.absolutePath) continue;
    const hit = c.get(f.id);
    if (hit && hit.s === stamp(f)) {
      if (hit.w != null) {
        f.widthMm = hit.w;
        f.heightMm = hit.h;
      }
      continue;
    }
    pending.push(f);
  }
  if (!pending.length) return { measured: 0, failed: 0 };

  const started = Date.now();
  const results = await measureBatch(pending.map((f) => f.absolutePath), log);
  let measured = 0;
  let failed = 0;
  for (const f of pending) {
    const r = results.get(f.absolutePath);
    if (!r) continue; // não respondeu: tenta no próximo ciclo
    if (typeof r.widthMm === "number" && typeof r.heightMm === "number") {
      f.widthMm = r.widthMm;
      f.heightMm = r.heightMm;
      c.set(f.id, { s: stamp(f), w: r.widthMm, h: r.heightMm });
      measured++;
    } else {
      // DXF que não abre não melhora sozinho: guardado para não remedir
      // até o arquivo mudar.
      c.set(f.id, { s: stamp(f), w: null, h: null });
      failed++;
    }
  }
  try {
    await saveCache();
  } catch (err) {
    log("warn", `[dims] não salvou o cache: ${err.message}`);
  }
  log(
    "info",
    `[dims] ${sourceType}: medidos=${measured} falhas=${failed} pendentes=${pending.length - measured - failed} em ${Math.round((Date.now() - started) / 1000)}s`,
  );
  return { measured, failed };
}

/** Chave da assinatura de pasta, com a versão das medidas onde se mede. */
function withDimsVersion(sigKey, sourceType) {
  return MEASURED.has(sourceType) ? `${sigKey}::${DIMS_VERSION}` : sigKey;
}

module.exports = { attachDims, withDimsVersion };
