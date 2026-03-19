"use strict";

/**
 * Envia o índice de arquivos de um mapeamento para o ERP.
 * @param {string} erpApiUrl
 * @param {string} apiKey
 * @param {string} customerId
 * @param {Array}  files
 * @returns {Promise<{ ok: boolean, synced?: number, error?: string }>}
 */
async function pushFilesToErp(erpApiUrl, apiKey, customerId, files) {
  const url = `${erpApiUrl.replace(/\/$/, "")}/indexer/sync`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ customerId, files }),
    });
  } catch (networkError) {
    return { ok: false, error: `Falha de rede: ${networkError.message}` };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${text}` };
  }

  const data = await res.json().catch(() => ({}));
  return { ok: true, synced: data.synced ?? files.length };
}

module.exports = { pushFilesToErp };
