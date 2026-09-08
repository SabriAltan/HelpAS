import { neon } from "@neondatabase/serverless";

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-tenant",
    "content-type": "application/json",
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}
function getDatabaseUrl(env) {
  if (!env) return null;
  return env.DATABASE_URL || env.NEON_DATABASE_URL || env.POSTGRES_URL || null;
}
function tenantFrom(request, body) {
  const h = request.headers.get("x-tenant");
  if (h && h.trim()) return h.trim().toLowerCase();
  if (body && body.tenant) return String(body.tenant).trim().toLowerCase();
  return "helpas";
}

async function ensureSchema(sql) {
  await sql`create table if not exists tenants (
    code text primary key,
    name text not null,
    plan text default 'standard',
    max_equipment int default 300,
    active boolean default true,
    created_at timestamptz default now()
  )`;
  await sql`insert into tenants (code, name, plan, max_equipment)
    values ('helpas', 'HelpAS Ana', 'pro', 1000)
    on conflict (code) do nothing`;

  await sql`create table if not exists users (
    id uuid primary key default gen_random_uuid(),
    tenant_code text not null default 'helpas',
    username text not null,
    name text not null,
    role text not null default 'saha',
    password_hash text not null,
    wa text,
    sicil text,
    active boolean default true,
    created_at timestamptz default now(),
    unique (tenant_code, username)
  )`;
  try { await sql`alter table users add column if not exists tenant_code text default 'helpas'`; } catch (_) {}
  try { await sql`alter table users add column if not exists sicil text`; } catch (_) {}
  try { await sql`alter table users drop constraint if exists users_role_check`; } catch (_) {}
  // seed platform admin
  // Admin seed — mevcut unique yapisina bagimli olmadan
  try {
    const exists = await sql`select username from users where username='admin' limit 1`;
    if (!exists[0]) {
      await sql`insert into users (tenant_code, username, name, role, password_hash, sicil, active)
        values ('helpas', 'admin', 'Sabri Altan', 'admin', 'SabriAltan123', 'SCL-1', true)`;
    } else {
      await sql`update users set password_hash='SabriAltan123', role='admin', active=true,
        tenant_code=coalesce(nullif(tenant_code,''), 'helpas')
        where username='admin'`;
    }
  } catch (e) {
    console.log('admin seed', e.message || e);
  }

  await sql`create table if not exists customers (
    id uuid primary key default gen_random_uuid(),
    tenant_code text not null default 'helpas',
    name text not null,
    contact text, phone text, email text, address text,
    created_at timestamptz default now()
  )`;
  try { await sql`alter table customers add column if not exists tenant_code text default 'helpas'`; } catch (_) {}

  await sql`create table if not exists equipment (
    id uuid primary key default gen_random_uuid(),
    tenant_code text not null default 'helpas',
    name text not null,
    location text,
    customer_id uuid,
    brand text, model text, serial_no text,
    lat double precision, lng double precision,
    period_months int default 3,
    last_maint date, next_maint date,
    device_id text,
    device_token_hash text,
    mqtt_topic text,
    status text default 'ok',
    online boolean default false,
    floor int default 1,
    alarm text,
    last_seen timestamptz,
    created_at timestamptz default now()
  )`;
  try { await sql`alter table equipment add column if not exists tenant_code text default 'helpas'`; } catch (_) {}
  try {
    await sql`create unique index if not exists equipment_tenant_device_uidx on equipment (tenant_code, device_id)`;
  } catch (_) {}

  await sql`create table if not exists form_seq (
    tenant_code text not null default 'helpas',
    kind text not null,
    last_num int not null default 0,
    primary key (tenant_code, kind)
  )`;

  await sql`create table if not exists service_forms (
    id uuid primary key default gen_random_uuid(),
    tenant_code text not null default 'helpas',
    form_no text not null,
    kind text not null,
    equipment_id text,
    equipment_name text,
    customer_name text,
    tech_name text,
    tech_sicil text,
    form_date date not null,
    status text default 'open',
    priority text,
    summary text,
    technical jsonb default '{}'::jsonb,
    checklist jsonb default '[]'::jsonb,
    payment jsonb default '{}'::jsonb,
    created_at timestamptz default now(),
    completed_at timestamptz,
    unique (tenant_code, form_no)
  )`;
  try { await sql`alter table service_forms add column if not exists tenant_code text default 'helpas'`; } catch (_) {}

  await sql`create table if not exists contracts (
    id uuid primary key default gen_random_uuid(),
    tenant_code text not null default 'helpas',
    customer_id text,
    equipment_id text,
    start_date date,
    end_date date,
    monthly_fee numeric(12,2) default 0,
    period_months int default 3,
    scope text,
    status text default 'Taslak',
    created_at timestamptz default now()
  )`;
  try { await sql`alter table contracts add column if not exists tenant_code text default 'helpas'`; } catch (_) {}

  await sql`create table if not exists telemetry_latest (
    tenant_code text not null default 'helpas',
    device_id text not null,
    status text,
    floor int,
    alarm text,
    online boolean default true,
    payload jsonb default '{}'::jsonb,
    received_at timestamptz default now(),
    primary key (tenant_code, device_id)
  )`;
  await sql`create table if not exists telemetry_events (
    id bigserial primary key,
    tenant_code text not null default 'helpas',
    device_id text not null,
    event_type text not null,
    status text,
    alarm text,
    payload jsonb default '{}'::jsonb,
    created_at timestamptz default now()
  )`;
  await sql`create table if not exists crew_locations (
    tenant_code text not null default 'helpas',
    username text not null,
    name text,
    lat double precision not null,
    lng double precision not null,
    updated_at timestamptz default now(),
    primary key (tenant_code, username)
  )`;
  await sql`create table if not exists daily_backups (
    id bigserial primary key,
    tenant_code text not null default 'helpas',
    backup_date date not null,
    taken_at timestamptz default now(),
    timezone text default 'Europe/Istanbul',
    counts jsonb not null,
    snapshot jsonb not null,
    unique (tenant_code, backup_date)
  )`;
}

