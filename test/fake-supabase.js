// 시험용 가짜 Supabase 클라이언트: 요청을 SQL로 바꿔 시험 서버(PGlite, 실제 setup.sql과 권한)로 보낸다
(() => {
  const S = { get session() { try { return JSON.parse(localStorage.getItem("fake-session") || "null"); } catch (e) { return null; } }, set session(v) { if (v) localStorage.setItem("fake-session", JSON.stringify(v)); else localStorage.removeItem("fake-session"); } };
  const users = () => { try { return JSON.parse(localStorage.getItem("fake-users") || "{}"); } catch (e) { return {}; } };
  const claims = () => { const s = S.session; return s ? { sub: s.user.id, is_anonymous: !!s.user.is_anonymous, role: "authenticated" } : { role: "anon" }; };
  const run = async (text, params) => window.__sql(claims(), text, params || []);
  const ident = (c) => '"' + String(c).replace(/"/g, '""') + '"';
  const val = (v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);

  class Q {
    constructor(t) { this.t = t; this.op = "select"; this.cols = "*"; this.wh = []; this.ret = null; this.ord = null; this.rng = null; }
    select(c) { if (this.op === "select") this.cols = c || "*"; else this.ret = c || "*"; return this; }
    insert(row) { this.op = "insert"; this.row = row; return this; }
    update(p) { this.op = "update"; this.patch = p; return this; }
    delete() { this.op = "delete"; return this; }
    eq(c, v) { this.wh.push([c, v]); return this; }
    order(c) { this.ord = c; return this; }
    range(a, b) { this.rng = [a, b]; return this; }
    then(res, rej) { return this.exec().then(res, rej); }
    async exec() {
      const ps = []; const p = (v) => { ps.push(val(v)); return "$" + ps.length; };
      const where = this.wh.length ? " where " + this.wh.map(([c, v]) => `${ident(c)} = ${p(v)}`).join(" and ") : "";
      const cols = (c) => (c === "*" ? "*" : c.split(",").map((x) => ident(x.trim())).join(","));
      let q;
      if (this.op === "select") q = `select ${cols(this.cols)} from public.${this.t}${where}${this.ord ? ` order by ${ident(this.ord)}` : ""}${this.rng ? ` limit ${this.rng[1] - this.rng[0] + 1} offset ${this.rng[0]}` : ""}`;
      else if (this.op === "insert") { const ks = Object.keys(this.row); q = `insert into public.${this.t} (${ks.map(ident).join(",")}) values (${ks.map((k) => p(this.row[k])).join(",")})${this.ret ? ` returning ${cols(this.ret)}` : ""}`; }
      else if (this.op === "update") { const ks = Object.keys(this.patch); q = `update public.${this.t} set ${ks.map((k) => `${ident(k)} = ${p(this.patch[k])}`).join(", ")}${where}${this.ret ? ` returning ${cols(this.ret)}` : ""}`; }
      else q = `delete from public.${this.t}${where}${this.ret ? ` returning ${cols(this.ret)}` : ""}`;
      const r = await run(q, ps);
      if (r.error) return { data: null, error: r.error };
      return { data: this.op === "select" || this.ret ? r.rows.map(fix) : null, error: null };
    }
  }
  // 날짜 객체를 문자열로 (실제 서버 응답처럼)
  const fix = (row) => { const o = {}; for (const [k, v] of Object.entries(row)) o[k] = v instanceof Date ? (k === "deadline" ? v.toISOString().slice(0, 10) : v.toISOString()) : v; return o; };

  const client = {
    auth: {
      async getSession() { return { data: { session: S.session } }; },
      async signInAnonymously() { const s = { user: { id: crypto.randomUUID(), is_anonymous: true } }; S.session = s; return { data: { session: s }, error: null }; },
      async signUp({ email, password }) { const u = users(); if (u[email]) return { data: {}, error: { message: "User already registered" } }; u[email] = { id: crypto.randomUUID(), pw: password }; localStorage.setItem("fake-users", JSON.stringify(u)); const s = { user: { id: u[email].id, email, is_anonymous: false } }; S.session = s; return { data: { session: s }, error: null }; },
      async signInWithPassword({ email, password }) { const u = users()[email]; if (!u || u.pw !== password) return { data: {}, error: { message: "Invalid login credentials" } }; const s = { user: { id: u.id, email, is_anonymous: false } }; S.session = s; return { data: { session: s }, error: null }; },
      async signOut() { S.session = null; return { error: null }; }
    },
    from: (t) => new Q(t),
    async rpc(fn, args) {
      const ks = Object.keys(args || {}); const ps = ks.map((k) => val(args[k]));
      const r = await run(`select public.${fn}(${ks.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, ps);
      if (r.error) return { data: null, error: r.error };
      return { data: r.rows[0] ? r.rows[0].r : null, error: null };
    },
    channel() { const ch = { on() { return ch; }, subscribe(cb) { if (cb) setTimeout(() => cb("SUBSCRIBED"), 0); return ch; } }; return ch; },
    removeChannel() {}
  };
  // vendor/supabase.js가 window.supabase를 덮어쓰지 못하게
  Object.defineProperty(window, "supabase", { value: { createClient: () => client }, writable: false, configurable: false });
})();
