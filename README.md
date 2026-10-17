# Latest in Beauty — sales dashboard

How profitable each box is that Latest in Beauty (LiB) sells, built from TikTok Shop
settlement exports (Shopify to follow). Hosted on Cloudflare Pages behind Cloudflare
Access: only **@citysolution.co.uk** and **@latestinbeauty.com** email addresses can
sign in. Setup: **[SETUP.md](SETUP.md)**.

- **Summary** — the headline for any period: net profit after all costs, net revenue
  (ex VAT), boxes sold, profit per box, TikTok fees, cost of goods, month by month,
  the best boxes, and a profit and loss.
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
| Cost of goods | net boxes × £ per box for each cost line, + commission % × net revenue |
| Gross profit | net revenue + TikTok fees + cost of goods |
| Net profit | gross profit − marketing (net boxes × £ per box) |

- **Net boxes** = boxes sold − boxes refunded. An order cancelled before settling
  appears as a sale and a refund in the same statement, so it nets to zero.
- **Dates** are order dates, so a refund lands in the month the box was sold.
- **Shop-level items** (FBT warehouse fees, logistics and TikTok reimbursements,
  chargebacks) aren't tied to a box; they're added in the Summary to reach "net profit
  after all costs". **Bill payments** (LiB topping up a negative TikTok balance) are
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
| `functions/api/seed.js`, `functions/_lib/seed.json` | One-off: the TikTok exports supplied when the dashboard was built (1 Jan – 11 Oct 2026), loaded with the button on the Uploads tab. Empty `seed.json` (to `[]`) once loaded. |
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

## Adding Shopify later

Stored rows already carry a channel (`ch: 'tiktok'`), and costs are per box, so
Shopify needs a reader for its export, a way to match Shopify products to the TikTok
SKU IDs, and a channel filter on the page.
