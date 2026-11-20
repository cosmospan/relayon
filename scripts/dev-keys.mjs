// Generates LOCAL DEVELOPMENT keys into .dev-keys/ (gitignored). Never use these anywhere else.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

if (process.env.NODE_ENV === "production") throw new Error("dev-keys refuses to run in production");
const dir = ".dev-keys";
mkdirSync(dir, { recursive: true, mode: 0o700 });
const write = (name, data) => {
  const path = `${dir}/${name}`;
  if (existsSync(path)) return console.log(`kept ${path}`);
  writeFileSync(path, data, { mode: 0o600 });
  console.log(`wrote ${path}`);
};
write("master-key.hex", randomBytes(32).toString("hex"));
write("api-key-pepper.hex", randomBytes(32).toString("hex"));
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
write("internal-signing.pem", privateKey.export({ type: "pkcs8", format: "pem" }));
write("internal-signing.pub.pem", publicKey.export({ type: "spki", format: "pem" }));
