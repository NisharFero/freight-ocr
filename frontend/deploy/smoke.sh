#!/usr/bin/env bash
# Post-deploy smoke test: health, auth enforced, one real extraction, metrics.
#   bash frontend/deploy/smoke.sh https://freight-ocr.local alice 'password' "/path/BCJNBNAV01189.pdf"
set -u
URL=${1:-http://127.0.0.1:3000}; U=${2:-}; P=${3:-}; FILE=${4:-}
K="-sk"; fail=0
ok() { echo "PASS  $1"; }; bad() { echo "FAIL  $1"; fail=1; }

h=$(curl $K "$URL/api/health"); echo "$h" | grep -q '"ok":true' && ok "health $h" || bad "health: $h"
echo "$h" | grep -q '"shadowMode":true' && ok "shadow mode on" || echo "WARN  shadow mode is OFF (only after gate G1)"
c=$(curl $K -o /dev/null -w '%{http_code}' "$URL/api/metrics"); [ "$c" = 401 ] && ok "no credentials -> 401" || bad "no credentials -> $c (expected 401)"
c=$(curl $K -o /dev/null -w '%{http_code}' -u "$U:wrong-password" "$URL/api/metrics"); [ "$c" = 401 ] && ok "wrong password -> 401" || bad "wrong password -> $c"
c=$(curl $K -o /dev/null -w '%{http_code}' -u "$U:$P" "$URL/"); [ "$c" = 200 ] && ok "UI reachable with credentials" || bad "UI -> $c"
if [ -n "$FILE" ]; then
  t0=$(date +%s)
  r=$(curl $K -u "$U:$P" -F "file=@$FILE" "$URL/api/extract")
  echo "$r" | grep -q '"docType"' && ok "extract $(basename "$FILE") in $(( $(date +%s) - t0 ))s: $(echo "$r" | grep -o '"docType":"[A-Z_]*"' | head -1)" || bad "extract: ${r:0:200}"
fi
m=$(curl $K -u "$U:$P" "$URL/api/metrics?days=1"); echo "$m" | grep -q '"window"' && ok "metrics: $(echo "$m" | grep -o '"extractions":[0-9]*')" || bad "metrics: ${m:0:200}"
exit $fail
