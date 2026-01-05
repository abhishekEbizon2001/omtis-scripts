import axios from "axios";
import Bottleneck from "bottleneck";
import { generateOAuthHeaders } from "../config/netsuite.js";

// =========================
// Shared NetSuite Rate Limiter
// =========================
const limiter = new Bottleneck({
  maxConcurrent: 1,   // NetSuite-safe
  minTime: 1200       // ~1.2s between requests
});

// =========================
// Shared Request Helper
// =========================
export async function netsuiteRequest(
  { method = "GET", url, headers = {}, data = null, timeout = 30000 },
  retries = 3
) {
  try {
    return await limiter.schedule(() =>
      axios({
        method,
        url,
        headers: {
          ...headers,
          Authorization: generateOAuthHeaders(url, method)
        },
        data,
        timeout
      })
    );
  } catch (err) {
    if (err.response?.status === 429 && retries > 0) {
      const wait = (4 - retries) * 5000;
      console.warn(`⚠️ NetSuite 429 – retrying in ${wait} ms`);
      await new Promise(r => setTimeout(r, wait));
      return netsuiteRequest({ method, url, headers, data, timeout }, retries - 1);
    }
    throw err;
  }
}
