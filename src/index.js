import { neon } from "@neondatabase/serverless";

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "content-type": "application/json",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

/** DATABASE_URL veya alternatif isimler */
function getDatabaseUrl(env) {
  if (!env) return null;
  return (
    env.DATABASE_URL ||
    env.DATABASE_URL_PROD ||
    env.NEON_DATABASE_URL ||
    env.POSTGRES_URL ||
    env.DB_URL ||
    null
  );
}

function sqlClient(env) {
  const url = getDatabaseUrl(env);
  if (!url) throw new Error("DATABASE_URL yok (secret tanimli degil)");
  return neon(url);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/api/health" || url.pathname === "/") {
        const dbUrl = getDatabaseUrl(env);
        const envKeys = env && typeof env === "object" ? Object.keys(env) : [];
        let dbOk = false;
        let dbError = null;
        if (dbUrl) {
          try {
            const sql = neon(dbUrl);
            const r = await sql`select 1 as x`;
            dbOk = r?.[0]?.x === 1;
          } catch (e) {
            dbError = String(e.message || e);
          }
        }
        return json({
          ok: true,
          hasDb: Boolean(dbUrl),
          dbOk,
          dbError,
          envKeys,
          message: dbOk
            ? "API + Neon OK"
            : dbUrl
              ? "Secret var ama Neon sorgu hatasi"
              : "Secret yok — Cloudflare'de DATABASE_URL ekleyin ve Redeploy yapin",
        });
      }

      const dbUrl = getDatabaseUrl(env);
      const sql = dbUrl ? neon(dbUrl) : null;

      if (url.pathname === "/api/login" && request.method === "POST") {
        if (!sql) return json({ ok: false, error: "DATABASE_URL yok" }, 500);
        const body = await request.json().catch(() => ({}));
        const username = (body.username || "").trim();
        const password = body.password || "";
        const rows = await sql`
          select username, name, role, wa, password_hash
          from users where username = ${username} limit 1
        `;
        const u = rows[0];
        if (!u || u.password_hash !== password) {
          return json({ ok: false, error: "Hatali giris" }, 401);
        }
        return json({
          ok: true,
          source: "neon",
          user: { username: u.username, name: u.name, role: u.role, wa: u.wa || "" },
        });
      }

      if (url.pathname === "/api/users" && request.method === "GET") {
        if (!sql) return json({ ok: false, error: "DATABASE_URL yok" }, 500);
        const rows = await sql`
          select username, name, role, wa, active, created_at from users order by username
        `;
        return json({ ok: true, users: rows });
      }

      if (url.pathname === "/api/users" && request.method === "POST") {
        if (!sql) return json({ ok: false, error: "DATABASE_URL yok" }, 500);
        const body = await request.json().catch(() => ({}));
        const username = (body.username || "").trim();
        const name = (body.name || "").trim();
        const role = body.role === "admin" ? "admin" : "saha";
        const password = body.password || "";
        const wa = (body.wa || "").trim() || null;
        if (!username || !name || !password) {
          return json({ ok: false, error: "username, name, password gerekli" }, 400);
        }
        await sql`
          insert into users (username, name, role, password_hash, wa, active)
          values (${username}, ${name}, ${role}, ${password}, ${wa}, true)
        `;
        return json({ ok: true, user: { username, name, role, wa: wa || "" } });
      }

      if (url.pathname === "/api/customers" && request.method === "GET") {
        if (!sql) return json({ ok: false, error: "DATABASE_URL yok" }, 500);
        const rows = await sql`
          select id, name, contact, phone, email, address, created_at from customers order by name
        `;
        return json({ ok: true, customers: rows });
      }

      if (url.pathname === "/api/customers" && request.method === "POST") {
        if (!sql) return json({ ok: false, error: "DATABASE_URL yok" }, 500);
        const body = await request.json().catch(() => ({}));
        const name = (body.name || "").trim();
        if (!name) return json({ ok: false, error: "name gerekli" }, 400);
        const contact = (body.contact || "").trim() || null;
        const phone = (body.phone || "").trim() || null;
        const email = (body.email || "").trim() || null;
        const address = (body.address || "").trim() || null;
        const rows = await sql`
          insert into customers (name, contact, phone, email, address)
          values (${name}, ${contact}, ${phone}, ${email}, ${address})
          returning id, name, contact, phone, email, address
        `;
        return json({ ok: true, customer: rows[0] });
      }

      if (url.pathname === "/api/equipment" && request.method === "GET") {
        if (!sql) return json({ ok: false, error: "DATABASE_URL yok" }, 500);
        const rows = await sql`
          select id, name, location, customer_id, brand, model, serial_no,
                 lat, lng, period_months, last_maint, next_maint,
                 device_id, mqtt_topic, status, online, floor, alarm, last_seen
          from equipment order by name
        `;
        return json({ ok: true, equipment: rows });
      }

      if (url.pathname === "/api/equipment" && request.method === "POST") {
        if (!sql) return json({ ok: false, error: "DATABASE_URL yok" }, 500);
        const body = await request.json().catch(() => ({}));
        const name = (body.name || "").trim();
        const deviceId = (body.device_id || body.deviceId || "").trim();
        if (!name || !deviceId) return json({ ok: false, error: "name ve device_id gerekli" }, 400);
        const token = (body.device_token || body.deviceToken || ("tok_" + crypto.randomUUID())).trim();
        const location = (body.location || "").trim() || null;
        const cust = body.customer_id || body.customerId || null;
        const brand = body.brand || null;
        const model = body.model || null;
        const lat = body.lat ?? null;
        const lng = body.lng ?? null;
        const period = body.period_months || body.period || 3;
        const nextMaint = body.next_maint || body.nextMaint || null;
        const topic = body.mqtt_topic || body.mqttTopic || ("helpas/v1/site/" + deviceId + "/telemetry");
        const rows = await sql`
          insert into equipment (
            name, location, customer_id, brand, model,
            lat, lng, period_months, next_maint,
            device_id, device_token_hash, mqtt_topic, status, online, floor
          ) values (
            ${name}, ${location}, ${cust}, ${brand}, ${model},
            ${lat}, ${lng}, ${period}, ${nextMaint},
            ${deviceId}, ${token}, ${topic}, 'ok', false, 1
          )
          returning id, name, location, device_id, status
        `;
        return json({ ok: true, equipment: rows[0], device_token: token });
      }

      if (url.pathname === "/api/telemetry" && request.method === "POST") {
        if (!sql) return json({ ok: false, error: "DATABASE_URL yok" }, 500);
        const body = await request.json().catch(() => ({}));
        const deviceId = (body.device_id || "").trim();
        if (!deviceId) return json({ ok: false, error: "device_id gerekli" }, 400);
        const status = body.status || "ok";
        const floor = body.floor ?? null;
        const alarm = body.alarm ?? null;
        const online = body.online !== false;
        await sql`
          update equipment set
            status = ${status},
            floor = coalesce(${floor}, floor),
            alarm = ${alarm},
            online = ${online},
            last_seen = now()
          where device_id = ${deviceId}
        `;
        await sql`
          insert into telemetry_latest (device_id, payload, received_at)
          values (${deviceId}, ${JSON.stringify(body)}::jsonb, now())
          on conflict (device_id) do update
          set payload = excluded.payload, received_at = now()
        `;
        return json({ ok: true });
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  },
};
