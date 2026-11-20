// Generates LOCAL DEVELOPMENT keys into .dev-keys/ (gitignored). Never use these anywhere else.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

if (process.env.NODE_ENV === "production") throw new Error("dev-keys refuses to run in production");
const dir = ".dev-keys";
mkdirSync(dir, { recursive: true, mode: 0o700 });
const write = (name, data) => {
  const path = `${dir}/${name}`;
  try {
    // "wx" fails if the file exists, so an existing key is never overwritten (no check-then-write race).
    writeFileSync(path, data, { mode: 0o600, flag: "wx" });
    console.log(`wrote ${path}`);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    console.log(`kept ${path}`);
  }
};
write("master-key.hex", randomBytes(32).toString("hex"));
write("api-key-pepper.hex", randomBytes(32).toString("hex"));
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
write("internal-signing.pem", privateKey.export({ type: "pkcs8", format: "pem" }));
write("internal-signing.pub.pem", publicKey.export({ type: "spki", format: "pem" }));
