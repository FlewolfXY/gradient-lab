#!/bin/zsh
# 一键启动演示：音乐解剖台 (5199) + 画布召唤台 (5200)
# 用法：双击或在终端跑 ./start_demo.sh —— 全程本地，不需要会场网络

cd "$(dirname "$0")"

if ! lsof -i :5199 >/dev/null 2>&1; then
  (cd audio-xray && ./.venv/bin/python app.py > /tmp/audio-xray.log 2>&1 &)
  echo "解剖台启动中 (5199)…"
else
  echo "解剖台已在运行 (5199)"
fi

if ! lsof -i :5200 >/dev/null 2>&1; then
  (cd paint-to-midi && ./.venv/bin/python web.py > /tmp/paint-web.log 2>&1 &)
  echo "召唤台启动中 (5200)…"
else
  echo "召唤台已在运行 (5200)"
fi

sleep 2
open "http://127.0.0.1:5200"   # 召唤台先开（demo 主角）
open "http://127.0.0.1:5199"
echo "两个页面已打开。祝明天顺利。"
