# ڕاپۆرتی پشکنین و ئامادەکاری ZEMAN

بەروار: 2026-08-18
branch: `repair/zeman-production-ready`

## کورتەی حوکم

کۆدی ئەپ، لۆجیکی A/B/C، فیش، ژمێریاری، مافی ڕۆڵەکان و migration history پشکنراون و کێشە گرنگە دۆزراوەکان لە کۆددا چارەسەر کراون. 30 migrationی سەرەکی لە PostgreSQL 16.14ی پاک جێبەجێ بوون و 130 contractی بنکەدراوە و 57 contractی browser سەرکەوتن. پاشان test projectی Supabase (`bank` / `ohnwrnsyqiobxskerttc`) بە پەسەندی خاوەن reset کرا، هەموو 31 migration ـەکە لە PostgreSQL 17.6ی remote push کران و runtime/security smoke testیان سەرکەوت. row ـە business ـەکانی test بە مەبەست سڕانەوە؛ Auth user و Storage bucket/file ـەکان پارێزران.

## کێشە گرنگە دۆزراوەکان و چارەسەرەکان

### ١. Schema و migration

- `supabase_schema.sql` تەنها بەشێکی بچووکی schema ـی ڕاستەقینەی هەبوو و دەتوانی databaseێکی ناتەواو و نەپارێزراو دروست بکات.
- migration ـە کۆنەکان پشت بە table/column/function ـی دەستیی production دەبەستن؛ fresh install reproducible نەبوو.
- baselineێکی additive زیاد کرا کە object ـە پێویستەکان بە `IF NOT EXISTS` دروست دەکات و داتای هەبوو ناسڕێتەوە.
- `supabase_schema.sql` وەک guard هێڵدرایەوە و بە ئاشکرا ڕەت دەکاتەوە تا کەسێک بە هەڵە Runی نەکات.
- contractێک زیاد کرا کە هەر RPC ـێکی بەکارهاتوو لە frontend/API دەبێت migration definitionی هەبێت.

### ٢. لۆجیکی مامەڵەی A/B/C

- Type A (`partner_custody`) ئێستا تەنها کاتێک دروست دەبێت کە custody partnerێکی ڕاستەقینە هەبێت.
- Type B (`owner_cashbox`) ئێستا یەک intent ـی دوو-ڕیزی buy/sell ـە؛ currency، against currency، amount و pair ـەکە دەبێت یەکسان بن. هیچ partner یان investor shareێکی نییە.
- Type C (`standard`) لە Type A/B جیا کراوەتەوە و ناتوانێت field ـی direct/custodyی دژبەیەک هەبێت.
- بەگێکی trigger دۆزرایەوە: defaultی `business_flow='standard'` پێش `BEFORE trigger` جێبەجێ دەبوو و Type A/Bی دروستی بە داتاى دژبەیەک دادەنا. migrationی additiveی `202608180004_transaction_business_flow_default.sql` default ـەکە لابرد و trigger هێشتا هەر labelی ساختە ڕەت دەکاتەوە.
- external currency لە Type A/C ـدا custody partnerی ڕوون پێویستە؛ Type B بە مەبەست لەم یاسایە لادەدرێت.
- یاساکان تەنها لە UI نین؛ check constraint، trigger و server command هەموویان هەمان contract جێبەجێ دەکەن.

### ٣. ژمێریاری و ledger

- browser پێشتر دەتوانی ledger، profit و cost basis بنێرێت. ئێستا server داتای دارایی لە intent، historical rate و stateی database دروست دەکات؛ `p_ledger`ی transaction پشتگوێ دەخرێت.
- weighted-average cost، realized profit، historical USD valuation و negative inventory لە server کۆنترۆڵ دەکرێن.
- دوو فرۆشتنی هاوکات پێشتر دەتوانیان هەمان inventory بخۆن. inventory advisory lock زیاد کرا.
- دوو withdrawal/transferی هاوکات دەتوانیان هەمان balance بەکاربهێنن. cash-location و account lockی ڕیزبەندکراو زیاد کرا.
- generic ledger RPC دەتوانی وەک دەرگای نووسینی ئازاد بەکاربهێنرێت. ئێستا تەنها capital movement، expense/investor payout، یان balanced main↔partner transfer قبووڵ دەکات.
- pending transaction کاتێک settle دەکرا journalی دروست دەبوو، بەڵام operational ledgerی قاسە نەدەجوڵا. settlement/reversal triggerی append-only زیاد کرا.
- void/editی transaction ئێستا history ناسڕێتەوە: edit تەنها note ـە؛ گۆڕینی economics پێویستی بە void/reversal و transactionێکی نوێ هەیە.

### ٤. Day close و historical rates

- frontend پێشتر `expected`، `diff` و `has_diff`ی خۆی دەنارد. ئێستا server لە append-only ledger دووبارە هەژماریان دەکات.
- closeی هەر business day یەکجارە، بە timezoneی دیاریکراو و exclusive accounting-period lock.
- rateی داهاتوو ناتوانێت بۆ transaction/day closeی ڕابردوو بەکاربهێنرێت. ئەگەر historical rate نەبێت command ڕەت دەکرێتەوە یان journal draft دەبێت؛ ژمارەی ساختە دروست ناکرێت.
- دوای close، economicsی ئەو ماوەیە ناگۆڕدرێت؛ correction/reversal لە ماوەی ئێستا تۆمار دەبێت.

