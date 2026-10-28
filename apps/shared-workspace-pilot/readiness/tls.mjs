import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import pg from "../node_modules/pg/lib/index.js";

const base = new URL("../.local/release-proof/tls/", import.meta.url);
await mkdir(base, { recursive: true, mode: 0o700 });
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    new URL("server.key", base).pathname,
    "-out",
    new URL("server.crt", base).pathname,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ],
  { stdio: "pipe" },
);
const docker = (...args) => execFileSync("docker", args, { stdio: "pipe" }),
  sql = (q) =>
    docker(
      "exec",
      "rakazo-orb-release-proof",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      q,
    );
const hba = docker(
  "exec",
  "rakazo-orb-release-proof",
  "cat",
  "/var/lib/postgresql/data/pg_hba.conf",
);
const reader = JSON.parse(
  await readFile(new URL("../.local/release-proof/reader.json", import.meta.url), "utf8"),
);
assert.equal(new URL(reader.url).port, "15444");
const results = {};
try {
  docker("exec", "rakazo-orb-release-proof", "mkdir", "-p", "/tmp/readiness-tls");
  for (const f of ["server.key", "server.crt"])
    docker("cp", new URL(f, base).pathname, `rakazo-orb-release-proof:/tmp/readiness-tls/${f}`);
  docker(
    "exec",
    "rakazo-orb-release-proof",
    "chown",
    "-R",
    "postgres:postgres",
    "/tmp/readiness-tls",
  );
  docker("exec", "rakazo-orb-release-proof", "chmod", "600", "/tmp/readiness-tls/server.key");
  sql("ALTER SYSTEM SET ssl_cert_file='/tmp/readiness-tls/server.crt'");
  sql("ALTER SYSTEM SET ssl_key_file='/tmp/readiness-tls/server.key'");
  sql("ALTER SYSTEM SET ssl='on'");
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "rakazo-orb-release-proof",
      "sh",
      "-c",
      "cat > /var/lib/postgresql/data/pg_hba.conf",
    ],
    {
      input: Buffer.concat([
        Buffer.from("hostnossl all all 0.0.0.0/0 reject\nhostnossl all all ::0/0 reject\n"),
        hba,
      ]),
    },
  );
  sql("SELECT pg_reload_conf()");
  await new Promise((r) => setTimeout(r, 1000));
  const plain = new pg.Client({ connectionString: reader.url, connectionTimeoutMillis: 2000 });
  await assert.rejects(
    () => plain.connect(),
    (e) => e.code === "28000",
  );
  await plain.end().catch(() => {});
  results.plaintextRejected = true;
  const untrusted = new pg.Client({
    connectionString: reader.url,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 2000,
  });
  await assert.rejects(
    () => untrusted.connect(),
    (e) => ["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"].includes(e.code),
  );
  await untrusted.end().catch(() => {});
  results.untrustedCertificateRejected = true;
  const client = new pg.Client({
    connectionString: reader.url,
    ssl: { rejectUnauthorized: true, ca: await readFile(new URL("server.crt", base), "utf8") },
    connectionTimeoutMillis: 2000,
  });
  await client.connect();
  assert.equal(client.connection.stream.authorized, true);
  assert.equal(
    (await client.query("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()")).rows[0].ssl,
    true,
  );
  await client.end();
  results.verifiedTlsAndEncryptedDatabaseLeg = true;
  await writeFile(
    new URL("../.local/readiness-tls-results.json", import.meta.url),
    JSON.stringify(
      { environment: "isolated PostgreSQL 16 only; no ORB setting changed", results },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(results));
} finally {
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "rakazo-orb-release-proof",
      "sh",
      "-c",
      "cat > /var/lib/postgresql/data/pg_hba.conf",
    ],
    { input: hba },
  );
  sql("ALTER SYSTEM RESET ssl");
  sql("ALTER SYSTEM RESET ssl_cert_file");
  sql("ALTER SYSTEM RESET ssl_key_file");
  sql("SELECT pg_reload_conf()");
}