async function nextNo(sql, tenant, kind) {
  const prefix = kind === "pm" ? "PM" : kind === "fault" ? "ARZ" : "SCL";
  const year = new Date().getFullYear();
  const rows = await sql`
    insert into form_seq (tenant_code, kind, last_num) values (${tenant}, ${kind}, 1)
    on conflict (tenant_code, kind) do update set last_num = form_seq.last_num + 1
    returning last_num`;
  return `${prefix}-${year}-${String(rows[0].last_num).padStart(5, "0")}`;
}

async function runDailyBackup(sql) {
  await ensureSchema(sql);
  const trDate = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Istanbul" });
  const tenants = await sql`select code from tenants where active is not false`;
  const results = [];
  for (const t of tenants) {
    const tc = t.code;
    const users = await sql`select username, name, role, wa, sicil, active from users where tenant_code=${tc}`;
    const customers = await sql`select id, name, contact, phone, email, address from customers where tenant_code=${tc}`;
    const equipment = await sql`select id, name, location, customer_id, brand, model, device_id, lat, lng, period_months, next_maint, status from equipment where tenant_code=${tc}`;
    const forms = await sql`select form_no, kind, equipment_id, equipment_name, form_date, status, summary, technical, checklist, payment from service_forms where tenant_code=${tc} order by created_at desc limit 3000`;
    const counts = { users: users.length, customers: customers.length, equipment: equipment.length, forms: forms.length };
    const snapshot = { users, customers, equipment, forms };
    await sql`
      insert into daily_backups (tenant_code, backup_date, timezone, counts, snapshot)
      values (${tc}, ${trDate}, 'Europe/Istanbul', ${JSON.stringify(counts)}::jsonb, ${JSON.stringify(snapshot)}::jsonb)
      on conflict (tenant_code, backup_date) do update set taken_at=now(), counts=excluded.counts, snapshot=excluded.snapshot`;
    results.push({ tenant: tc, counts });
  }
  await sql`delete from telemetry_events where created_at < now() - interval '30 days'`;
  await sql`delete from daily_backups where backup_date < (current_date - interval '90 days')`;
  return { backup_date: trDate, results };
}

