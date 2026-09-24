// Encrypt stdin with the LEAGUE_KEY passphrase so private-league data can ride along on the public site.
// AES-256-GCM, key from PBKDF2-SHA256; the page decrypts with WebCrypto using the same parameters.
const crypto = require("crypto");
const key = process.env.LEAGUE_KEY;
if (!key) {
  console.error("LEAGUE_KEY not set");
  process.exit(2);
}
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const iter = 250000,
    salt = crypto.randomBytes(16),
    iv = crypto.randomBytes(12);
  const k = crypto.pbkdf2Sync(key, salt, iter, 32, "sha256");
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(input, "utf8"), c.final(), c.getAuthTag()]); // WebCrypto expects the tag appended
  process.stdout.write(
    JSON.stringify({ v: 1, iter, salt: salt.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64") }),
  );
});
