#!/usr/bin/env bash
# <xbar.title>rocket-snake</xbar.title>
# <xbar.desc>Start, stop and watch the rocket-snake backend.</xbar.desc>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>

RSCTL="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)/rsctl"
PORT="${RS_PORT:-8787}"
STATS="$(curl -s -m 2 -H "X-Rocket-Snake: 1" "http://127.0.0.1:$PORT/stats")"

if [[ -n "$STATS" ]]; then
  echo "| sfimage=sparkles"
  echo "---"
  /usr/bin/python3 - "$STATS" <<'PY'
import json, sys
s = json.loads(sys.argv[1])
t, w = s["today"], s["week"]
print(f"Serveur v{s['server_version']} en marche · Onyx {'on' if s['onyx_enabled'] else 'off'}")
print(f"Aujourd'hui : {t['calls']} appels · ${t['cost_usd']:.2f} / ${s['daily_budget_usd']}")
print(f"7 jours : {w['calls']} appels · ${w['cost_usd']:.2f}")
PY
  echo "---"
  echo "Redémarrer | bash=$RSCTL param1=restart terminal=false refresh=true"
  echo "Arrêter | bash=$RSCTL param1=stop terminal=false refresh=true"
else
  echo "| sfimage=sparkles sfcolor=#8e8e93"
  echo "---"
  echo "Serveur arrêté"
  echo "---"
  echo "Démarrer | bash=$RSCTL param1=start terminal=false refresh=true"
fi
echo "---"
echo "Installer / mettre à jour le userscript | href=http://127.0.0.1:$PORT/rocket-snake.user.js"
echo "Ouvrir les logs | bash=/usr/bin/open param1=$HOME/Library/Logs/rocket-snake.log terminal=false"