export default {
  async scheduled(event, env, ctx) {
    const dbUrl = getDatabaseUrl(env);
    if (!dbUrl) return;
    ctx.waitUntil(runDailyBackup(neon(dbUrl)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    try {
      const dbUrl = getDatabaseUrl(env);
      const sql = dbUrl ? neon(dbUrl) : null;

      if (url.pathname === "/api/health" || url.pathname === "/") {
        let dbOk = false, dbError = null;
        if (dbUrl) {
          try {
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
          multiTenant: true,
          backupCron: "0 21 * * * UTC (= 00:00 Europe/Istanbul)",
          message: dbOk ? "API + Neon OK (SaaS multi-tenant)" : "Neon baglantisi yok veya hata",
        });
      }

      if (!sql) return json({ ok: false, error: "DATABASE_URL yok" }, 500);

      if (url.pathname === "/api/setup" && request.method === "POST") {
        await ensureSchema(sql);
        return json({ ok: true, message: "multi-tenant schema ok" });
      }

      // —— TENANTS (platform) ——
      if (url.pathname === "/api/tenants" && request.method === "GET") {
        await ensureSchema(sql);
        const rows = await sql`select code, name, plan, max_equipment, active, created_at from tenants order by created_at desc`;
        return json({ ok: true, tenants: rows });
      }
      if (url.pathname === "/api/tenants" && request.method === "POST") {
        await ensureSchema(sql);
        const body = await request.json().catch(() => ({}));
        const code = (body.code || "").trim().toLowerCase();
        const name = (body.name || "").trim();
        const plan = body.plan || "standard";
        const maxEq = plan === "starter" ? 50 : plan === "pro" ? 1000 : 300;
        if (!code || !name) return json({ ok: false, error: "code ve name gerekli" }, 400);
        await sql`
          insert into tenants (code, name, plan, max_equipment, active)
          values (${code}, ${name}, ${plan}, ${maxEq}, true)
          on conflict (code) do update set name=excluded.name, plan=excluded.plan, max_equipment=excluded.max_equipment, active=true`;
        // tenant admin seed
        try {
          const ex = await sql`select username from users where username='admin' and tenant_code=${code} limit 1`;
          if (!ex[0]) {
            await sql`insert into users (tenant_code, username, name, role, password_hash, sicil, active)
              values (${code}, 'admin', ${name + " Admin"}, 'admin', 'SabriAltan123', 'SCL-1', true)`;
          }
        } catch (_) {}
        return json({ ok: true, tenant: { code, name, plan, max_equipment: maxEq }, default_admin: "admin / SabriAltan123" });
      }

      // —— LOGIN (tenant scoped) ——
      if (url.pathname === "/api/login" && request.method === "POST") {
        try { await ensureSchema(sql); } catch (_) {}
        const body = await request.json().catch(() => ({}));
        const username = (body.username || "").trim();
        const password = body.password || "";
        let tenant = (body.tenant || "helpas").trim().toLowerCase() || "helpas";
        if (!username || !password) return json({ ok: false, error: "Kullanici ve sifre gerekli" }, 400);

        // tenants
        try {
          await sql`insert into tenants (code, name, plan, max_equipment, active)
            values ('helpas', 'HelpAS Ana', 'pro', 1000, true) on conflict (code) do nothing`;
        } catch (_) {}

        let trows = [];
        try {
          trows = await sql`select code, name, plan, max_equipment, active from tenants where code=${tenant} limit 1`;
        } catch (_) {}
        if (!trows[0] && tenant === "helpas") {
          trows = [{ code: "helpas", name: "HelpAS Ana", plan: "pro", max_equipment: 1000, active: true }];
        }
        if (!trows[0]) return json({ ok: false, error: "Kiraci bulunamadi: " + tenant }, 404);
        if (trows[0].active === false) return json({ ok: false, error: "Kiraci pasif" }, 403);

        // Kullanici ara — once tenant, sonra sadece username (eski sema)
        let u = null;
        try {
          let rows = await sql`
            select username, name, role, wa, password_hash, sicil, tenant_code
            from users where username=${username} and tenant_code=${tenant} limit 1`;
          u = rows[0];
        } catch (_) {}
        if (!u) {
          try {
            let rows = await sql`
              select username, name, role, wa, password_hash, sicil, tenant_code
              from users where username=${username} limit 1`;
            u = rows[0];
          } catch (_) {}
        }

        // Yoksa admin otomatik kurtar
        if (!u && username === "admin") {
          try {
            await sql`insert into users (tenant_code, username, name, role, password_hash, sicil, active)
              values (${tenant}, 'admin', 'Sabri Altan', 'admin', ${password}, 'SCL-1', true)`;
            u = { username: "admin", name: "Sabri Altan", role: "admin", wa: "", password_hash: password, sicil: "SCL-1", tenant_code: tenant };
          } catch (e1) {
            try {
              await sql`update users set password_hash=${password}, role='admin', active=true,
                tenant_code=coalesce(nullif(tenant_code,''), ${tenant})
                where username='admin'`;
              const rows = await sql`select username, name, role, wa, password_hash, sicil, tenant_code from users where username='admin' limit 1`;
              u = rows[0];
            } catch (e2) {
              return json({ ok: false, error: "Admin kaydi yazilamadi: " + String(e2.message || e2) }, 500);
            }
          }
        }

        if (!u) return json({ ok: false, error: "Hatali giris (kullanici yok)" }, 401);

        const dbPass = String(u.password_hash == null ? "" : u.password_hash);
        if (dbPass !== String(password)) {
          // Tek seferlik kurtarma: bilinen varsayilan sifre ile admin
          if (username === "admin" && password === "SabriAltan123") {
            try {
              await sql`update users set password_hash='SabriAltan123' where username='admin'`;
            } catch (_) {}
          } else {
            return json({ ok: false, error: "Hatali giris (sifre eslesmedi)" }, 401);
          }
        }

        return json({
          ok: true,
          source: "neon",
          multiTenant: true,
          user: {
            username: u.username,
            name: u.name || u.username,
            role: u.role || "admin",
            wa: u.wa || "",
            sicil: u.sicil || "",
            tenant
          },
          tenant,
          tenant_name: trows[0].name || tenant,
          plan: trows[0].plan || "standard",
          max_equipment: trows[0].max_equipment || 300
        });
      }

      // Resolve tenant for data APIs
      const bodyPeek = request.method === "GET" || request.method === "DELETE"
        ? {}
        : await request.clone().json().catch(() => ({}));
      const tenant = tenantFrom(request, bodyPeek);

      // USERS
      if (url.pathname === "/api/users" && request.method === "GET") {
        const rows = await sql`select username, name, role, wa, active, sicil, created_at from users where tenant_code=${tenant} order by username`;
        return json({ ok: true, tenant, users: rows });
      }
      if (url.pathname === "/api/users" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const username = (body.username || "").trim();
        const name = (body.name || "").trim();
        const role = ["admin","mudur","muhasebe","saha"].includes(body.role) ? body.role : "saha";
        const password = body.password || "";
        const wa = (body.wa || "").trim() || null;
        let sicil = (body.sicil || "").trim();
        if (!username || !name || !password) return json({ ok: false, error: "eksik alan" }, 400);
        if (!sicil) sicil = await nextNo(sql, tenant, "sicil");
        try {
          const ex = await sql`select username from users where username=${username} and tenant_code=${tenant} limit 1`;
          if (ex[0]) return json({ ok: false, error: "Kullanici mevcut" }, 409);
          await sql`insert into users (tenant_code, username, name, role, password_hash, wa, active, sicil)
            values (${tenant}, ${username}, ${name}, ${role}, ${password}, ${wa}, true, ${sicil})`;
        } catch (e) {
          return json({ ok: false, error: String(e.message || e) }, 500);
        }
        return json({ ok: true, user: { username, name, role, wa: wa || "", sicil } });
      }
      if (url.pathname === "/api/users" && request.method === "PUT") {
        const body = await request.json().catch(() => ({}));
        const username = (body.username || "").trim();
        if (!username) return json({ ok: false, error: "username gerekli" }, 400);
        const name = (body.name || "").trim();
        const role = ["admin","mudur","muhasebe","saha"].includes(body.role) ? body.role : "saha";
        const wa = (body.wa || "").trim() || null;
        const sicil = (body.sicil || "").trim() || null;
        if (body.password) {
          await sql`update users set name=${name}, role=${role}, wa=${wa}, sicil=coalesce(${sicil}, sicil), password_hash=${body.password}
            where tenant_code=${tenant} and username=${username}`;
        } else {
          await sql`update users set name=${name}, role=${role}, wa=${wa}, sicil=coalesce(${sicil}, sicil)
            where tenant_code=${tenant} and username=${username}`;
        }
        return json({ ok: true });
      }
      if (url.pathname === "/api/admin/delete-user" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const username = (body.username || "").trim();
        if (!username || username === "admin") return json({ ok: false, error: "admin silinemez" }, 400);
        await sql`delete from users where tenant_code=${tenant} and username=${username}`;
        return json({ ok: true, deleted: username });
      }
      if (url.pathname === "/api/admin/set-password" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const username = (body.username || "").trim();
        const password = body.password || "";
        if (!username || password.length < 6) return json({ ok: false, error: "username ve sifre" }, 400);
        await sql`update users set password_hash=${password} where tenant_code=${tenant} and username=${username}`;
        return json({ ok: true });
      }

      // CUSTOMERS
      if (url.pathname === "/api/customers" && request.method === "GET") {
        const rows = await sql`select id, name, contact, phone, email, address, created_at from customers where tenant_code=${tenant} order by name`;
        return json({ ok: true, tenant, customers: rows });
      }
      if (url.pathname === "/api/customers" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const name = (body.name || "").trim();
        if (!name) return json({ ok: false, error: "name gerekli" }, 400);
        const rows = await sql`
          insert into customers (tenant_code, name, contact, phone, email, address)
          values (${tenant}, ${name}, ${(body.contact||"").trim()||null}, ${(body.phone||"").trim()||null},
            ${(body.email||"").trim()||null}, ${(body.address||"").trim()||null})
          returning id, name, contact, phone, email, address`;
        return json({ ok: true, customer: rows[0] });
      }
      if (url.pathname === "/api/customers" && request.method === "PUT") {
        const body = await request.json().catch(() => ({}));
        if (!body.id) return json({ ok: false, error: "id gerekli" }, 400);
        await sql`update customers set name=${(body.name||"").trim()},
          contact=${(body.contact||"").trim()||null}, phone=${(body.phone||"").trim()||null},
          email=${(body.email||"").trim()||null}, address=${(body.address||"").trim()||null}
          where id=${body.id} and tenant_code=${tenant}`;
        return json({ ok: true });
      }

      // EQUIPMENT
      if (url.pathname === "/api/equipment" && request.method === "GET") {
        const rows = await sql`
          select id, name, location, customer_id, brand, model, serial_no,
            lat, lng, period_months, last_maint, next_maint,
            device_id, mqtt_topic, status, online, floor, alarm, last_seen
          from equipment where tenant_code=${tenant} order by name`;
        return json({ ok: true, tenant, equipment: rows });
      }
      if (url.pathname === "/api/equipment" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const name = (body.name || "").trim();
        const deviceId = (body.device_id || body.deviceId || "").trim();
        if (!name || !deviceId) return json({ ok: false, error: "name ve device_id gerekli" }, 400);
        const cnt = await sql`select count(*)::int as c from equipment where tenant_code=${tenant}`;
        const tinf = await sql`select max_equipment from tenants where code=${tenant} limit 1`;
        const maxEq = tinf[0]?.max_equipment || 300;
        if (cnt[0].c >= maxEq) return json({ ok: false, error: "Plan limiti: max " + maxEq + " asansor" }, 403);
        const token = (body.device_token || body.deviceToken || ("tok_" + crypto.randomUUID())).trim();
        const rows = await sql`
          insert into equipment (
            tenant_code, name, location, customer_id, brand, model, lat, lng, period_months, next_maint,
            device_id, device_token_hash, mqtt_topic, status, online, floor
          ) values (
            ${tenant}, ${name}, ${(body.location||"").trim()||null}, ${body.customer_id||body.customerId||null},
            ${body.brand||null}, ${body.model||null}, ${body.lat??null}, ${body.lng??null},
            ${body.period_months||body.period||3}, ${body.next_maint||body.nextMaint||null},
            ${deviceId}, ${token},
            ${body.mqtt_topic||body.mqttTopic||("helpas/v1/"+tenant+"/"+deviceId+"/telemetry")},
            'ok', false, 1
          ) returning id, name, location, device_id, status`;
        return json({ ok: true, equipment: rows[0], device_token: token });
      }
      if (url.pathname === "/api/equipment" && request.method === "PUT") {
        const body = await request.json().catch(() => ({}));
        if (!body.id) return json({ ok: false, error: "id gerekli" }, 400);
        await sql`
          update equipment set
            name=${(body.name||"").trim()},
            location=${(body.location||"").trim()||null},
            customer_id=${body.customer_id||body.customerId||null},
            brand=${body.brand||null}, model=${body.model||null},
            lat=${body.lat??null}, lng=${body.lng??null},
            period_months=${body.period_months||body.period||3},
            next_maint=${body.next_maint||body.nextMaint||null},
            device_id=${(body.device_id||body.deviceId||"").trim()}
          where id=${body.id} and tenant_code=${tenant}`;
        return json({ ok: true });
      }
      if (url.pathname === "/api/equipment" && request.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (!id) return json({ ok: false, error: "id gerekli" }, 400);
        await sql`delete from equipment where id=${id} and tenant_code=${tenant}`;
        return json({ ok: true, deleted: id });
      }

      // FORMS
      if (url.pathname === "/api/forms" && request.method === "GET") {
        const rows = await sql`select * from service_forms where tenant_code=${tenant} order by created_at desc limit 200`;
        return json({ ok: true, tenant, forms: rows });
      }
      if (url.pathname === "/api/forms" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const kind = body.kind === "fault" ? "fault" : "pm";
        const formNo = body.form_no || (await nextNo(sql, tenant, kind));
        try {
          const rows = await sql`
            insert into service_forms (
              tenant_code, form_no, kind, equipment_id, equipment_name, customer_name,
              tech_name, tech_sicil, form_date, status, priority, summary,
              technical, checklist, payment, completed_at
            ) values (
              ${tenant}, ${formNo}, ${kind}, ${body.equipment_id||null}, ${body.equipment_name||null}, ${body.customer_name||null},
              ${body.tech_name||null}, ${body.tech_sicil||null}, ${body.form_date||new Date().toISOString().slice(0,10)},
              ${body.status||"open"}, ${body.priority||null}, ${body.summary||null},
              ${JSON.stringify(body.technical||{})}::jsonb,
              ${JSON.stringify(body.checklist||[])}::jsonb,
              ${JSON.stringify(body.payment||{})}::jsonb,
              ${body.completed_at||null}
            ) returning id, form_no, kind`;
          return json({ ok: true, form: rows[0] });
        } catch (e) {
          if (String(e.message || e).includes("unique") || String(e.message || e).includes("duplicate")) {
            return json({ ok: false, error: "form_no mevcut, ezilmedi", form_no: formNo }, 409);
          }
          throw e;
        }
      }
      if (url.pathname === "/api/forms" && request.method === "PUT") {
        const body = await request.json().catch(() => ({}));
        const formNo = body.form_no;
        if (!formNo) return json({ ok: false, error: "form_no gerekli" }, 400);
        const existing = await sql`select form_no from service_forms where tenant_code=${tenant} and form_no=${formNo} limit 1`;
        if (!existing[0]) {
          const kind = body.kind === "fault" ? "fault" : "pm";
          await sql`
            insert into service_forms (
              tenant_code, form_no, kind, equipment_id, equipment_name, customer_name,
              tech_name, tech_sicil, form_date, status, priority, summary,
              technical, checklist, payment, completed_at
            ) values (
              ${tenant}, ${formNo}, ${kind}, ${body.equipment_id||null}, ${body.equipment_name||null}, ${body.customer_name||null},
              ${body.tech_name||null}, ${body.tech_sicil||null}, ${body.form_date||new Date().toISOString().slice(0,10)},
              ${body.status||"open"}, ${body.priority||null}, ${body.summary||null},
              ${JSON.stringify(body.technical||{})}::jsonb,
              ${JSON.stringify(body.checklist||[])}::jsonb,
              ${JSON.stringify(body.payment||{})}::jsonb,
              ${body.completed_at||null}
            )`;
          return json({ ok: true, created: true });
        }
        await sql`
          update service_forms set
            status=${body.status||"done"},
            summary=${body.summary||null},
            technical=${JSON.stringify(body.technical||{})}::jsonb,
            checklist=${JSON.stringify(body.checklist||[])}::jsonb,
            payment=${JSON.stringify(body.payment||{})}::jsonb,
            tech_name=coalesce(${body.tech_name||null}, tech_name),
            tech_sicil=coalesce(${body.tech_sicil||null}, tech_sicil),
            completed_at=coalesce(${body.completed_at||null}, completed_at)
          where tenant_code=${tenant} and form_no=${formNo}`;
        return json({ ok: true, updated: true });
      }

      // SCADA
      if (url.pathname === "/api/telemetry" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const deviceId = (body.device_id || "").trim();
        const tc = (body.tenant || tenant || "helpas").trim().toLowerCase();
        if (!deviceId) return json({ ok: false, error: "device_id gerekli" }, 400);
        const status = body.status || "ok";
        const floor = body.floor ?? null;
        const alarm = body.alarm ?? null;
        const online = body.online !== false;
        const prev = await sql`select status, alarm, online from telemetry_latest where tenant_code=${tc} and device_id=${deviceId} limit 1`;
        await sql`
          insert into telemetry_latest (tenant_code, device_id, status, floor, alarm, online, payload, received_at)
          values (${tc}, ${deviceId}, ${status}, ${floor}, ${alarm}, ${online}, ${JSON.stringify(body)}::jsonb, now())
          on conflict (tenant_code, device_id) do update set
            status=excluded.status, floor=coalesce(excluded.floor, telemetry_latest.floor),
            alarm=excluded.alarm, online=excluded.online, payload=excluded.payload, received_at=now()`;
        await sql`
          update equipment set status=${status}, floor=coalesce(${floor}, floor), alarm=${alarm}, online=${online}, last_seen=now()
          where tenant_code=${tc} and device_id=${deviceId}`;
        const prevRow = prev[0];
        const changed = !prevRow || prevRow.status !== status || prevRow.alarm !== alarm || prevRow.online !== online;
        const isAlarm = status === "alarm" || (alarm && String(alarm).length > 0);
        if (changed || isAlarm) {
          await sql`
            insert into telemetry_events (tenant_code, device_id, event_type, status, alarm, payload)
            values (${tc}, ${deviceId}, ${isAlarm ? "alarm" : "state_change"}, ${status}, ${alarm}, ${JSON.stringify({ floor, online })}::jsonb)`;
        }
        return json({ ok: true, tenant: tc, recorded_event: changed || isAlarm });
      }

      // CREW GPS
      if (url.pathname === "/api/crew/location" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const username = (body.username || "").trim();
        const name = (body.name || username).trim();
        const lat = Number(body.lat);
        const lng = Number(body.lng);
        const tc = (body.tenant || tenant).trim().toLowerCase();
        if (!username || Number.isNaN(lat) || Number.isNaN(lng)) return json({ ok: false, error: "eksik" }, 400);
        await sql`
          insert into crew_locations (tenant_code, username, name, lat, lng, updated_at)
          values (${tc}, ${username}, ${name}, ${lat}, ${lng}, now())
          on conflict (tenant_code, username) do update set
            name=excluded.name, lat=excluded.lat, lng=excluded.lng, updated_at=now()`;
        return json({ ok: true });
      }
      if (url.pathname === "/api/crew/locations" && request.method === "GET") {
        const tc = (url.searchParams.get("tenant") || tenant).trim().toLowerCase();
        const rows = await sql`
          select username, name, lat, lng, updated_at from crew_locations
          where tenant_code=${tc} and updated_at > now() - interval '30 minutes'
          order by updated_at desc`;
        return json({ ok: true, tenant: tc, locations: rows });
      }

      // BACKUP
      if (url.pathname === "/api/backup/run" && request.method === "POST") {
        const result = await runDailyBackup(sql);
        return json({ ok: true, ...result });
      }
      if (url.pathname === "/api/backup/list" && request.method === "GET") {
        const rows = await sql`
          select id, tenant_code, backup_date, taken_at, timezone, counts
          from daily_backups where tenant_code=${tenant} order by backup_date desc limit 30`;
        return json({ ok: true, backups: rows });
      }

      if (url.pathname === "/api/admin/reset" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (body.confirm !== "SIFIRLA") return json({ ok: false, error: "confirm=SIFIRLA" }, 400);
        const mode = body.mode || "ops";
        await sql`delete from service_forms where tenant_code=${tenant}`;
        await sql`delete from telemetry_events where tenant_code=${tenant}`;
        await sql`delete from telemetry_latest where tenant_code=${tenant}`;
        await sql`delete from equipment where tenant_code=${tenant}`;
        await sql`delete from customers where tenant_code=${tenant}`;
        await sql`delete from contracts where tenant_code=${tenant}`;
        if (mode === "all_except_admin") {
          await sql`delete from users where tenant_code=${tenant} and username <> 'admin'`;
        }
        return json({ ok: true, tenant, message: "Kiraci verisi sifirlandi — admin korundu" });
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  },
};
