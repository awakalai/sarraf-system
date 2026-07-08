-- ============================================================
-- سیستەمی کڕین و فرۆشتنی دراو — سکیمای بەرهەمهێنان (وەشانی ٢)
-- ئەم فایلە لە Supabase > SQL Editor دا جێبەجێ بکە (یەک جار)
-- ============================================================

-- ١) دراوەکان
create table currencies (
    id      text primary key,
    code    text unique not null,
    name    text not null,
    symbol  text,
    dec     int default 2
);

insert into currencies (id, code, name, symbol, dec) values
    ('usd', 'USD', 'دۆلاری ئەمریکی', '$', 2),
    ('iqd', 'IQD', 'دیناری عێراقی', 'د.ع', 0),
    ('cny', 'CNY', 'یەنی سینی', '¥', 2);

-- ٢) بەکارهێنەران (ئەکاونتە بازرگانییەکان)
-- auth_id: پەیوەندی لەگەڵ لۆگینی Supabase — بۆ ئەو کەسانەی لۆگین دەکەن
create table app_users (
    id       text primary key,
    auth_id  uuid unique,
    name     text not null,
    role     text not null check (role in ('admin','customer','partner','investor','office')),
    rate     numeric default 0,
    phone    text,
    address  text,
    note     text,
    deleted  boolean default false,
    created_at timestamptz default now()
);

-- ٣) دەفتەری پارە (هەموو جوڵانەوەیەک)
create table ledger (
    id          text primary key,
    type        text not null,
    owner       text,
    investor_id text references app_users(id),
    cur_id      text not null references currencies(id),
    amount      numeric(20,6) not null,
    partner_id  text references app_users(id),
    tx_id       text,
    note        text,
    date        timestamptz not null default now()
);
create index idx_ledger_tx on ledger(tx_id);
create index idx_ledger_partner on ledger(partner_id);
create index idx_ledger_investor on ledger(investor_id);

-- ٤) مامەڵەکان
create table txs (
    id            text primary key,
    code          int unique,
    type          text not null check (type in ('buy','sell')),
    cp_id         text references app_users(id),
    cp_name       text,
    cur_id        text not null references currencies(id),
    amount        numeric(20,6) not null,
    rate          numeric(20,8) not null,
    against_id    text not null references currencies(id),
    total         numeric(20,6) not null,
    partner_id    text references app_users(id),
    status        text not null default 'completed' check (status in ('completed','pending')),
    paid_at       timestamptz,
    profit        numeric(20,6),
    profit_cur_id text references currencies(id),
    note          text,
    date          timestamptz not null default now(),
    edited        boolean default false,
    deleted       boolean default false
);
create index idx_txs_cp on txs(cp_id);
create index idx_txs_status on txs(status);

-- ٥) تۆماری گۆڕانکاری
create table audit (
    id     text primary key,
    date   timestamptz not null default now(),
    action text not null,
    detail text
);

-- ============================================================
-- ئاسایش (Row Level Security)
-- ============================================================
alter table currencies enable row level security;
alter table app_users  enable row level security;
alter table ledger     enable row level security;
alter table txs        enable row level security;
alter table audit      enable row level security;

-- فەنکشنی یارمەتیدەر: ئایا بەکارهێنەری ئێستا ئەدمینە؟
create or replace function is_admin() returns boolean
language sql security definer stable as $$
  select exists (select 1 from app_users where auth_id = auth.uid() and role = 'admin' and not deleted);
$$;

create or replace function my_app_id() returns text
language sql security definer stable as $$
  select id from app_users where auth_id = auth.uid() limit 1;
$$;

create or replace function my_role() returns text
language sql security definer stable as $$
  select role from app_users where auth_id = auth.uid() limit 1;
$$;

-- دراوەکان: هەموو کەسێکی لۆگینکراو دەیانبینێت، تەنها ئەدمین دەیانگۆڕێت
create policy cur_read  on currencies for select using (auth.uid() is not null);
create policy cur_admin on currencies for all using (is_admin());

-- بەکارهێنەران: ئەدمین هەمووی، هەرکەسێک تەنها ڕیزی خۆی دەبینێت
create policy usr_admin on app_users for all using (is_admin());
create policy usr_self  on app_users for select using (auth_id = auth.uid());

-- دەفتەر: ئەدمین هەمووی؛ هاوبەش ڕیزەکانی خۆی؛ وەبەرهێنەر ڕیزەکانی خۆی؛
-- نووسینگە دەتوانێت تۆماری پارەدانی نووسینگە زیاد بکات
create policy led_admin    on ledger for all using (is_admin());
create policy led_partner  on ledger for select using (partner_id = my_app_id());
create policy led_investor on ledger for select using (investor_id = my_app_id());
create policy led_office_ins on ledger for insert
    with check (my_role() = 'office' and type = 'office_payment');

-- مامەڵەکان: ئەدمین هەمووی؛ کڕیار هی خۆی؛ نووسینگە کڕینەکان دەبینێت و
-- تەنها دەتوانێت دۆخی پارەدان نوێ بکاتەوە
create policy tx_admin    on txs for all using (is_admin());
create policy tx_customer on txs for select using (cp_id = my_app_id());
create policy tx_office_r on txs for select using (my_role() = 'office' and type = 'buy');
create policy tx_office_u on txs for update
    using (my_role() = 'office' and type = 'buy')
    with check (my_role() = 'office' and type = 'buy');

-- تۆماری گۆڕانکاری: تەنها ئەدمین دەیبینێت؛ نووسینگەش دەتوانێت تۆمار زیاد بکات
create policy aud_admin on audit for all using (is_admin());
create policy aud_office_ins on audit for insert with check (my_role() = 'office');

-- ============================================================
-- دوای جێبەجێکردنی ئەم فایلە:
-- ١. لە Authentication > Users ئەکاونتی خۆت (ئەدمین) درووست بکە بە ئیمەیل و پاسۆرد
-- ٢. UUID ی ئەکاونتەکە کۆپی بکە و ئەم دێڕە جێبەجێ بکە (UUID و ناوەکە بگۆڕە):
--    insert into app_users (id, auth_id, name, role) values ('admin', 'ئێرە-UUID-دابنێ', 'ناوی خۆت', 'admin');
-- ============================================================
