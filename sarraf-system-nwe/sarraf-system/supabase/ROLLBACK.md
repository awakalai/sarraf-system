# گەڕانەوە لە مایگرەیشنەکان

**بنەڕەتی گرنگ:** هیچ مایگرەیشنێکی ئەم بەرنامەیە **داتا ناسڕێتەوە**. هەموو ستوونە کۆنەکان لە جێی خۆیان ماونەتەوە — تەنانەت `buy_rate` و `sell_rate` ـیش کە چیتر ناخوێندرێنەوە. واتا گەڕانەوە هەمیشە شیاوە بەبێ ونبوونی هیچ ژمارەیەکی دارایی.

بەڵام گەڕانەوە **بەبێ پلان** مەکە. ئەم فایلە دەڵێت بۆ هەر مایگرەیشنێک چی دەکرێت و چی نا.

---

## پێش هەر گەڕانەوەیەک

```sql
-- ١. باکئەپ بگرە. ئەمە دانەبڕاوە.
-- ٢. بزانە چ فەرمانێک لەم مایگرەیشنەوە بەکارهاتووە:
select operation, count(*), max(created_at)
from public.accounting_commands group by operation order by 3 desc;
```

ئەگەر فەرمانێکی نوێ **بەکارهاتبێت**، گەڕانەوە داتای دروستکراوی بەجێدەهێڵێت کە کۆدی کۆن نایناسێتەوە. ئەوە خراپ نییە — تەنها بزانە.

---

## بەپێی مایگرەیشن

### `202608140001_single_currency_ratio.sql` — یەک ڕەیتیۆ

| | |
|---|---|
| زیادی کرد | `currencies.rate`, `rate_history.rate` |
| نەیسڕییەوە | `buy_rate`, `sell_rate` — بە تەواوی ماون |
| گەڕانەوە | `sarraf_save_rates` و `sarraf_usd_value` ی کۆن دووبارە دروست بکەوە. ستوونی `rate` بەجێبهێڵە. |

⚠️ گەڕانەوە دەگەڕێتەوە بۆ سپرێدی کڕین/فرۆشتن — ئەو کێشەیەی فەیسی ٢ چاریسەری کرد.

### `202608140002_receipt_conversion_moves_money.sql` — مامەڵەی ڕاستەقینە

| | |
|---|---|
| زیادی کرد | فەنکشن و تریگەری `sarraf_assert_total_matches_rate` |
| گەڕانەوە | `drop trigger txs_total_matches_rate on public.txs;` |

⚠️ لادانی ئەم تریگەرە ڕێگە دەدات بە مامەڵەی `total ≠ amount × rate`.

### `202608150001_uploader_receipt_view.sql` — دیدی نێرەر

| | |
|---|---|
| زیادی کرد | `receipts.merchant_order_no` نا — تەنها فەنکشن و تریگەر |
| گەڕانەوە | `drop trigger receipt_batches_direction_guard on public.receipt_batches;`<br>`drop trigger receipts_direction_guard on public.receipts;`<br>`sarraf_portal_receipt_summary` ی کۆن دووبارە دروست بکەوە |

### `202608160001_canonical_batch_summary.sql` — یەک کۆکانە

| | |
|---|---|
| گەڕانەوە | `sarraf_finalize_receipt_batch` بە ٤ پارامیتەر دووبارە دروست بکەوە (لە `202608100006`) |

⚠️ ڕووکاری نوێ بە ٥ پارامیتەر بانگی دەکات. **کۆد و داتابەیس پێکەوە بگەڕێنەوە.**

### `202608170001_debt_register.sql` — پسووڵە و قەرز

| | |
|---|---|
| زیادی کرد | `vouchers`, `voucher_counters`, `debt_events` + فەرمانەکان |
| گەڕانەوە | خشتەکان **مەسڕەوە**. تەنها تریگەرەکان لابە:<br>`drop trigger debts_opened_recorded on public.debts;`<br>`drop trigger debt_settlements_recorded on public.debt_settlements;` |

⚠️ سڕینەوەی `vouchers` مێژووی پسووڵە دەسڕێتەوە. §1.3 ڕێگە نادات.

### `202608180001` / `202608180002` — دووبارە و واژۆ

| | |
|---|---|
| گەڕانەوە | `drop trigger receipts_verify_attestation on public.receipts;`<br>`drop trigger receipts_fill_merchant_order on public.receipts;`<br>`check_receipt_dupe(text,text)` ی کۆن دووبارە دروست بکەوە |

⚠️ ڕووکاری نوێ `check_receipt_dupe` بە ٧ پارامیتەر بانگ دەکات. پێکەوە بگەڕێنەوە.

### `202608180003_rate_limit_and_pending.sql` — سنوور و `pending`

| | |
|---|---|
| گەڕانەوە | `alter table public.customer_vaults drop column pending;` |

⚠️ ئەگەر `pending > 0` هەبێت، ئەو پارەیە **ون دەبێت**. سەرەتا پشکنینی بکە:
```sql
select * from public.customer_vaults where pending > 0;
```

### `202608190001_office_payment_confirmation.sql`

| | |
|---|---|
| گەڕانەوە | `drop function public.sarraf_office_payment_confirm(text,text,text);` |

دیاریکراوە `confirmed` ـەکان بەو دۆخەوە دەمێننەوە. زیانی نییە.

### `202608200001_vouchers_and_reports.sql` — پسووڵە بۆ هەموویان

| | |
|---|---|
| گەڕانەوە | `drop trigger journal_entry_voucher on public.journal_entries;`<br>`drop trigger journal_entry_voucher_on_post on public.journal_entries;` |

پسووڵەی دەرچوو دەمێنێتەوە. ئەوە دروستە — پسووڵە هەرگیز ناسڕدرێتەوە.

### `202608210001_states_pending_and_overdue.sql` — دۆخەکان

⚠️ **بەهای enum لە PostgreSQL لانابرێت.** `approved`, `settled`, `voided` بۆ هەمیشە دەمێننەوە.

| | |
|---|---|
| گەڕانەوە | `drop trigger journal_status_transitions on public.journal_entries;`<br>`protect_posted_journal` ی کۆن دووبارە دروست بکەوە |

سەرەتا پشکنینی بکە کە هیچ تۆمارێک لە دۆخە نوێیەکاندا نەبێت:
```sql
select status, count(*) from public.journal_entries
where status in ('approved','settled','voided') group by status;
```

### `202608220001_partner_pending.sql`

| | |
|---|---|
| گەڕانەوە | `drop function public.sarraf_partner_pending_credit(text,text,numeric,text,text);`<br>`drop function public.sarraf_partner_pending_resolve(text,text,numeric,boolean,numeric,text,text);` |

⚠️ پشکنینی `partner_accounts.pending > 0` بکە پێش لابردنی ستوونەکە.

---

## دوای هەر گەڕانەوەیەک

```bash
npm run verify:accounting   # سکیما هێشتا لە هیچەوە دروست دەبێت؟
npm run verify:flows        # ڕۆژێکی کار هێشتا تەواو دەبێت؟
```

ئەگەر یەکێکیان شکستی هێنا، **گەڕانەوەکە تەواو نەبووە**.
