#!/bin/zsh

PROJECT_DIR="/Users/zhongxin/Desktop/study2"
PORT="3020"
URL="http://127.0.0.1:${PORT}/start"

echo "=============================================="
echo "  Study 2 价值表征与资源决策实验"
echo "=============================================="
echo

if [[ ! -f "$PROJECT_DIR/server.mjs" ]]; then
  echo "找不到 Study 2 实验程序：$PROJECT_DIR"
  echo "请确认 study2 文件夹仍在桌面。"
  echo "按回车键关闭窗口…"
  read
  exit 1
fi

export PATH="/opt/anaconda3/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if ! command -v node >/dev/null 2>&1; then
  CODEX_NODE="/Users/zhongxin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  if [[ -x "$CODEX_NODE" ]]; then
    NODE_BIN="$CODEX_NODE"
  else
    echo "找不到 Node.js，无法启动实验。"
    echo "请保留此窗口并联系维护者。"
    echo "按回车键关闭窗口…"
    read
    exit 1
  fi
else
  NODE_BIN="$(command -v node)"
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已被其他程序使用。"
  echo "如果 Study 2 已经启动，可直接访问：http://127.0.0.1:${PORT}"
  echo "按回车键关闭窗口…"
  read
  exit 1
fi

export PORT="$PORT"
export HOST="127.0.0.1"
export PARTICIPANT_ENTRY_PASSWORD="Zx123456"
export RESEARCHER_PASSWORD="Zx123456"
export AUTH_SECRET="$(openssl rand -hex 32)"

cd "$PROJECT_DIR" || exit 1

echo "正在启动实验，稍后会自动打开浏览器…"
echo "被试入口密码：Zx123456"
echo "研究者密码：Zx123456"
echo
echo "请保持此终端窗口打开。"
echo "实验结束后，在此窗口按 Ctrl+C 即可停止。"
echo

(
  sleep 1.5
  open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"
) &
OPENER_PID=$!

trap 'kill "$OPENER_PID" >/dev/null 2>&1' EXIT INT TERM
"$NODE_BIN" server.mjs
EXIT_CODE=$?

if [[ $EXIT_CODE -ne 0 ]]; then
  echo
  echo "启动失败，请保留窗口中的提示并联系维护者。"
  echo "按回车键关闭窗口…"
  read
fi

exit $EXIT_CODE
