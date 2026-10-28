const $ = (id) => document.getElementById(id);
const token = location.hash.slice(1) || sessionStorage.getItem("pilot-token");
if (location.hash) {
  sessionStorage.setItem("pilot-token", token);
  history.replaceState(null, "", "/");
}
let active = null,
  bot = null,
  epoch = 0,
  stream;
async function api(path, options = {}) {
  const r = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error);
  return body;
}
function clear() {
  epoch++;
  stream?.abort();
  active = null;
  bot = null;
  $("workspace").hidden = true;
  $("messages").replaceChildren();
  $("memory").textContent = "";
  $("roster").replaceChildren();
}
async function refresh() {
  const data = await api("/api/spaces");
  $("identity").textContent = `Signed in as ${data.user}`;
  $("spaces").replaceChildren();
  for (const s of data.spaces) {
    const b = document.createElement("button");
    b.textContent = s.name;
    b.onclick = () => open(s).catch(fail);
    $("spaces").append(b);
  }
}
function fail(e) {
  clear();
  $("status").textContent = e.message;
  refresh().catch(() => {});
}
async function conversation(version) {
  const rows = await api(`/api/spaces/${active}/thread/${bot}`);
  if (version !== epoch) return;
  $("messages").replaceChildren();
  for (const m of rows) {
    const li = document.createElement("li");
    li.textContent = `${m.blocks[0].authorId || "Team assistant"}: ${m.blocks[0].text}`;
    $("messages").append(li);
  }
}
async function open(s) {
  clear();
  active = s.id;
  const version = epoch;
  const snapshot = await api(`/api/spaces/${s.id}/snapshot`);
  if (version !== epoch) return;
  bot = snapshot.agents[0]?.bot_id;
  if (!bot) throw new Error("No agent available");
  $("workspace").hidden = false;
  $("title").textContent = s.name;
  $("status").textContent = "";
  $("audience").textContent = snapshot.agents[0].shared
    ? "Visible to every member of this workspace"
    : "Private to this account";
  $("agents").textContent = snapshot.agents[0].name;
  await conversation(version);
  const memory = await api(`/api/spaces/${s.id}/memory/${bot}`);
  if (version !== epoch) return;
  $("memory").textContent = memory.map((m) => m.content).join("\n");
  $("members").hidden = snapshot.role !== "owner";
  if (snapshot.role === "owner") {
    const members = await api(`/api/spaces/${s.id}/members`);
    if (version !== epoch) return;
    for (const member of members) {
      const row = document.createElement("p");
      row.textContent = `${member.userId} (${member.role}) `;
      if (member.role !== "owner") {
        const b = document.createElement("button");
        b.textContent = "Remove access";
        b.onclick = async () => {
          try {
            await api(`/api/spaces/${s.id}/members/${member.userId}`, { method: "DELETE" });
            await open(s);
          } catch (e) {
            fail(e);
          }
        };
        row.append(b);
      }
      $("roster").append(row);
    }
  }
  stream = new AbortController();
  const controller = stream;
  (async () => {
    const r = await fetch(`/api/spaces/${s.id}/stream`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!r.ok) throw new Error("Access removed");
    const reader = r.body.getReader();
    let pending = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += new TextDecoder().decode(value);
      while (true) {
        const end = pending.indexOf("\n\n");
        if (end < 0) break;
        const event = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (version !== epoch) return;
        if (event.includes("event: revoked")) throw new Error("Access removed");
        if (event.includes("event: tick")) await conversation(version);
      }
    }
  })().catch((e) => {
    if (e.name !== "AbortError" && version === epoch) fail(e);
  });
}
$("send").onsubmit = async (e) => {
  e.preventDefault();
  const version = epoch;
  const space = active;
  try {
    const job = await api(`/api/spaces/${space}/jobs/${bot}`, {
      method: "POST",
      body: JSON.stringify({ text: $("text").value, nonce: crypto.randomUUID() }),
    });
    if (version !== epoch) return;
    await api(`/api/spaces/${space}/run/${job.id}`, { method: "POST" });
    if (version !== epoch) return;
    $("text").value = "";
    await conversation(version);
  } catch (error) {
    fail(error);
  }
};
refresh().catch(fail);
