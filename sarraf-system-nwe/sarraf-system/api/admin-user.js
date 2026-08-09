// api/admin-user.js
// Server-only Sarraf user administration.
// Requires a valid Admin session at AAL2 (TOTP MFA) and a Supabase secret/service key.

import { createClient } from "@supabase/supabase-js";

const ROLE_SET = new Set(["customer", "partner", "investor", "office", "admin"]);

const serverConfig = () => ({
  url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "",
  publicKey:
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    "",
  secretKey:
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "",
});

const makeClient = (url, key) =>
  createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

const decodeJwtPayload = (token) => {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return {};
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00964")) return digits.slice(2);
  if (digits.startsWith("964")) return digits;
  if (digits.startsWith("0")) return `964${digits.slice(1)}`;
  if (digits.startsWith("7")) return `964${digits}`;
  return digits;
};
const safeText = (value, max = 250) => {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
};

const auditId = () =>
  globalThis.crypto?.randomUUID?.() ||
  `audit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

async function requireAdminAal2(req, authClient, service) {
  const authHeader = String(req?.headers?.authorization || req?.headers?.Authorization || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) {
    const e = new Error("authentication required");
    e.status = 401;
    throw e;
  }

  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  const user = userData?.user;
  if (userError || !user?.id) {
    const e = new Error("invalid or expired session");
    e.status = 401;
    throw e;
  }

  const claims = decodeJwtPayload(token);
  if (String(claims?.aal || "aal1") !== "aal2") {
    const e = new Error("multi-factor authentication required");
    e.status = 403;
    e.code = "mfa_required";
    throw e;
  }

  const { data: profile, error: profileError } = await service
    .from("app_users")
    .select("id,auth_id,name,role,admin_level,deleted")
    .eq("auth_id", user.id)
    .eq("deleted", false)
    .maybeSingle();

  if (profileError || !profile?.id || profile.role !== "admin") {
    const e = new Error("admin authorization required");
    e.status = 403;
    throw e;
  }

  return { token, user, profile };
}

const isOwner = (profile) =>
  profile?.role === "admin" && profile?.admin_level === "owner";

async function writeAudit(service, action, detail) {
  const { error } = await service.from("audit").insert({
    id: auditId(),
    date: new Date().toISOString(),
    action,
    detail,
  });
  if (error) throw error;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }

  const { url, publicKey, secretKey } = serverConfig();
  if (!url || !publicKey || !secretKey) {
    return res.status(500).json({
      error: "Server user-management credentials are not configured",
      code: "server_config",
    });
  }

  const authClient = makeClient(url, publicKey);
  const service = makeClient(url, secretKey);

  let actor;
  try {
    actor = await requireAdminAal2(req, authClient, service);
  } catch (e) {
    const status = Number(e?.status) || 403;
    return res.status(status).json({
      error:
        status === 401
          ? "کاتی چوونەژوورەوەت بەسەرچووە"
          : e?.code === "mfa_required"
            ? "پاراستنی دوو هەنگاوی پێویستە"
            : "ڕێگەپێدانی ئەدمین پێویستە",
      code: e?.code || null,
    });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const action = String(body.action || "").trim();

    if (action === "create") {
      const name = safeText(body.name, 120);
      const phone = normalizePhone(body.phone);
      const password = String(body.password || "");
      const role = String(body.role || "");
      const rate = Number(body.rate || 0);
      if (role === "admin" && !isOwner(actor.profile)) {
        return res.status(403).json({ error: "تەنها خاوەنی سیستەم دەتوانێت ئەدمینی نوێ درووست بکات", code: "owner_required" });
      }
      const scope = Array.isArray(body.scope)
        ? [...new Set(body.scope.map((x) => String(x).trim()).filter(Boolean))].slice(0, 100)
        : [];
      const address = safeText(body.address, 300);
      const note = safeText(body.note, 1000);

      if (!name || phone.length < 7 || password.length < 12 || !ROLE_SET.has(role)) {
        return res.status(400).json({ error: "زانیاریی ئەکاونتەکە تەواو یان دروست نییە" });
      }
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        return res.status(400).json({ error: "ڕێژە دەبێت لە نێوان ٠ تا ١٠٠ بێت" });
      }

      const email = `${phone}@sarraf.local`;

      const { data: created, error: createError } = await service.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name, role, phone, admin_level: role === "admin" ? "admin" : null },
      });
      if (createError || !created?.user?.id) throw createError || new Error("Auth user creation failed");

      const authId = created.user.id;
      const profileId =
        globalThis.crypto?.randomUUID?.() ||
        `usr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      const { error: insertError } = await service.from("app_users").insert({
        id: profileId,
        auth_id: authId,
        name,
        role,
        admin_level: role === "admin" ? "admin" : null,
        rate,
        scope_curs: scope,
        phone,
        address,
        note,
        deleted: false,
      });

      if (insertError) {
        try { await service.auth.admin.deleteUser(authId); } catch {}
        if (
          String(insertError?.code || "") === "23505" ||
          /sarraf_app_users_auth_phone_uq|duplicate key|unique constraint/i.test(
            String(insertError?.message || "")
          )
        ) {
          return res.status(409).json({
            error: "ئەم ژمارەیە پێشتر بۆ ئەکاونتێکی چالاک بەکارهاتووە",
            code: "duplicate_login_identity",
          });
        }
        throw insertError;
      }

      await writeAudit(
        service,
        "درووستکردنی ئەکاونت",
        `${name} (${role}) — ${phone} — by ${actor.profile.name || actor.profile.id}`
      );

      return res.status(200).json({
        ok: true,
        user: { id: profileId, authId, name, role, adminLevel: role === "admin" ? "admin" : null, phone, rate, scope },
      });
    }

    if (action === "deactivate") {
      const userId = String(body.userId || "").trim();
      if (!userId) return res.status(400).json({ error: "userId پێویستە" });
      if (userId === actor.profile.id) {
        return res.status(400).json({ error: "ناتوانیت ئەکاونتی خۆت لەم شوێنە ناچالاک بکەیت" });
      }

      const { data: target, error: targetError } = await service
        .from("app_users")
        .select("id,name,role,admin_level,deleted")
        .eq("id", userId)
        .maybeSingle();
      if (targetError) throw targetError;
      if (!target?.id) return res.status(404).json({ error: "ئەکاونت نەدۆزرایەوە" });
      if (target.role === "admin") {
        if (!isOwner(actor.profile)) {
          return res.status(403).json({ error: "تەنها خاوەنی سیستەم دەتوانێت ئەدمین ناچالاک بکات", code: "owner_required" });
        }
        if (target.admin_level === "owner") {
          return res.status(403).json({ error: "ئەکاونتی خاوەنی سیستەم لەم ڕێگایە ناچالاک ناکرێت" });
        }
      }

      const { error: updateError } = await service
        .from("app_users")
        .update({ deleted: true })
        .eq("id", userId);
      if (updateError) throw updateError;

      await writeAudit(
        service,
        "ناچالاککردنی ئەکاونت",
        `${target.name} (${target.role}) — by ${actor.profile.name || actor.profile.id}`
      );

      return res.status(200).json({ ok: true });
    }

    if (action === "update_rate") {
      const userId = String(body.userId || "").trim();
      const rate = Number(body.rate);
      if (!userId || !Number.isFinite(rate) || rate < 0 || rate > 100) {
        return res.status(400).json({ error: "userId و ڕێژەی ٠ تا ١٠٠ پێویستن" });
      }

      const { data: target, error: targetError } = await service
        .from("app_users")
        .select("id,name,role,deleted")
        .eq("id", userId)
        .eq("deleted", false)
        .maybeSingle();
      if (targetError) throw targetError;
      if (!target?.id) return res.status(404).json({ error: "ئەکاونت نەدۆزرایەوە" });
      if (!["partner", "investor"].includes(target.role)) {
        return res.status(400).json({ error: "ڕێژە تەنها بۆ هاوبەش یان وەبەرهێنەرە" });
      }

      const { error: updateError } = await service
        .from("app_users")
        .update({ rate })
        .eq("id", userId);
      if (updateError) throw updateError;

      await writeAudit(
        service,
        "گۆڕینی ڕێژە",
        `${target.name} → ${rate}% — by ${actor.profile.name || actor.profile.id}`
      );

      return res.status(200).json({ ok: true, rate });
    }

    return res.status(400).json({ error: "کردارەکە ناسراو نییە" });
  } catch (e) {
    console.error("admin-user", e);
    const msg = String(e?.message || e || "server error");
    const duplicate = /already registered|already been registered|duplicate|unique/i.test(msg);
    return res.status(duplicate ? 409 : 500).json({
      error: duplicate ? "ئەم ژمارەیە پێشتر ئەکاونتی هەیە" : "نەتوانرا بەڕێوەبردنی ئەکاونت تەواو بکرێت",
      code: e?.code || null,
    });
  }
}
