# Latest in Beauty — sales dashboard

How profitable each box is that Latest in Beauty (LiB) sells, built from TikTok Shop
settlement exports and Shopify's sales report. Hosted on Cloudflare Pages behind Cloudflare
Access: only **@citysolution.co.uk** and **@latestinbeauty.com** email addresses can
sign in. Setup: **[SETUP.md](SETUP.md)**.

- **Summary** — the headline for any period: net profit after all costs, net revenue
  (ex VAT), boxes sold, profit per box, TikTok fees, cost of goods, month by month,
  the best boxes, and a profit and loss.
- **Attention** — what looks like it needs looking at, with a count on the tab: upload
  overdue (latest statement over 7 days old), gaps in the statements, refunds whose sales
  aren't loaded, and for the period chosen: boxes with no costs (biggest first), losing
  money, margin under 10%, or 10%+ refunded (20+ sold). Limits are in `site/js/checks.js`.
  Admins can hide an item that's fine as it is, for a week, a month or for good
  (`functions/api/dismiss.js`); hidden items are listed at the bottom with Show again.
- **Boxes** — every box with its full profit and loss (the same lines as the original
  spreadsheet), tracked by **TikTok SKU ID**, so a renamed box keeps its history.
- **Costs** — the costs TikTok doesn't know about, per box: brand contributions,
  pallet/FBT delivery, packaging, fulfilment labour, other COGS and marketing (£ per
  box) and commission (% of net revenue). Dated, so a change doesn't rewrite past months.
- **Uploads** — admins add the latest TikTok export. Only statements not already
  loaded are added, so exports can overlap and nobody needs to download from 1 January
  each time.

## How the numbers work

All money in the TikTok export is VAT-inclusive. Per box (`site/js/pnl.js`):

| Line | How |
|---|---|
| Net revenue (ex VAT) | (gross sales + refunds + seller discounts + their refunds + customer-paid shipping and its refunds) ÷ 1.2 |
| TikTok fees | every other TikTok shipping and fee column, as shown by TikTok |
| Other TikTok items | reimbursements and chargebacks on the box's orders (split by gross sales when an order has several boxes), and the box's share of the FBT warehouse fee: each month's fee split across that month's boxes sold |
| Cost of goods | net boxes × £ per box for each cost line, + commission % × net revenue |
| Gross profit | net revenue + TikTok fees + other TikTok items + cost of goods |
| Net profit | gross profit − marketing (net boxes × £ per box) |

- **Net boxes** = boxes sold − boxes refunded. An order cancelled before settling
  appears as a sale and a refund in the same statement, so it nets to zero.
- **Dates** are order dates, so a refund lands in the month the box was sold.
- **Shop-level items** are what can't go to a box: a reimbursement or chargeback whose
  order isn't in the uploaded file (export with a few weeks' overlap so late ones find
  their order), and warehouse fees in a month with no sales. They're added in the
  Summary to reach "net profit after all costs". **Bill payments** (LiB topping up a negative TikTok balance) are
  money moving, not income or a cost, and are left out.
- Boxes with no costs entered are flagged, because their profit is overstated.

**Checks on every upload** (`site/js/tiktok.js`): every row must satisfy
settlement = net sales + shipping + fees + adjustments, with each of those equal to the
sum of its columns, and each statement's rows must add up to the total on the export's
*Statements* sheet. If TikTok adds a column or a file is incomplete, the upload is
refused instead of quietly losing money. The *Uploads* tab shows the total settlement
loaded, which matches TikTok's statements.

## How it fits together

| Piece | What it does |
|---|---|
| `site/js/tiktok.js` | Reads the TikTok income export (via SheetJS, `site/vendor/`) in the admin's browser into per-statement totals per day and box. The raw file never leaves the browser - no customer details are uploaded. |
| `site/js/pnl.js` | Merging new statements into what's stored, and the profit and loss. Shared by the page, the server and the tests. |
| `site/js/app.js`, `site/index.html`, `site/css/app.css` | The page. Brand colours are at the top of `app.css`; the logo is `site/img/logo.svg`. |
| `functions/_lib/auth.js` | Verifies the Cloudflare Access sign-in (JWT signature, audience, issuer) and that the email is on one of the two domains. |
| `functions/_lib/users.json` | Admins (can upload and edit costs). Everyone else on the two domains can view. |
| `functions/api/me.js` | The figures and costs, for anyone signed in. |
| `functions/api/upload.js`, `functions/_lib/store.js` | Admins only. Stores the statements not already stored as a new batch in KV; the browser adds the batches together (`assemble()` in `pnl.js`), so the server's work per upload stays small enough for Cloudflare's free plan. |
| `functions/api/seed.js`, `functions/_lib/seed.json`, `seed-costs.json` | One-off: the TikTok exports supplied when the dashboard was built (1 Jan – 11 Oct 2026) and the box costs from the original Finance Dashboard spreadsheet, loaded with the button on the Uploads tab (costs only for boxes with none yet). Empty both files (`[]` / `{}`) once loaded. |
| `functions/api/costs.js` | Admins only. Sets one box's dated costs; every change is logged. |
| `reference/reference.py` | The sums in Python straight from the Excel files, as an independent check. |
| `test/` | `data.test.mjs` (reader and P&L against hand-worked figures), `api.test.mjs` (sign-in, domains, admin-only changes, no double counting). Both run before every deploy. |

## Running it locally

```bash
npm ci
npm test
node test/preview.mjs path/to/income.xlsx ...   # http://localhost:8788, signed in as a test admin
# Check real exports against the Python reference (needs python3 + openpyxl):
python3 -I reference/reference.py a.xlsx b.xlsx > ref.json && node test/real.test.mjs ref.json a.xlsx b.xlsx
```

Never commit a real export: `.gitignore` blocks `*.xlsx`, `*.xls` and `*.csv`.

## Shopify

Uploaded on the Uploads tab: Shopify's **Copy of Total sales by product variant** report
(Analytics → Reports, LiB's saved copy with a Month or Day column), as CSV. Read by
`site/js/shopify.js`; stored by `functions/api/shopify.js` one month per KV value
(`shopify:YYYY-MM`, indexed in `shopify`). The report has no statement IDs, so **each
upload replaces the months it contains**; the upload warns when a month would be partial.

- Only boxes are kept: SKUs starting `LIB_COLL`, or any row with sales. Their £0 contents,
  free gifts, and sales with no product (gift cards, custom items) are left out.
- Shopify's figures are ex VAT; they're grossed up at 20% into the same incl-VAT columns as
  TikTok's, so net revenue comes out as Shopify's net sales.
- Monthly figures are dated the 1st of the month and have no first/last sale dates.
- **Box matching** (`skumap` in KV, `functions/api/skumap.js`): which TikTok box each Shopify
  box is. Matched boxes count as one box with one set of costs; an unmatched one is a box of
  its own, `shopify:<SKU>`, with its own costs. Matches are applied in the browser, so
  changing one needs no re-upload.
- The **Channel** filter shows TikTok, Shopify or both. TikTok's FBT warehouse fee is only
  shared across TikTok boxes.
- Shopify's fees aren't in this report; they'd come from the payouts export.