### ٥. Maker/checker و audit

- command ـە دارایییەکان idempotentن؛ lost response نابێتە هۆی duplicate write.
- threshold، expiry، maker≠checker، owner override، maintenance freeze و AAL2/MFA زیاد/یەکخراون.
- expiry، rejection، failure و override failure وەک event دەمێنن؛ بە exception rollback نابن.
- audit table append-only ـە و browser direct insertی نییە. export و action ـەکان RPCی audited بەکاردهێنن.

### ٦. Receipt/OCR/forwarding

- original file پێش OCR بە storageی پارێزراو دەبەسترێت؛ browser ناتوانێت OCR JSON، party، flow یان currencyی پارێزراو بسەپێنێت.
- receipt decision، correction، acceptance و finalization command ـی جیاواز و auditedن؛ هیچ receiptێک بە نهێنی transaction دروست/دەستکاری ناکات.
- Type A receipt پێویستی بە recipient، date، WeChat/Alipay، fee status و exact custody partner هەیە.
- forwarding recipient لە assignment/transactionی server دەردەهێنرێت، نەک لە هەڵبژاردنی browser.
- legacy recovery پێشتر دەتوانی partial batch بسڕێتەوە. ئێستا resumable ـە، exact immutable IDs دەپشکنێت و تەنها missing row زیاد دەکات.
- office payment پێویستی بە immutable evidence هەیە؛ office تەنها report دەکات و admin full payment پشتڕاست دەکات.

### ٧. RLS و مافی ڕۆڵەکان

- policy ـە کۆنەکان officeیان وەک generic staff دەناسێناند و بەهۆی OR-compositionی PostgreSQL دەتوانی هەموو transaction، ledger، debt و raw receipt evidence ببینێت.
- office ئێستا تەنها assignment/transactionی پەیوەست بە خۆی دەبینێت؛ partner/customer/investor تەنها rowی خۆیان دەبینن.
- raw bank/OCR evidence، journalی گشتی، audit و aggregate view ـە هەستیارەکان admin-only یان guarded RPC ـن.
- counterparty name وەک snapshot لە transaction دەمێنێت تا partner/office ناوی پەیوەندیدار ببینێت، بەبێ دەستگەیشتن بە phone/address/internal noteی `app_users`.
- Supabase advisor دۆزییەوە 17 `SECURITY DEFINER` function بە defaultی PostgreSQL لە `anon/PUBLIC` ـەوە callable بوون. migrationی `202608180005_security_definer_acl_hardening.sql` هەمووی داخستن، تەنها identity helper ـە پێویستەکانی RLS بۆ `authenticated` هێشتنەوە و default privilegeی function ـە داهاتووەکانی داخست.

## تاقیکردنەوەی ئەنجامدراو

- `node --test`: 338 PASS، 0 FAIL، 0 SKIP.
- PostgreSQL 16.14 clean install: 30 migrationی سەرەکی PASS؛ migrationی ACL ـی 31 ـەم لە remote PostgreSQL 17.6 بە transaction جێبەجێ و بە catalog/advisor verify کرا.
- accounting/database contracts: 130 PASS، 0 FAIL، 0 SKIP؛ A/B/C، double-entry، debt، cashbox، partner، office، receipt/OCR، day-close، reconciliation و RLS لەخۆدەگرێت.
- browser role E2E لە Chromiumی ڕاستەقینە: 57 PASS، 0 FAIL؛ MFA gate، ڕێگریی surface ـە قەدەغەکراوەکان، accessibility، keyboard focus و uncaught error لەخۆدەگرێت.
- production build: 1603 module؛ build سەرکەوتوو؛ main bundle 478.27 kB / gzip 123.50 kB.
- production bundle contract: 16 JavaScript chunk PASS.
- source/migration contract: 184 فایل و 31 migration PASS.
- `npm audit --audit-level=high`: 0 vulnerability.
- brand، PWA share، global search و diff/whitespace checks هەموویان PASS.

## ئەنجامی test remote و ئەو کارانەی هێشتا ماون

