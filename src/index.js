import { neon } from "@neondatabase/serverless";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "content-type": "application/json",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: cors });

    if (url.pathname === "/api/health" || url.pathname === "/") {
      let dbOk = false;
      let dbError = null;
      if (env.DATABASE_URL) {
        try {
          const sql = neon(env.DATABASE_URL);
          const r = await sql`select 1 as x`;
          dbOk = r?.[0]?.x === 1;
        } catch (e) {
          dbError = String(e.message || e);
        }
      }
      return json({
        ok: true,
        hasDb: Boolean(env.DATABASE_URL),
        dbOk,
        dbError,
        message: dbOk ? "API + Neon OK" : "Neon baglantisi yok veya hata",
      });
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      if (!env.DATABASE_URL) {
        return json({ ok: false, error: "DATABASE_URL yok" }, 500);
      }
      let body = {};
      try {
        body = await request.json();
      } catch (_) {}
      const username = (body.username || "").trim();
      const password = body.password || "";
      if (!username || !password) {
        return json({ ok: false, error: "Eksik bilgi" }, 400);
      }
      try {
        const sql = neon(env.DATABASE_URL);
        const rows = await sql`
          select username, name, role, wa, password_hash
          from users
          where username = ${username}
          limit 1
        `;
        const u = rows[0];
        if (!u || u.password_hash !== password) {
          return json({ ok: false, error: "Hatali giris" }, 401);
        }
        return json({
          ok: true,
          source: "neon",
          user: {
            username: u.username,
            name: u.name,
            role: u.role,
            wa: u.wa || "",
          },
        });
      } catch (e) {
        return json({ ok: false, error: "DB: " + (e.message || e) }, 500);
      }
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};
