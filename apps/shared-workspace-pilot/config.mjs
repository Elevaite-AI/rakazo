export function databaseUrl(admin = false) {
  const value = process.env[admin ? "PILOT_ADMIN_DATABASE_URL" : "PILOT_DATABASE_URL"];
  if (!value) throw new Error("Explicit PILOT database URL required");
  const u = new URL(value);
  if (u.hostname !== "127.0.0.1" || u.port !== "15439" || u.pathname !== "/rakazo_shared_pilot") {
    throw new Error("Pilot refuses any database outside its dedicated loopback instance");
  }
  return value;
}
