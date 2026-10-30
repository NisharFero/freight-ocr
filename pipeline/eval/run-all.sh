#!/usr/bin/env bash
# Full pre-release evaluation: unit tests, golden set, cold start, perturbation suite, public held-out sets, gate.
# Usage: bash eval/run-all.sh <samples-root> [heldout-real-root] [heldout-gen-root]
set -u
SAMPLES=${1:-samples}; REAL=${2:-}; GEN=${3:-}
TSX="node node_modules/tsx/dist/cli.mjs"
mkdir -p out
$TSX --test tests/*.test.ts > out/unit.log 2>&1 || { echo "unit tests failed (out/unit.log)"; exit 1; }
echo "[1/5] golden set";  rm -rf out/json;    OUT=out/json $TSX scripts/run.ts "$SAMPLES" > out/dev.log 2>&1
echo "[2/5] cold start";  rm -rf out/cold;    EVAL_COLD_START=1 OUT=out/cold $TSX scripts/run.ts "$SAMPLES" > out/cold.log 2>&1
echo "[3/5] perturbation"; rm -rf out/perturb; $TSX eval/perturb.ts "$SAMPLES" scan150,dpi100,rot90,rot180,rot270,skew3,photo,dup,merged > out/perturb.log 2>&1
if [ -n "$REAL" ]; then echo "[4/5] held-out real"; rm -rf out/held_real; OUT=out/held_real $TSX scripts/run.ts "$REAL" > out/held_real.log 2>&1; fi
if [ -n "$GEN" ];  then echo "[4/5] held-out gen";  rm -rf out/held_gen;  OUT=out/held_gen  $TSX scripts/run.ts "$GEN"  > out/held_gen.log 2>&1; fi
echo "[5/5] gate"; $TSX eval/gate.ts
