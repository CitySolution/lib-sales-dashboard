"""Independent check of the dashboard's maths, straight from TikTok income exports.

usage: python3 -I reference/reference.py export1.xlsx [export2.xlsx ...] > ref.json

Takes each statement once (first file wins), and prints per SKU: units sold,
refunded, net revenue ex VAT, TikTok fees; plus shop-level items by type and total
settlement. The JS (site/js/tiktok.js + pnl.js) must give the same numbers.
"""
import json, sys
from collections import defaultdict
import openpyxl

REVENUE = ['Gross sales', 'Gross sales refund', 'Seller discount', 'Seller discount refund',
           'Customer-paid shipping fee', 'Customer-paid shipping fee refund']

def num(v):
    if v in (None, '', '/'):
        return 0.0
    return float(str(v).replace(',', '').replace('£', ''))

seen = set()
box = defaultdict(lambda: defaultdict(float))
shop = defaultdict(float)
settlement = 0.0
for path in sys.argv[1:]:
    ws = openpyxl.load_workbook(path, read_only=True, data_only=True)['Order details']
    ws.reset_dimensions()
    rows = ws.iter_rows(values_only=True)
    hdr = [str(h).strip() if h is not None else '' for h in next(rows)]
    ix = {}
    for i, h in enumerate(hdr):
        ix.setdefault(h, i)
    here = set()
    for r in rows:
        sid = str(r[ix['Statement ID']] or '').strip()
        if not sid or sid in seen:
            continue
        here.add(sid)
        settle = num(r[ix['Total settlement amount']])
        settlement += settle
        if r[ix['Type']] == 'Order':
            b = box[str(r[ix['SKU ID']])]
            q = num(r[ix['Quantity']])
            if num(r[ix['Gross sales']]) > 0: b['u'] += q
            if num(r[ix['Gross sales refund']]) < 0: b['r'] += q
            rev_inc = sum(num(r[ix[c]]) for c in REVENUE)
            b['rev'] += rev_inc / 1.2
            # Fees are everything else in the settlement (orders have no adjustments).
            b['fees'] += settle - rev_inc
        else:
            shop[r[ix['Type']]] += num(r[ix['Adjustment amount']])
    seen |= here

r2 = lambda x: round(x, 2)
print(json.dumps({
    'statements': len(seen),
    'settlement': r2(settlement),
    'boxes': {k: {kk: r2(vv) for kk, vv in v.items()} for k, v in sorted(box.items())},
    'shop': {k: r2(v) for k, v in sorted(shop.items())},
}, indent=1))
