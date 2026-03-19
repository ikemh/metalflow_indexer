const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const BASE_DIR = process.env.BASE_DIR
  ? path.resolve(process.env.BASE_DIR)
  : path.join(__dirname, 'teste-clientes');

const OUTPUT_FILE = process.env.OUTPUT_FILE
  ? path.resolve(process.env.OUTPUT_FILE)
  : null;

const VALID_EXTENSIONS = new Set(['.dxf']);

function normalizeText(value) {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePathSeparators(value) {
  return value.split(path.sep).join('/');
}

function buildStableId(customerFolder, relativePath) {
  return crypto
    .createHash('sha1')
    .update(`${customerFolder}::${relativePath}`)
    .digest('hex');
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function getDirectoryEntries(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Falha ao ler diretório "${dir}": ${error.message}`);
  }
}

async function collectFilesRecursive(dir, rootDir, collector, warnings) {
  let entries;

  try {
    entries = await getDirectoryEntries(dir);
  } catch (error) {
    warnings.push({
      type: 'READ_DIR_ERROR',
      dir,
      message: error.message,
    });
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await collectFilesRecursive(fullPath, rootDir, collector, warnings);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();

    if (!VALID_EXTENSIONS.has(extension)) {
      continue;
    }

    try {
      const stats = await fs.stat(fullPath);
      const relativePath = normalizePathSeparators(path.relative(rootDir, fullPath));
      const fileName = normalizeText(path.basename(fullPath));
      const customerFolder = normalizeText(relativePath.split('/')[0] || '');

      collector.push({
        id: buildStableId(customerFolder, relativePath),
        customerFolder,
        fileName,
        relativePath,
        extension,
        sizeBytes: stats.size,
        lastModifiedAt: stats.mtime.toISOString(),
      });
    } catch (error) {
      warnings.push({
        type: 'STAT_FILE_ERROR',
        filePath: fullPath,
        message: error.message,
      });
    }
  }
}

function buildSummary(files, warnings, startedAt) {
  const uniqueCustomers = new Set(files.map((file) => file.customerFolder));
  const duplicateKeys = new Map();

  for (const file of files) {
    const key = `${file.customerFolder}::${file.fileName.toLowerCase()}`;
    duplicateKeys.set(key, (duplicateKeys.get(key) || 0) + 1);
  }

  const duplicateFileNames = Array.from(duplicateKeys.entries())
    .filter(([, count]) => count > 1)
    .map(([key, count]) => {
      const [customerFolder, fileName] = key.split('::');
      return { customerFolder, fileName, count };
    });

  return {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    baseDir: BASE_DIR,
    totalCustomers: uniqueCustomers.size,
    totalFiles: files.length,
    totalWarnings: warnings.length,
    duplicateFileNames,
  };
}

async function main() {
  const startedAt = Date.now();

  if (!(await pathExists(BASE_DIR))) {
    throw new Error(`Diretório base não encontrado: ${BASE_DIR}`);
  }

  const baseStats = await fs.stat(BASE_DIR);
  if (!baseStats.isDirectory()) {
    throw new Error(`BASE_DIR não é um diretório: ${BASE_DIR}`);
  }

  const rootEntries = await getDirectoryEntries(BASE_DIR);

  const customerDirs = rootEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      folderName: normalizeText(entry.name),
      fullPath: path.join(BASE_DIR, entry.name),
    }))
    .sort((a, b) => a.folderName.localeCompare(b.folderName, 'pt-BR'));

  const files = [];
  const warnings = [];

  for (const customerDir of customerDirs) {
    await collectFilesRecursive(customerDir.fullPath, BASE_DIR, files, warnings);
  }

  files.sort((a, b) => {
    const byCustomer = a.customerFolder.localeCompare(b.customerFolder, 'pt-BR');
    if (byCustomer !== 0) return byCustomer;

    return a.relativePath.localeCompare(b.relativePath, 'pt-BR');
  });

  const payload = {
    summary: buildSummary(files, warnings, startedAt),
    files,
    warnings,
  };

  const json = JSON.stringify(payload, null, 2);

  if (OUTPUT_FILE) {
    await fs.writeFile(OUTPUT_FILE, json, 'utf8');
    console.log(`Indexação concluída. Arquivo salvo em: ${OUTPUT_FILE}`);
    console.log(JSON.stringify(payload.summary, null, 2));
    return;
  }

  console.log(json);
}

main().catch((error) => {
  console.error('Erro fatal na indexação:');
  console.error(error.message);
  process.exit(1);
});
