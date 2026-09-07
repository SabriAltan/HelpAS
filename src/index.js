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
function getDatabaseUrl(env) {
  if (!env) return null;
  return env.DATABASE_URL || env.NEON_DATABASE_URL || env.POSTGRES_URL || null;
}

async function ensureSchema(sql) {
  await sql`create table if not exists form_seq (
    kind text primary key, last_num int not null default 0)`;
  await sql`insert into form_seq (kind, last_num) values ('pm', 0) on conflict do nothing`;
  await sql`insert into form_seq (kind, last_num) values ('fault', 0) on conflict do nothing`;
  await sql`insert into form_seq (kind, last_num) values ('sicil', 1000) on conflict do nothing`;
  await sql`create table if not exists service_forms (
    id uuid primary key default gen_random_uuid(),
    form_no text unique not null,
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
    completed_at timestamptz
  )`;
  // SCADA: sadece SON durum (canlı, tek satır / cihaz)
  await sql`create table if not exists telemetry_latest (
    device_id text primary key,
    status text,
    floor int,
    alarm text,
    online boolean default true,
    payload jsonb default '{}'::jsonb,
    received_at timestamptz default now()
  )`;
  // SCADA: seyrek olay arşivi (sadece değişim / alarm — şişirmez)
  await sql`create table if not exists telemetry_events (
    id bigserial primary key,
    device_id text not null,
    event_type text not null,
    status text,
    alarm text,
    payload jsonb default '{}'::jsonb,
    created_at timestamptz default now()
  )`;
  await sql`create index if not exists idx_te_device_created on telemetry_events (device_id, created_at desc)`;
  // Günlük yedek özeti (master veri ezilmez; anlık kopya JSON)
  await sql`create table if not exists daily_backups (
    id bigserial primary key,
    backup_date date not null unique,
    taken_at timestamptz default now(),
    timezone text default 'Europe/Istanbul',
    counts jsonb not null,
    snapshot jsonb not null
  )`;
  try { await sql`alter table users add column if not exists sicil text`; } catch (_) {}
  try { await sql`alter table users drop constraint if exists users_role_check`; } catch (_) {}
  // role: admin | mudur | muhasebe | saha — constraint yok (esnek)
}

async function runDailyBackup(sql) {
  await ensureSchema(sql);
  // Türkiye tarihi
  const trDate = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Istanbul" });

  const users = await sql`select username, name, role, wa, sicil, active from users`;
  const customers = await sql`select id, name, contact, phone, email, address from customers`;
  const equipment = await sql`select id, name, location, customer_id, brand, model, serial_no,
    lat, lng, period_months, last_maint, next_maint, device_id, mqtt_topic, status, online, floor from equipment`;
  const forms = await sql`select form_no, kind, equipment_id, equipment_name, customer_name,
    tech_name, tech_sicil, form_date, status, priority, summary, technical, checklist, payment, completed_at
    from service_forms order by created_at desc limit 5000`;
  const contracts = await sql`select id, customer_id, equipment_id, start_date, end_date, monthly_fee, period_months, scope, status from contracts`.catch(() => []);
  const scadaLatest = await sql`select device_id, status, floor, alarm, online, received_at from telemetry_latest`;

  const counts = {
    users: users.length,
    customers: customers.length,
    equipment: equipment.length,
    forms: forms.length,
    contracts: Array.isArray(contracts) ? contracts.length : 0,
    scada_devices: scadaLatest.length,
  };

  // Master + formlar yedek; SCADA sadece özet (payload yok — şişirmez)
  const snapshot = {
    users,
    customers,
    equipment,
    forms,
    contracts: Array.isArray(contracts) ? contracts : [],
    scada_latest_summary: scadaLatest,
  };

  await sql`
    insert into daily_backups (backup_date, timezone, counts, snapshot)
    values (${trDate}, 'Europe/Istanbul', ${JSON.stringify(counts)}::jsonb, ${JSON.stringify(snapshot)}::jsonb)
    on conflict (backup_date) do update set
      taken_at = now(),
      counts = excluded.counts,
      snapshot = excluded.snapshot
  `;

  // Eski SCADA olaylarını budama: 30 günden eski event sil (latest dokunulmaz)
  await sql`delete from telemetry_events where created_at < now() - interval '30 days'`;
  // 90 günden eski günlük yedek sil (isterseniz uzatılır)
  await sql`delete from daily_backups where backup_date < (current_date - interval '90 days')`;

  return { backup_date: trDate, counts };
}