- test projectی `bank` بە project refی `ohnwrnsyqiobxskerttc` دیاری و پێش reset دووبارە پشتڕاست کرایەوە. تەنها application schemaی `public` reset کرا؛ schema ـە managed ـەکانی Auth/Storage دەستکاری نەکران.
- 31/31 migration بە ڕیز push کران و remote migration history بە version/nameی فایلەکانی repo یەکسان کرایەوە (`202608090001` تا `202608180005`).
- remote schema ئێستا 56 table هەیە و RLS لە هەموو 56 ـەکە چالاکە؛ 10 view، 156 function، 73 policy، 20 chart account و سێ دراوی USD/IQD/CNY دروست بوون.
- ownerی `sarkhel` بە هەمان `auth_id`ی پێشوو و `admin_level=owner` گەڕێندرایەوە. authenticated+AAL2 smoke test، `sarraf_runtime_contract()`، trial balance و subledger reconciliation هەموویان PASS بوون.
- bucketی privateی `receipts` و 85 objectی پێشوو پارێزران؛ row ـەکانی application database reset بوون، بۆیە ئەو objectانە دەتوانن orphanی test بن و دواتر بە Storage API پاک بکرێن.
- security advisor دوای hardening: `anon/PUBLIC` ـەوە callable `SECURITY DEFINER` = 0. 10 INFOی table ـە command/control ـە بێ policy بە مەبەست privateن. 81 WARNی authenticated `SECURITY DEFINER` command ماون چونکە command ـە exposed ـەکان بە مەبەست authenticatedن و authorization/MFA لە ناو function دەپشکنن. `Leaked password protection` هێشتا لە Auth dashboard چالاک نەکراوە.
- performance advisor لە databaseی تازەدا 88 INFOی unindexed foreign key، 70 INFOی unused index، 3 WARNی RLS init-plan و 19 WARNی permissive-policy overlap دەدات. unused index لە databaseی بێ workload بەڵگەی سڕینەوە نییە؛ FK/RLS warning ـەکان پێش production بە query plan و workloadی staging دەبێت ڕیزبەندی و چاک بکرێن.
- `.env.local`ی gitignored بە URL و publishable keyی test project دانرا. server-side OCR/receipt route ـەکان لە deployment هێشتا `SUPABASE_SERVICE_ROLE_KEY` و provider keyی ڕاستەقینەیان پێویستە.
- هیچ production project/dataیەک دەستکاری نەکراوە. dependency auditی پێشوو 0 vulnerability بوو؛ CI دەبێت هەر release ـێکدا دووبارەی بکاتەوە.

## شتە کۆن/زیادەکان کە بە مەبەست نەسڕاونەتەوە

ئەم شتانە پێش سڕینەوە پێویستیان بە پەسەندی خاوەن و data-reconciliation هەیە:

- دوو surfaceی receipt: `receipts/receipt_batches/receipt_intake_items` و canonical `receipt_documents/receipt_extractions`؛ هەردووکیان هێشتا بۆ compatibility و migrationی داتای کۆن بەکاردێن.
- operational `ledger/account_ledger` و double-entry `journal_entries/journal_lines`؛ ئێستا reconciliation نێوانیان هەیە و هیچکامیان هێشتا redundantی سەلمێنراو نییە.
- parameter ـە legacy ـەکانی `p_ledger` و `p_history` لە هەندێ RPC؛ بۆ API compatibility هێڵدراونەتەوە، بەڵام server پشت بە داتای داراییی browser نابەستێت.
- fallbackی full-history لە frontend؛ بۆ continuity هێڵدراوەتەوە تا bounded read model بە تەواوی لە production بسەلمێت.
- `supabase_schema.sql`؛ نەسڕاوەتەوە، بەڵکو guard کراوە بۆ ڕێگری لە دامەزراندنی هەڵە.

## قەرزی تەکنیکیی ناسراو، نەک release blocker

- `App.jsx` هێشتا monolithێکی گەورەی legacy ـە. بەشە گەورەکان lazy-load کراون، بەڵام دابەشکردنی تەواوی فایل پڕۆژەی refactorێکی جیاوازە و لە stabilizationی 7 ڕۆژەدا مەترسی regressionی بەرز هەیە.
- admin bootstrap هێشتا full RLS-visible history دەخوێنێتەوە بۆ fallbackی دروستی. بۆ داتای زۆر گەورە، دوای سەلماندنی read model لە production دەبێت dashboard/report ـەکان بە تەواوی cursor/RPC-based بکرێن.
- migration ناتوانێت بە بێ پشکنین gapی داتای کۆنی production حدس بزند. `sarraf_reconciliation_report()` و auditی staging دەبێت هەر gapێک دیاری بکەن؛ correction تەنها بە reversal/explicit repair migration.

## کارەکانی خاوەن پێش فرۆشتن/deploy

1. backupی database و Storage بگرە و production restore بکە بۆ staging.
2. migration dry-run و پاشان push تەنها لە staging بکە؛ `GUIDE.md` بە وردی شوێن بکەوە.
3. CIی strict بە `ZEMAN_DB_STRICT=1` و `ZEMAN_E2E_STRICT=1` سەوز بکە؛ Playwright، Chromium و Supabase CLI ئێستا لە lockfile ـدا pinned ـن و هیچ SKIPێک قبووڵ مەکە.
4. دوو adminی جیاواز بۆ maker/checker دروست بکە، MFAیان چالاک بکە و threshold/timezone دیاری بکە.
5. environment variable/OCR key ـە ڕاستەقینەکان دابنێ و smoke testی A/B/C، receipt، office settlement، reversal و day close بکە.
6. `sarraf_reconciliation_report()`، `sarraf_runtime_contract()` و `sarraf_system_health()` دەبێت PASS/healthy بن پێش deploy.
7. تەنها دوای customer acceptance لە staging، backupێکی نوێ بگرە و production releaseی ڕیزبەندکراوی `GUIDE.md` جێبەجێ بکە.
