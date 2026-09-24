// seal.js (run by the private repo's workflow) and the page's unseal (web/js/sync.js) must agree: AES-256-GCM with
// a PBKDF2-SHA256 key, the tag appended to the ciphertext. Decrypts here with WebCrypto exactly as the page does.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const seal = (payload, key) =>
  JSON.parse(
    execFileSync(process.execPath, [path.join(__dirname, "..", "seal.js")], {
      input: payload,
      env: { ...process.env, LEAGUE_KEY: key },
    }).toString(),
  );
const b64 = (s) => Uint8Array.from(Buffer.from(s, "base64"));
async function unseal(z, pass) {
  const { subtle } = globalThis.crypto;
  const base = await subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "PBKDF2", salt: b64(z.salt), iterations: z.iter, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: b64(z.iv) }, key, b64(z.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

test("a sealed payload opens with the right passphrase only", async () => {
  const payload = { leagues: [{ name: "Test", members: [{ team: "Ünïcode ✓", pts: 1 }] }] };
  const z = seal(JSON.stringify(payload), "correct horse");
  assert.deepEqual(Object.keys(z).sort(), ["ct", "iter", "iv", "salt", "v"]);
  assert.deepEqual(await unseal(z, "correct horse"), payload);
  await assert.rejects(unseal(z, "wrong horse"));
});