export default {
  // Cloudflare Cron: TR 00:00
  async scheduled(event, env, ctx) {
    const dbUrl = getDatabaseUrl(env);
    if (!dbUrl) return;
    const sql = neon(dbUrl);
    ctx.waitUntil(runDailyBackup(sql));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
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
          backupCron: "0 21 * * * UTC (= 00:00 Europe/Istanbul)",
          message: dbOk ? "API + Neon OK" : "Neon baglantisi yok veya hata",
        });
      }

      if (!sql) return json({ ok: false, error: "DATABASE_URL yok" }, 500);

      if (url.pathname === "/api/setup" && request.method === "POST") {
        await ensureSchema(sql);
        return json({ ok: true, message: "schema ok — scada ayrı, yedek tablosu hazır" });
      }

      // Manuel yedek tetik (admin)
      if (url.pathname === "/api/backup/run" && request.method === "POST") {
        const result = await runDailyBackup(sql);
        return json({ ok: true, ...result });
      }
      if (url.pathname === "/api/backup/list" && request.method === "GET") {
        await ensureSchema(sql);
        const rows = await sql`
          select id, backup_date, taken_at, timezone, counts
          from daily_backups order by backup_date desc limit 30`;
        return json({ ok: true, backups: rows });
      }

      async function nextNo(kind) {
        const prefix = kind === "pm" ? "PM" : kind === "fault" ? "ARZ" : "SCL";
        const year = new Date().getFullYear();
        const rows = await sql`
          insert into form_seq (kind, last_num) values (${kind}, 1)
          on conflict (kind) do update set last_num = form_seq.last_num + 1
          returning last_num`;
        return `${prefix}-${year}-${String(rows[0].last_num).padStart(5, "0")}`;
      }

      // LOGIN
      if (url.pathname === "/api/login" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const username = (body.username || "").trim();
        const password = body.password || "";
        const rows = await sql`
          select username, name, role, wa, password_hash, sicil
          from users where username = ${username} limit 1`;
        const u = rows[0];
        if (!u || u.password_hash !== password) return json({ ok: false, error: "Hatali giris" }, 401);
        return json({
          ok: true, source: "neon",
          user: { username: u.username, name: u.name, role: u.role, wa: u.wa || "", sicil: u.sicil || "" },
        });
      }

      // USERS — güncelleme mevcut satırı günceller; silmez / ezmez (username key)
      if (url.pathname === "/api/users" && request.method === "GET") {
        const rows = await sql`select username, name, role, wa, active, sicil, created_at from users order by username`;
        return json({ ok: true, users: rows });
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
        if (!sicil) sicil = await nextNo("sicil");
        await sql`
          insert into users (username, name, role, password_hash, wa, active, sicil)
          values (${username}, ${name}, ${role}, ${password}, ${wa}, true, ${sicil})
          on conflict (username) do nothing`;
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
          await sql`update users set name=${name}, role=${role}, wa=${wa},
            sicil=coalesce(${sicil}, sicil), password_hash=${body.password} where username=${username}`;
        } else {
          await sql`update users set name=${name}, role=${role}, wa=${wa},
            sicil=coalesce(${sicil}, sicil) where username=${username}`;
        }
        return json({ ok: true });
      }

      // CUSTOMERS
      if (url.pathname === "/api/customers" && request.method === "GET") {
        const rows = await sql`select id, name, contact, phone, email, address, created_at from customers order by name`;
        return json({ ok: true, customers: rows });
      }
      if (url.pathname === "/api/customers" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const name = (body.name || "").trim();
        if (!name) return json({ ok: false, error: "name gerekli" }, 400);
        const rows = await sql`
          insert into customers (name, contact, phone, email, address)
          values (${name}, ${(body.contact||"").trim()||null}, ${(body.phone||"").trim()||null},
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
          where id=${body.id}`;
        return json({ ok: true });
      }

      // EQUIPMENT — SCADA alanları telemetri ile güncellenir; master PUT ile ayrı
      if (url.pathname === "/api/equipment" && request.method === "GET") {
        const rows = await sql`
          select e.id, e.name, e.location, e.customer_id, e.brand, e.model, e.serial_no,
            e.lat, e.lng, e.period_months, e.last_maint, e.next_maint,
            e.device_id, e.mqtt_topic, e.status, e.online, e.floor, e.alarm, e.last_seen,
            t.received_at as scada_received_at
          from equipment e
          left join telemetry_latest t on t.device_id = e.device_id
          order by e.name`;
        return json({ ok: true, equipment: rows });
      }
      if (url.pathname === "/api/equipment" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const name = (body.name || "").trim();
        const deviceId = (body.device_id || body.deviceId || "").trim();
        if (!name || !deviceId) return json({ ok: false, error: "name ve device_id gerekli" }, 400);
        const token = (body.device_token || body.deviceToken || ("tok_" + crypto.randomUUID())).trim();
        const rows = await sql`
          insert into equipment (
            name, location, customer_id, brand, model, lat, lng, period_months, next_maint,
            device_id, device_token_hash, mqtt_topic, status, online, floor
          ) values (
            ${name}, ${(body.location||"").trim()||null}, ${body.customer_id||body.customerId||null},
            ${body.brand||null}, ${body.model||null}, ${body.lat??null}, ${body.lng??null},
            ${body.period_months||body.period||3}, ${body.next_maint||body.nextMaint||null},
            ${deviceId}, ${token},
            ${body.mqtt_topic||body.mqttTopic||("helpas/v1/site/"+deviceId+"/telemetry")},
            'ok', false, 1
          ) returning id, name, location, device_id, status`;
        return json({ ok: true, equipment: rows[0], device_token: token });
      }
      if (url.pathname === "/api/equipment" && request.method === "PUT") {
        const body = await request.json().catch(() => ({}));
        if (!body.id) return json({ ok: false, error: "id gerekli" }, 400);
        // Master veri — SCADA status/online/alarm burada ezilmez
        await sql`
          update equipment set
            name=${(body.name||"").trim()},
            location=${(body.location||"").trim()||null},
            customer_id=${body.customer_id||body.customerId||null},
            brand=${body.brand||null},
            model=${body.model||null},
            lat=${body.lat??null},
            lng=${body.lng??null},
            period_months=${body.period_months||body.period||3},
            next_maint=${body.next_maint||body.nextMaint||null},
            device_id=${(body.device_id||body.deviceId||"").trim()}
          where id=${body.id}`;
        return json({ ok: true });
      }


      if (url.pathname === "/api/equipment" && request.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (!id) return json({ ok: false, error: "id gerekli" }, 400);
        await sql`delete from equipment where id = ${id}`;
        return json({ ok: true, deleted: id });
      }

      // FORMS — form_no unique; PUT günceller, geçmiş formlar silinmez
      if (url.pathname === "/api/forms" && request.method === "GET") {
        const kind = url.searchParams.get("kind");
        const rows = kind
          ? await sql`select * from service_forms where kind=${kind} order by created_at desc limit 200`
          : await sql`select * from service_forms order by created_at desc limit 200`;
        return json({ ok: true, forms: rows });
      }
      if (url.pathname === "/api/forms" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const kind = body.kind === "fault" ? "fault" : "pm";
        const formNo = body.form_no || (await nextNo(kind));
        try {
          const rows = await sql`
            insert into service_forms (
              form_no, kind, equipment_id, equipment_name, customer_name,
              tech_name, tech_sicil, form_date, status, priority, summary,
              technical, checklist, payment, completed_at
            ) values (
              ${formNo}, ${kind}, ${body.equipment_id||null}, ${body.equipment_name||null}, ${body.customer_name||null},
              ${body.tech_name||null}, ${body.tech_sicil||null}, ${body.form_date||new Date().toISOString().slice(0,10)},
              ${body.status||"open"}, ${body.priority||null}, ${body.summary||null},
              ${JSON.stringify(body.technical||{})}::jsonb,
              ${JSON.stringify(body.checklist||[])}::jsonb,
              ${JSON.stringify(body.payment||{})}::jsonb,
              ${body.completed_at||null}
            ) returning id, form_no, kind`;
          return json({ ok: true, form: rows[0] });
        } catch (e) {
          // form_no varsa ezme — mevcut kaydı koru
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
        const existing = await sql`select form_no, status from service_forms where form_no=${formNo} limit 1`;
        if (!existing[0]) {
          // yoksa insert
          const kind = body.kind === "fault" ? "fault" : "pm";
          await sql`
            insert into service_forms (
              form_no, kind, equipment_id, equipment_name, customer_name,
              tech_name, tech_sicil, form_date, status, priority, summary,
              technical, checklist, payment, completed_at
            ) values (
              ${formNo}, ${kind}, ${body.equipment_id||null}, ${body.equipment_name||null}, ${body.customer_name||null},
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
            status=${body.status||existing[0].status},
            summary=${body.summary||null},
            technical=${JSON.stringify(body.technical||{})}::jsonb,
            checklist=${JSON.stringify(body.checklist||[])}::jsonb,
            payment=${JSON.stringify(body.payment||{})}::jsonb,
            tech_name=coalesce(${body.tech_name||null}, tech_name),
            tech_sicil=coalesce(${body.tech_sicil||null}, tech_sicil),
            completed_at=coalesce(${body.completed_at||null}, completed_at)
          where form_no=${formNo}`;
        return json({ ok: true, updated: true });
      }

      // SCADA canlı — master ekipman ad/konum ezilmez; sadece durum alanları + ayrı telemetry tabloları
      if (url.pathname === "/api/telemetry" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const deviceId = (body.device_id || "").trim();
        if (!deviceId) return json({ ok: false, error: "device_id gerekli" }, 400);
        const status = body.status || "ok";
        const floor = body.floor ?? null;
        const alarm = body.alarm ?? null;
        const online = body.online !== false;

        const prev = await sql`select status, alarm, online from telemetry_latest where device_id=${deviceId} limit 1`;
        const prevRow = prev[0];

        await sql`
          insert into telemetry_latest (device_id, status, floor, alarm, online, payload, received_at)
          values (${deviceId}, ${status}, ${floor}, ${alarm}, ${online}, ${JSON.stringify(body)}::jsonb, now())
          on conflict (device_id) do update set
            status=excluded.status,
            floor=coalesce(excluded.floor, telemetry_latest.floor),
            alarm=excluded.alarm,
            online=excluded.online,
            payload=excluded.payload,
            received_at=now()`;

        // Ekipman canlı alanları — isim/konum/PM dokunulmaz
        await sql`
          update equipment set
            status=${status},
            floor=coalesce(${floor}, floor),
            alarm=${alarm},
            online=${online},
            last_seen=now()
          where device_id=${deviceId}`;

        // Sadece değişim veya alarmda event yaz (gereksiz satır yok)
        const changed = !prevRow || prevRow.status !== status || prevRow.alarm !== alarm || prevRow.online !== online;
        const isAlarm = status === "alarm" || (alarm && String(alarm).length > 0);
        if (changed || isAlarm) {
          await sql`
            insert into telemetry_events (device_id, event_type, status, alarm, payload)
            values (
              ${deviceId},
              ${isAlarm ? "alarm" : "state_change"},
              ${status}, ${alarm}, ${JSON.stringify({ floor, online })}::jsonb
            )`;
        }
        return json({ ok: true, recorded_event: changed || isAlarm });
      }

      // SCADA oku (ayrı)
      if (url.pathname === "/api/scada/latest" && request.method === "GET") {
        const rows = await sql`select * from telemetry_latest order by received_at desc nulls last`;
        return json({ ok: true, latest: rows });
      }
      if (url.pathname === "/api/scada/events" && request.method === "GET") {
        const deviceId = url.searchParams.get("device_id");
        const rows = deviceId
          ? await sql`select id, device_id, event_type, status, alarm, payload, created_at
              from telemetry_events where device_id=${deviceId} order by created_at desc limit 100`
          : await sql`select id, device_id, event_type, status, alarm, payload, created_at
              from telemetry_events order by created_at desc limit 100`;
        return json({ ok: true, events: rows });
      }


      // ===== SUPER ADMIN =====
      if (url.pathname === "/api/admin/delete-user" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const username = (body.username || "").trim();
        if (!username) return json({ ok: false, error: "username gerekli" }, 400);
        if (username === "admin") return json({ ok: false, error: "admin silinemez" }, 400);
        await sql`delete from users where username = ${username}`;
        return json({ ok: true, deleted: username });
      }

      if (url.pathname === "/api/admin/set-password" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const username = (body.username || "").trim();
        const password = body.password || "";
        if (!username || password.length < 6) {
          return json({ ok: false, error: "username ve min 6 karakter sifre" }, 400);
        }
        await sql`update users set password_hash = ${password} where username = ${username}`;
        return json({ ok: true, username });
      }

      if (url.pathname === "/api/backup/get" && request.method === "GET") {
        const id = url.searchParams.get("id");
        if (!id) return json({ ok: false, error: "id gerekli" }, 400);
        const rows = await sql`
          select id, backup_date, taken_at, timezone, counts, snapshot
          from daily_backups where id = ${id} limit 1`;
        if (!rows[0]) return json({ ok: false, error: "yedek yok" }, 404);
        return json({ ok: true, backup: rows[0] });
      }

      // Yedekten geri yükleme — mevcut admin kullanıcısını korur
      if (url.pathname === "/api/backup/restore" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const id = body.id;
        if (!id) return json({ ok: false, error: "id gerekli" }, 400);
        const rows = await sql`select snapshot from daily_backups where id = ${id} limit 1`;
        if (!rows[0]) return json({ ok: false, error: "yedek yok" }, 404);
        const snap = rows[0].snapshot;
        let restored = { users: 0, customers: 0, equipment: 0, forms: 0 };

        // customers
        if (Array.isArray(snap.customers)) {
          for (const c of snap.customers) {
            await sql`
              insert into customers (id, name, contact, phone, email, address)
              values (${c.id}, ${c.name}, ${c.contact||null}, ${c.phone||null}, ${c.email||null}, ${c.address||null})
              on conflict (id) do update set
                name=excluded.name, contact=excluded.contact, phone=excluded.phone,
                email=excluded.email, address=excluded.address`;
            restored.customers++;
          }
        }
        // equipment
        if (Array.isArray(snap.equipment)) {
          for (const e of snap.equipment) {
            await sql`
              insert into equipment (
                id, name, location, customer_id, brand, model, serial_no,
                lat, lng, period_months, last_maint, next_maint,
                device_id, device_token_hash, mqtt_topic, status, online, floor
              ) values (
                ${e.id}, ${e.name}, ${e.location||null}, ${e.customer_id||null},
                ${e.brand||null}, ${e.model||null}, ${e.serial_no||null},
                ${e.lat??null}, ${e.lng??null}, ${e.period_months||3},
                ${e.last_maint||null}, ${e.next_maint||null},
                ${e.device_id}, ${e.device_token_hash||'restored'}, ${e.mqtt_topic||null},
                ${e.status||'ok'}, ${!!e.online}, ${e.floor||1}
              )
              on conflict (id) do update set
                name=excluded.name, location=excluded.location, customer_id=excluded.customer_id,
                brand=excluded.brand, model=excluded.model, lat=excluded.lat, lng=excluded.lng,
                period_months=excluded.period_months, next_maint=excluded.next_maint,
                device_id=excluded.device_id, status=excluded.status`;
            restored.equipment++;
          }
        }
        // forms by form_no
        if (Array.isArray(snap.forms)) {
          for (const f of snap.forms) {
            await sql`
              insert into service_forms (
                form_no, kind, equipment_id, equipment_name, customer_name,
                tech_name, tech_sicil, form_date, status, priority, summary,
                technical, checklist, payment, completed_at
              ) values (
                ${f.form_no}, ${f.kind}, ${f.equipment_id||null}, ${f.equipment_name||null}, ${f.customer_name||null},
                ${f.tech_name||null}, ${f.tech_sicil||null}, ${f.form_date},
                ${f.status||'open'}, ${f.priority||null}, ${f.summary||null},
                ${JSON.stringify(f.technical||{})}::jsonb,
                ${JSON.stringify(f.checklist||[])}::jsonb,
                ${JSON.stringify(f.payment||{})}::jsonb,
                ${f.completed_at||null}
              )
              on conflict (form_no) do update set
                status=excluded.status, summary=excluded.summary,
                technical=excluded.technical, checklist=excluded.checklist, payment=excluded.payment`;
            restored.forms++;
          }
        }
        // users — admin sifresini ezme; diğerlerini geri yükle
        if (Array.isArray(snap.users)) {
          for (const u of snap.users) {
            if (u.username === "admin") continue;
            await sql`
              insert into users (username, name, role, password_hash, wa, active, sicil)
              values (${u.username}, ${u.name}, ${u.role||'saha'}, ${u.password_hash||'ChangeMe1'}, ${u.wa||null}, ${u.active!==false}, ${u.sicil||null})
              on conflict (username) do update set
                name=excluded.name, role=excluded.role, wa=excluded.wa, sicil=excluded.sicil`;
            restored.users++;
          }
        }
        return json({ ok: true, restored });
      }

      // Kontrollü sıfırlama — admin kullanıcısı kalır
      if (url.pathname === "/api/admin/reset" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (body.confirm !== "SIFIRLA") {
          return json({ ok: false, error: "confirm alani tam olarak SIFIRLA olmali" }, 400);
        }
        const mode = body.mode || "ops"; // ops | all_except_admin
        if (mode === "ops" || mode === "all_except_admin") {
          await sql`delete from service_forms`;
          await sql`delete from telemetry_events`;
          await sql`delete from telemetry_latest`;
          try { await sql`delete from jobs`; } catch (_) {}
          try { await sql`delete from contracts`; } catch (_) {}
          await sql`delete from equipment`;
          await sql`delete from customers`;
        }
        if (mode === "all_except_admin") {
          await sql`delete from users where username <> 'admin'`;
        }
        // form sayaçlarını sıfırlama (opsiyonel)
        if (body.reset_seq) {
          await sql`update form_seq set last_num = 0 where kind in ('pm','fault')`;
        }
        return json({ ok: true, mode, message: "Sifirlama tamam — admin korundu" });
      }


      return json({ ok: false, error: "Not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  },
};
